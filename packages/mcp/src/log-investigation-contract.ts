import { parseSlsConsoleUrl, slsTargetKey, type SlsTarget } from "./sls-target-registry.js";

export interface InvestigationRequest {
  question: string;
  scope?: "auto" | "all" | "targets";
  targetIds?: string[];
  slsUrls?: string[];
  timeRange: { from: string; to: string; timezone: string };
  clues: {
    traceIds?: string[];
    requestIds?: string[];
    playerIds?: string[];
    proposalIds?: string[];
    routes?: string[];
    methods?: string[];
    keywords?: string[];
  };
  budgets?: Partial<InvestigationBudgets>;
}

export interface InvestigationBudgets {
  maxTargets: number;
  maxRowsPerTarget: number;
  maxDurationMs: number;
  concurrency: number;
}

export interface ValidatedInvestigationRequest extends Omit<InvestigationRequest, "scope" | "budgets" | "clues"> {
  scope: "auto" | "all" | "targets";
  targetIds: string[];
  slsUrls: string[];
  budgets: InvestigationBudgets;
  clues: Required<InvestigationRequest>["clues"];
}

export type TargetQueryStatus = "success" | "no_match" | "partial" | "timeout" | "unauthorized" | "invalid_query" | "unavailable";

export interface TargetInvestigationState {
  target: SlsTarget;
  queryStatus?: TargetQueryStatus;
  completedStepIds: string[];
  pendingStepIds: string[];
  attempts: number;
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  transportStatus?: { code?: number | string; message?: string };
  businessStatus?: string | number;
  warnings: string[];
  translatedSqlByStep?: Record<string, string>;
}

export interface TargetInvestigationResult extends TargetInvestigationState {
  queryStatus: TargetQueryStatus;
  startedAt: string;
  completedAt: string;
}

export interface KnowledgeSeedFact {
  factId: string;
  source: "knowledge" | "wiki";
  statement: string;
  targetIds: string[];
  repoId?: string;
  repo?: string;
  branch?: string;
  commitSha?: string;
  snapshotId?: string;
  trust?: string;
  evidenceIds: string[];
}

export interface KnowledgeSeedGap {
  gapId: string;
  code: string;
  message: string;
  targetIds: string[];
  evidenceIds: string[];
}

export interface KnowledgeEvidenceSeed {
  collectedAt: string;
  facts: KnowledgeSeedFact[];
  gaps: KnowledgeSeedGap[];
  targetHints: Array<{ targetId: string; reason: string; evidenceIds: string[] }>;
  evidence: Array<{ evidenceId: string; source: "knowledge" | "wiki"; locator: string }>;
}

export interface InvestigationContinuation {
  version: 1;
  sessionId: string;
  stateHash: string;
  pendingStepIds: string[];
  startedAt: string;
  deadlineAt: string;
}

export interface InvestigationSessionState {
  version: 1;
  sessionId: string;
  request: ValidatedInvestigationRequest;
  targets: TargetInvestigationState[];
  knowledgeEvidenceIds: string[];
  knowledgeSeed?: KnowledgeEvidenceSeed;
  startedAt: string;
  deadlineAt: string;
  updatedAt: string;
}

export interface InvestigationStateStore {
  create(state: Omit<InvestigationSessionState, "sessionId" | "updatedAt">): InvestigationContinuation;
  load(continuation: InvestigationContinuation): InvestigationSessionState;
  save(state: InvestigationSessionState): InvestigationContinuation;
  remove(sessionId: string): void;
  pruneExpired(now: Date): string[];
}

export const DEFAULT_INVESTIGATION_BUDGETS: InvestigationBudgets = Object.freeze({
  maxTargets: 6,
  maxRowsPerTarget: 50,
  maxDurationMs: 60_000,
  concurrency: 3,
});

const clueKeys = ["traceIds", "requestIds", "playerIds", "proposalIds", "routes", "methods", "keywords"] as const;

function list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()))].sort();
}

export function validateInvestigationRequest(input: InvestigationRequest): ValidatedInvestigationRequest {
  if (!input || typeof input.question !== "string" || input.question.trim() === "") throw new Error("question must be non-empty");
  const from = Date.parse(input.timeRange?.from ?? "");
  const to = Date.parse(input.timeRange?.to ?? "");
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("timeRange must contain ordered ISO times");
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeRange.timezone }).format(); } catch { throw new Error("timeRange timezone is unknown"); }
  const clues = Object.fromEntries(clueKeys.map((key) => [key, list(input.clues?.[key])])) as ValidatedInvestigationRequest["clues"];
  if (!clueKeys.some((key) => (clues[key] ?? []).length > 0)) throw new Error("at least one clue is required");
  const scope = input.scope ?? "auto";
  if (!["auto", "all", "targets"].includes(scope)) throw new Error("scope must be auto, all, or targets");
  const targetIds = list(input.targetIds);
  if (scope === "targets" && targetIds.length === 0) throw new Error("targets scope requires targetIds");
  const budgets = { ...DEFAULT_INVESTIGATION_BUDGETS, ...(input.budgets ?? {}) };
  for (const [key, value] of Object.entries(budgets)) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`budget ${key} must be a positive integer`);
  }
  if (budgets.maxTargets > 100 || budgets.maxRowsPerTarget > 10_000 || budgets.maxDurationMs > 3_600_000 || budgets.concurrency > 32) throw new Error("investigation budget exceeds safe bounds");
  return {
    question: input.question.trim(), scope, targetIds, slsUrls: [...new Set(input.slsUrls ?? [])].sort(),
    timeRange: { ...input.timeRange }, clues, budgets,
  };
}

export function selectInvestigationTargets(request: ValidatedInvestigationRequest, registry: SlsTarget[]): SlsTarget[] {
  const enabled = registry.filter((target) => target.enabled);
  const byId = (id: string) => enabled.find((target) => target.targetId === id || target.aliases.includes(id));
  if (request.scope === "targets") {
    const selected = request.targetIds.map(byId);
    if (selected.some((target) => !target)) throw new Error("unknown investigation target");
    return selected.filter((target): target is SlsTarget => !!target);
  }
  const urlTargets = (request.slsUrls ?? []).map((url) => parseSlsConsoleUrl(url, enabled));
  const resolvedUrls = urlTargets.filter((target): target is Extract<typeof target, { status: "resolved" }> => target.status === "resolved");
  if (urlTargets.length !== resolvedUrls.length) throw new Error("one or more SLS URLs cannot be resolved");
  let selected = request.scope === "all" ? enabled : [...resolvedUrls, ...enabled];
  selected = [...new Map(selected.map((target) => [slsTargetKey(target), target])).values()];
  if (selected.length > request.budgets.maxTargets) {
    if (request.scope === "all") throw new Error(`all scope requires maxTargets >= ${selected.length}`);
    selected = selected.slice(0, request.budgets.maxTargets);
  }
  return selected;
}

export function aggregateInvestigationStatus(statuses: TargetQueryStatus[]): TargetQueryStatus {
  if (statuses.length === 0) return "no_match";
  if (statuses.every((status) => status === "no_match")) return "no_match";
  if (statuses.every((status) => status === "success")) return "success";
  if (statuses.length === 1) return statuses[0];
  return "partial";
}

export { FileInvestigationStateStore } from "./log-investigation-store.js";
