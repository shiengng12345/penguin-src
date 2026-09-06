import {
  buildContextPack,
  buildFlow,
  listFileSymbols,
  packageDependencies,
  resolveSymbolMatches,
  search,
  type ContextPack,
  type FlowResult,
  type KnowledgeStore,
  type SearchResultRow,
} from "@penguin/knowledge-core";

export type AnalysisFocus = "auto" | "dependency" | "logging" | "calls" | "architecture";
export type AnalysisFallbackStage = "exact" | "search" | "explore" | "file_symbols" | "config_flow";

export interface AnalysisFallbackTrace {
  attempted: AnalysisFallbackStage[];
  selected: AnalysisFallbackStage | null;
  elapsedMs: number;
  resultCount: number;
  timeoutStage: AnalysisFallbackStage | null;
  gaps: string[];
}

export interface RepositoryAnalysisOptions {
  query: string;
  repo?: string;
  focus?: AnalysisFocus;
  limit?: number;
}

export interface RepositoryAnalysis {
  focus: Exclude<AnalysisFocus, "auto">;
  verifiedFacts: string[];
  inferences: string[];
  gaps: string[];
  evidence: unknown[];
  nextTools: string[];
  trace: AnalysisFallbackTrace;
}

const ANALYSIS_BUDGET_MS = 7_000;
const STAGE_BUDGET_MS: Record<AnalysisFallbackStage, number> = {
  exact: 1_000,
  search: 1_500,
  explore: 2_500,
  file_symbols: 1_000,
  config_flow: 2_500,
};
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "does", "for", "how", "into", "is", "of", "reach", "show", "the", "to", "what", "where", "which", "with",
]);

function queryTokens(query: string): string[] {
  return [...new Set(query.match(/[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::|#)[A-Za-z_$][A-Za-z0-9_$]*)*/g) ?? [])]
    .filter((token) => !STOP_WORDS.has(token.toLowerCase()))
    .slice(0, 8);
}

function addUniqueHit(target: Map<string, SearchResultRow>, hit: SearchResultRow): void {
  const key = hit.nodeId ?? `${hit.identityKey}:${hit.filePath ?? ""}:${hit.startLine ?? 0}`;
  if (!target.has(key)) target.set(key, hit);
}

function deterministicSearch(
  store: KnowledgeStore,
  query: string,
  repo: string | undefined,
  limit: number,
): SearchResultRow[] {
  const candidates = [query.trim(), ...queryTokens(query)].filter(Boolean);
  const hits = new Map<string, SearchResultRow>();
  for (const candidate of candidates) {
    for (const hit of search(store, candidate, { repo, limit })) addUniqueHit(hits, hit);
    // A successful exact phrase/term is enough to seed exploration. The
    // remaining bounded token searches are only needed to widen natural
    // language questions such as "how does VersionService reach Version".
    if (hits.size >= limit && candidate === query.trim()) break;
  }
  return [...hits.values()].slice(0, limit);
}

function repoScope(store: KnowledgeStore, repo: string | undefined): { repoId?: string; gaps: string[] } {
  if (!repo) return { gaps: [] };
  const ids = store.resolveRepoIds(repo);
  if (ids.length === 0) return { gaps: [`Repository "${repo}" is not registered; no repository-scoped exact target can be trusted.`] };
  if (ids.length > 1) return { gaps: [`Repository selector "${repo}" matches ${ids.length} repositories; exact flow exploration is withheld until the repository is disambiguated.`] };
  return { repoId: ids[0], gaps: [] };
}

function freshBranchForFile(store: KnowledgeStore, nodeId: string, filePath: string): string | null {
  const row = store.db.prepare(
    `SELECT branch_id AS branchId
       FROM symbol_versions
      WHERE node_id=? AND file_path=? AND status='fresh'
      ORDER BY last_seen_at DESC, id DESC LIMIT 1`,
  ).get(nodeId, filePath) as { branchId: string } | undefined;
  return row?.branchId ?? null;
}

function stageFailure(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

function traceResultCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.steps)) return record.steps.length;
  if (Array.isArray(record.symbols)) return record.symbols.length;
  if (Array.isArray(record.hits)) return record.hits.length;
  return record.focus || record.root ? 1 : 0;
}

export function selectAnalysisFocus(query: string, requested: AnalysisFocus = "auto"): Exclude<AnalysisFocus, "auto"> {
  if (requested !== "auto") return requested;
  if (/depend|package|npm|pnpm|lockfile/i.test(query)) return "dependency";
  if (/log|stdout|pino|sls|logtail|otel/i.test(query)) return "logging";
  if (/call|caller|invoke|route/i.test(query)) return "calls";
  return "architecture";
}

export function analyzeRepository(store: KnowledgeStore, options: RepositoryAnalysisOptions): RepositoryAnalysis {
  const startedAt = Date.now();
  const focus = selectAnalysisFocus(options.query, options.focus ?? "auto");
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const verifiedFacts: string[] = [];
  const inferences: string[] = [];
  const gaps: string[] = [];
  const evidence: unknown[] = [];
  const trace: AnalysisFallbackTrace = {
    attempted: [],
    selected: null,
    elapsedMs: 0,
    resultCount: 0,
    timeoutStage: null,
    gaps: [],
  };
  const scope = repoScope(store, options.repo);
  gaps.push(...scope.gaps);
  const recordGap = (message: string) => {
    if (!gaps.includes(message)) gaps.push(message);
    if (!trace.gaps.includes(message)) trace.gaps.push(message);
  };
  const runStage = <T>(stage: AnalysisFallbackStage, fn: () => T): T | undefined => {
    if (trace.timeoutStage) return undefined;
    if (Date.now() - startedAt >= ANALYSIS_BUDGET_MS) {
      trace.timeoutStage = stage;
      recordGap(`Analysis budget exhausted before ${stage}; the result is partial.`);
      return undefined;
    }
    trace.attempted.push(stage);
    const stageStartedAt = Date.now();
    try {
      const value = fn();
      trace.resultCount += traceResultCount(value);
      if (Date.now() - stageStartedAt > STAGE_BUDGET_MS[stage]) {
        trace.timeoutStage = stage;
        recordGap(`Analysis stage ${stage} exceeded its ${STAGE_BUDGET_MS[stage]}ms budget; later fallback stages were skipped.`);
      }
      return value;
    } catch (error) {
      recordGap(`Analysis stage ${stage} failed: ${stageFailure(error)}`);
      return undefined;
    }
  };
  const finish = (result: Omit<RepositoryAnalysis, "trace">): RepositoryAnalysis => {
    trace.elapsedMs = Date.now() - startedAt;
    return { ...result, trace: { ...trace, attempted: [...trace.attempted], gaps: [...trace.gaps] } };
  };

  if (focus === "dependency") {
    const subject = options.repo ?? options.query;
    const result = packageDependencies(store, {
      subject,
      direction: "dependencies",
      transitive: true,
      maxDepth: 5,
      limit,
    });
    evidence.push(result);
    if (result.status === "subject_not_found") {
      gaps.push(`No indexed package subject matched "${subject}"; this is not proof that the package is absent.`);
    } else if (result.status === "subject_ambiguous") {
      gaps.push(`Package subject "${subject}" matched multiple indexed services; specify an exact identity before trusting dependencies.`);
    } else {
      for (const node of result.nodes) {
        verifiedFacts.push(`${subject} depends on ${node.title} at graph depth ${node.depth}.`);
      }
      if (result.truncated) gaps.push("Dependency graph traversal was bounded by maxDepth or limit.");
    }
    gaps.push("Deployment/runtime dependencies outside indexed manifests are not verified.");
    trace.attempted.push("exact");
    trace.selected = result.status === "ok" ? "exact" : null;
    trace.resultCount = result.nodes.length;
    return finish({ focus, verifiedFacts, inferences, gaps, evidence, nextTools: ["package_dependencies", "dependency_path"] });
  }

  const exactTargets = new Map<string, string>();
  runStage("exact", () => {
    // A display name that maps to multiple repositories is useful search
    // scope, but it is not a safe graph scope. Do not let exact resolution
    // silently pick a same-named symbol from one of those repositories.
    if (options.repo && !scope.repoId) return [];
    for (const candidate of [options.query.trim(), ...queryTokens(options.query)]) {
      const resolution = resolveSymbolMatches(store, candidate, scope.repoId ? { repoId: scope.repoId } : undefined);
      if (resolution.kind === "unique") exactTargets.set(resolution.nodeId, candidate);
      if (resolution.kind === "ambiguous") recordGap(`Exact target "${candidate}" is ambiguous; candidates were not auto-selected.`);
    }
    return [...exactTargets.keys()];
  });

  const hits = runStage("search", () => deterministicSearch(store, options.query, options.repo, limit)) ?? [];
  evidence.push(...hits);
  for (const hit of hits) verifiedFacts.push(`Indexed ${hit.nodeType} match: ${hit.title} (${hit.identityKey}).`);

  const candidateIds = [...new Set([
    ...exactTargets.keys(),
    ...hits.map((hit) => hit.nodeId).filter((id): id is string => Boolean(id)),
  ])];
  const explored: Array<{ target: string; flow: FlowResult; context: ContextPack }> = [];
  const exploreResult = runStage("explore", () => {
    if (options.repo && !scope.repoId) return [];
    for (const nodeId of candidateIds.slice(0, 8)) {
      const flow = buildFlow(store, `node:${nodeId}`, { repoId: scope.repoId, limit: Math.min(limit, 20) });
      const context = buildContextPack(store, `node:${nodeId}`, { repoId: scope.repoId, limit: Math.min(limit, 20), includeSources: false });
      explored.push({ target: exactTargets.get(nodeId) ?? nodeId, flow, context });
      evidence.push({ kind: "explore", target: exactTargets.get(nodeId) ?? nodeId, flow, context });
      const useful = flow.steps.length > 1 || context.calls.length > 0 || context.callers.length > 0 || context.routes.length > 0;
      if (useful) {
        trace.selected = "explore";
        break;
      }
    }
    return explored;
  });

  const usefulFlow = explored.some(({ flow, context }) => flow.steps.length > 1 || context.calls.length > 0 || context.callers.length > 0 || context.routes.length > 0);
  if (!trace.selected && exactTargets.size > 0 && exploreResult?.length) trace.selected = "exact";
  if (usefulFlow) {
    inferences.push("The answer was assembled from bounded deterministic graph evidence; dynamic dispatch and runtime configuration remain separate gaps.");
    for (const { flow } of explored) {
      for (const step of flow.steps.slice(1)) {
        verifiedFacts.push(`Static flow candidate: ${step.title} via ${step.via}.`);
      }
    }
  }

  if (!trace.selected && hits.length > 0 && !trace.timeoutStage) {
    runStage("file_symbols", () => {
      const seen = new Set<string>();
      for (const hit of hits) {
        if (!hit.nodeId || !hit.filePath) continue;
        const branchId = freshBranchForFile(store, hit.nodeId, hit.filePath);
        if (!branchId) continue;
        const key = `${branchId}:${hit.filePath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const symbols = listFileSymbols(store, branchId, hit.filePath);
        evidence.push({ kind: "file_symbols", filePath: hit.filePath, symbols });
        if (symbols.length > 0) {
          trace.selected = "file_symbols";
          for (const symbol of symbols.slice(0, limit)) verifiedFacts.push(`Indexed ${symbol.kind} ${symbol.title} in ${hit.filePath}:${symbol.startLine ?? "?"}.`);
        }
      }
      return seen;
    });
  }

  const configRelevant = /config|redis|vault|env|flag|runtime|cluster|flow|endpoint|route/i.test(options.query);
  if (!trace.selected && configRelevant && candidateIds.length > 0 && !trace.timeoutStage) {
    runStage("config_flow", () => {
      for (const nodeId of candidateIds.slice(0, 3)) {
        const context = buildContextPack(store, `node:${nodeId}`, { repoId: scope.repoId, limit: Math.min(limit, 20), includeSources: false });
        evidence.push({ kind: "config_flow", target: exactTargets.get(nodeId) ?? nodeId, context });
        if (context.envs.length || context.calls.length || context.routes.length) {
          trace.selected = "config_flow";
          verifiedFacts.push(`Configuration/runtime-related evidence is attached for ${context.focus?.title ?? nodeId}.`);
          break;
        }
      }
      return candidateIds;
    });
  }

  if (hits.length === 0 && trace.resultCount === 0) {
    recordGap("No indexed symbol or note matched; empty search is not proof of absence.");
  }

  if (focus === "logging") {
    verifiedFacts.push("Only logging components present in the indexed code/notes can be verified locally.");
    gaps.push("stdout → Logtail → SLS is outside the local repository evidence unless deployment configuration is indexed.");
    gaps.push("PROD logs, CPMS data, and runtime delivery are not verified; use Aliyun SLS or the relevant backend observability tools.");
    inferences.push("A local logger-to-stdout chain may explain application emission, but it does not prove external ingestion or retention.");
    return finish({ focus, verifiedFacts, inferences, gaps, evidence, nextTools: ["knowledge_search", "explore_graph", "aliyun SLS trace search"] });
  }
  if (focus === "calls") {
    gaps.push("Static graph results may miss DI, HTTP, reflection, and dynamic dispatch; empty edges are not proof of no runtime call.");
    return finish({ focus, verifiedFacts, inferences, gaps, evidence, nextTools: ["knowledge_explore", "explore_graph", "Aliyun SLS"] });
  }
  gaps.push("Architecture view is limited to indexed repositories, branches, symbols, notes, and edges.");
  return finish({ focus, verifiedFacts, inferences, gaps, evidence, nextTools: ["get_architecture", "find_communities", "index_status"] });
}
