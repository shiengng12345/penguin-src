import { createHash } from "node:crypto";

export type ResolutionProviderKind =
  | "parser_local_exact"
  | "project_type"
  | "configured_lsp"
  | "framework_adapter"
  | "heuristic";

const PROVIDER_PRIORITY: Record<ResolutionProviderKind, number> = {
  parser_local_exact: 0,
  project_type: 1,
  configured_lsp: 2,
  framework_adapter: 3,
  heuristic: 4,
};

export interface ResolutionRequest {
  language: string;
  symbol: string;
  filePath?: string;
  contextFingerprint: string;
  parserConfigHash: string;
  signal?: AbortSignal;
}

export interface ResolutionTarget {
  identityKey: string;
  filePath?: string;
  startLine?: number;
}

export interface ResolutionResult {
  status: "verified" | "candidate" | "unavailable";
  providerId: string;
  providerKind: ResolutionProviderKind;
  targets: ResolutionTarget[];
  explanation: string;
  contextFingerprint: string;
  parserConfigHash: string;
  providerConfigHash: string;
}

export interface ResolutionProvider {
  id: string;
  kind: ResolutionProviderKind;
  /** Hash of the provider binary/config/model/LSP workspace settings. */
  configHash: string;
  supports(language: string): boolean;
  resolve(request: ResolutionRequest): Promise<ResolutionResult>;
}

export interface ResolutionProviderChainOptions {
  timeoutMs?: number;
}

function requestHash(request: ResolutionRequest): string {
  return createHash("sha256").update(JSON.stringify({
    language: request.language,
    symbol: request.symbol,
    filePath: request.filePath ?? null,
    contextFingerprint: request.contextFingerprint,
    parserConfigHash: request.parserConfigHash,
  })).digest("hex");
}

function unavailable(request: ResolutionRequest, provider: ResolutionProvider, explanation: string): ResolutionResult {
  return {
    status: "unavailable",
    providerId: provider.id,
    providerKind: provider.kind,
    targets: [],
    explanation,
    contextFingerprint: request.contextFingerprint,
    parserConfigHash: request.parserConfigHash,
    providerConfigHash: provider.configHash,
  };
}

/**
 * Ordered resolution boundary. Exact parser resolution can run synchronously
 * from the indexer's point of view; optional LSP/framework providers are
 * bounded and may report unavailable without stopping source ingestion.
 */
export class ResolutionProviderChain {
  private readonly providers: ResolutionProvider[] = [];
  private readonly cache = new Map<string, ResolutionResult>();

  constructor(private readonly options: ResolutionProviderChainOptions = {}) {}

  register(provider: ResolutionProvider): void {
    this.providers.push(provider);
    this.providers.sort((a, b) => PROVIDER_PRIORITY[a.kind] - PROVIDER_PRIORITY[b.kind] || a.id.localeCompare(b.id));
    this.invalidateProvider(provider.id);
  }

  list(): Array<{ id: string; kind: ResolutionProviderKind; configHash: string }> {
    return this.providers.map(({ id, kind, configHash }) => ({ id, kind, configHash }));
  }

  invalidateProvider(providerId?: string): void {
    if (!providerId) {
      this.cache.clear();
      return;
    }
    for (const [key, value] of this.cache) if (value.providerId === providerId) this.cache.delete(key);
  }

  async resolve(request: ResolutionRequest): Promise<ResolutionResult> {
    const key = requestHash(request);
    for (const provider of this.providers) {
      if (!provider.supports(request.language)) continue;
      const cached = this.cache.get(`${provider.id}:${provider.configHash}:${key}`);
      if (cached && cached.contextFingerprint === request.contextFingerprint && cached.parserConfigHash === request.parserConfigHash) return cached;
      try {
        const result = await this.bounded(provider.resolve({ ...request, signal: request.signal }), request.signal);
        const normalized: ResolutionResult = {
          ...result,
          providerId: provider.id,
          providerKind: provider.kind,
          contextFingerprint: request.contextFingerprint,
          parserConfigHash: request.parserConfigHash,
          providerConfigHash: provider.configHash,
        };
        if (normalized.status !== "unavailable") this.cache.set(`${provider.id}:${provider.configHash}:${key}`, normalized);
        if (normalized.status === "verified" || normalized.status === "candidate") return normalized;
      } catch (error) {
        // Optional providers are deliberately non-fatal. The unavailable
        // result is returned only when no lower-priority provider can answer.
        const result = unavailable(request, provider, String((error as Error).message ?? error));
        if (provider.kind === "parser_local_exact") return result;
      }
    }
    const provider = this.providers.find((item) => item.supports(request.language));
    return provider
      ? unavailable(request, provider, "no configured resolver produced a bounded result")
      : {
          status: "unavailable",
          providerId: "none",
          providerKind: "heuristic",
          targets: [],
          explanation: `no resolver supports language ${request.language}`,
          contextFingerprint: request.contextFingerprint,
          parserConfigHash: request.parserConfigHash,
          providerConfigHash: "none",
        };
  }

  private async bounded(task: Promise<ResolutionResult>, signal?: AbortSignal): Promise<ResolutionResult> {
    const timeoutMs = this.options.timeoutMs ?? 1500;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("RESOLUTION_PROVIDER_TIMEOUT")), timeoutMs);
    });
    const abort = signal ? new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error("RESOLUTION_PROVIDER_ABORTED"));
      else signal.addEventListener("abort", () => reject(new Error("RESOLUTION_PROVIDER_ABORTED")), { once: true });
    }) : null;
    try {
      return await Promise.race([task, timeout, ...(abort ? [abort] : [])]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
