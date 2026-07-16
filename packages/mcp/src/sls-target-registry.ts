import type { SlsTargetConfig } from "./config.js";

export interface SlsTarget extends SlsTargetConfig {
  aliases: string[];
  services: string[];
  enabled: boolean;
  source: "config" | "verified_discovery" | "user_supplied";
}

export const INITIAL_SLS_TARGETS: SlsTarget[] = [
  { targetId: "fpms-qat", environment: "qat", aliases: ["qat", "fpms-qat"], regionId: "ap-southeast-1", project: "platform-qat-aliyun-logs", logstore: "platform-fpms-qat", services: ["fpms"], enabled: true, source: "verified_discovery" },
  { targetId: "fpms-uat", environment: "uat", aliases: ["uat", "fpms-uat"], regionId: "ap-southeast-1", project: "platform-uat-aliyun-logs", logstore: "platform-fpms-uat", services: ["fpms"], enabled: true, source: "verified_discovery" },
  { targetId: "fpms-prod", environment: "prod", aliases: ["prod", "production", "fpms-prod"], regionId: "ap-southeast-1", project: "platform-prod-aliyun-logs", logstore: "platform-fpms-prod", services: ["fpms"], enabled: true, source: "verified_discovery" },
  { targetId: "brazil-uat", environment: "uat", aliases: ["brazil-uat"], regionId: "us-west-1", project: "platform-test-brazil", logstore: "brazil-uat", services: ["brazil"], enabled: true, source: "verified_discovery" },
  { targetId: "brazil-uat-v2", environment: "uat", aliases: ["brazil-uat-v2"], regionId: "us-west-1", project: "platform-test-brazil", logstore: "brazil-uat-v2", services: ["brazil"], enabled: true, source: "verified_discovery" },
  { targetId: "newport-uat", environment: "uat", aliases: ["newport-uat", "newport"], regionId: "ap-southeast-1", project: "platform-uat-aliyun-logs", logstore: "platform-newport-uat", services: ["newport"], enabled: true, source: "verified_discovery" },
];

export function slsTargetKey(target: Pick<SlsTarget, "regionId" | "project" | "logstore">): string {
  return `${target.regionId}\u0000${target.project}\u0000${target.logstore}`;
}

function normalizeConfig(input: SlsTargetConfig): SlsTarget {
  return {
    ...input,
    aliases: [...new Set([input.targetId, ...(input.aliases ?? [])])],
    services: [...new Set(input.services ?? [])],
    enabled: input.enabled !== false,
    source: input.source ?? "config",
  };
}

export function mergeSlsTargets(seed: SlsTarget[], configured: SlsTargetConfig[]): SlsTarget[] {
  const byKey = new Map(seed.map((target) => [slsTargetKey(target), { ...target, aliases: [...target.aliases], services: [...target.services] }]));
  const byId = new Map(seed.map((target) => [target.targetId, target]));
  const configuredKeys = new Map<string, string>();
  for (const raw of configured) {
    const target = normalizeConfig(raw);
    const identity = slsTargetKey(target);
    const priorConfiguredId = configuredKeys.get(identity);
    if (priorConfiguredId && priorConfiguredId !== target.targetId) {
      throw new Error(`duplicate SLS target identity: ${identity}`);
    }
    configuredKeys.set(identity, target.targetId);
    const existingById = byId.get(target.targetId);
    const existing = byKey.get(slsTargetKey(target));
    if (existingById && existing && existingById !== existing && slsTargetKey(existingById) !== slsTargetKey(existing)) {
      throw new Error(`conflicting SLS targetId: ${target.targetId}`);
    }
    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, ...target.aliases])];
      existing.services = [...new Set([...existing.services, ...target.services])];
      existing.enabled = target.enabled;
      if (target.source === "user_supplied" || target.source === "config") existing.source = target.source;
      byId.set(existing.targetId, existing);
    } else {
      byKey.set(slsTargetKey(target), target);
      byId.set(target.targetId, target);
    }
  }
  const identities = new Map<string, SlsTarget>();
  for (const target of byKey.values()) {
    const prior = identities.get(slsTargetKey(target));
    if (prior && prior.targetId !== target.targetId) throw new Error(`duplicate SLS target identity: ${slsTargetKey(target)}`);
    identities.set(slsTargetKey(target), target);
  }
  return [...identities.values()];
}

export function dedupeUrls(urls: string[]): string[] {
  const entries: Array<{ path: string; region: string | null; raw: string }> = [];
  for (const raw of urls) {
    try {
      const url = new URL(raw);
      const path = `${url.hostname}${url.pathname.replace(/\/$/, "")}`;
      const region = url.searchParams.get("slsRegion");
      const existing = entries.find((entry) => entry.path === path && (entry.region === region || !entry.region || !region));
      if (existing && !existing.region) existing.region = region;
      else if (!existing) entries.push({ path, region, raw });
    } catch {
      entries.push({ path: raw, region: null, raw });
    }
  }
  return entries.map((entry) => entry.raw);
}

export type ParsedSlsConsoleUrl =
  | ({ status: "resolved" } & SlsTarget)
  | { status: "missing_region" | "malformed" | "unsupported_host" | "ambiguous"; reason: string; candidates: SlsTarget[] };

export function parseSlsConsoleUrl(urlString: string, verifiedRegistry: SlsTarget[] = INITIAL_SLS_TARGETS): ParsedSlsConsoleUrl {
  let url: URL;
  try { url = new URL(urlString); } catch { return { status: "malformed", reason: "invalid URL", candidates: [] }; }
  if (url.hostname !== "sls.console.alibabacloud.com") return { status: "unsupported_host", reason: `unsupported host: ${url.hostname}`, candidates: [] };
  const match = url.pathname.match(/^\/lognext\/project\/([^/]+)\/logsearch\/([^/]+)\/?$/);
  if (!match) return { status: "malformed", reason: "expected /lognext/project/<project>/logsearch/<logstore>", candidates: [] };
  const project = decodeURIComponent(match[1]);
  const logstore = decodeURIComponent(match[2]);
  const regionId = url.searchParams.get("slsRegion");
  const candidates = verifiedRegistry.filter((target) => target.project === project && target.logstore === logstore);
  const region = regionId ?? (candidates.length === 1 ? candidates[0].regionId : null);
  if (!region) return { status: candidates.length > 1 ? "ambiguous" : "missing_region", reason: "slsRegion is required unless one verified registry target matches", candidates };
  const target = verifiedRegistry.find((item) => item.regionId === region && item.project === project && item.logstore === logstore);
  if (target) return { status: "resolved", ...target };
  return {
    status: "resolved",
    targetId: `${project}-${logstore}`.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase(),
    environment: /prod/i.test(logstore) || /prod/i.test(project) ? "prod" : "unknown",
    aliases: [], services: [], enabled: true, source: "user_supplied", regionId: region, project, logstore,
  };
}

export interface SlsTargetResolution {
  status: "resolved" | "ambiguous" | "not_found" | "invalid";
  targets: SlsTarget[];
  candidates: SlsTarget[];
  reason?: string;
}

export function resolveSlsTargets(input: { request: { scope?: "auto" | "all" | "targets"; targetIds?: string[]; slsUrls?: string[]; clues?: Record<string, unknown> }; registry: SlsTarget[] }): SlsTargetResolution {
  const enabled = input.registry.filter((target) => target.enabled);
  const request = input.request;
  const fromUrls = (request.slsUrls ?? []).map((url) => parseSlsConsoleUrl(url, enabled));
  if (fromUrls.some((result) => result.status !== "resolved")) {
    const bad = fromUrls.find((result) => result.status !== "resolved")!;
    return { status: bad.status === "ambiguous" ? "ambiguous" : "invalid", targets: [], candidates: bad.candidates, reason: bad.reason };
  }
  const urlTargets = fromUrls.filter((result): result is Extract<ParsedSlsConsoleUrl, { status: "resolved" }> => result.status === "resolved");
  if (request.scope === "targets" || request.targetIds?.length) {
    const wanted = request.targetIds ?? [];
    const targets = enabled.filter((target) => wanted.includes(target.targetId) || wanted.some((id) => target.aliases.includes(id)));
    if (targets.length !== wanted.length && wanted.length > 0) return { status: "not_found", targets: [], candidates: enabled, reason: "one or more target IDs were not found" };
    return { status: "resolved", targets: [...new Map([...targets, ...urlTargets].map((target) => [target.targetId, target])).values()], candidates: enabled };
  }
  if (urlTargets.length) return { status: "resolved", targets: [...new Map(urlTargets.map((target) => [slsTargetKey(target), target])).values()], candidates: enabled };
  const targets = request.scope === "all" ? enabled : enabled;
  return { status: "resolved", targets, candidates: enabled };
}
