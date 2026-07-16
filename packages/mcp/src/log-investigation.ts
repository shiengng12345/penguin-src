import { planTargetQueries, canonicalHash, type SlsQueryPlan, type SlsQueryStep } from "./log-query-planner.js";
import {
  aggregateInvestigationStatus,
  selectInvestigationTargets,
  validateInvestigationRequest,
  type InvestigationContinuation,
  type InvestigationRequest,
  type InvestigationStateStore,
  type TargetInvestigationResult,
  type TargetInvestigationState,
  type TargetQueryStatus,
  type ValidatedInvestigationRequest,
} from "./log-investigation-contract.js";
import type { SlsTarget } from "./sls-target-registry.js";
import type { KnowledgeEvidencePreflight } from "./log-evidence-correlator.js";

export interface SlsExecutionPage {
  rows: Array<Record<string, unknown>>;
  nextCursor?: string;
  done: boolean;
  truncated: boolean;
  transportStatus: { code?: number | string; message?: string };
  warnings: string[];
}
export interface SlsClient {
  textToSql(input: { target: Pick<SlsTarget, "targetId" | "regionId" | "project" | "logstore">; prompt: string; from: string; to: string; requiredFields: string[]; limit: number }): Promise<{ sql: string; warnings?: string[] }>;
  executeSql(input: { target: Pick<SlsTarget, "targetId" | "regionId" | "project" | "logstore">; query: string; from: string; to: string; limit: number; cursor?: string }): Promise<SlsExecutionPage>;
}

export interface PendingSlsCall {
  server: "aliyun_sls";
  tool: "sls_text_to_sql" | "sls_execute_sql";
  phase: "translate" | "execute";
  stepId: string;
  targetId: string;
  arguments: Record<string, unknown>;
  queryHash: string;
  translatedSqlHash?: string;
}
export interface SlsToolResultEnvelope {
  stepId: string;
  targetId: string;
  queryHash: string;
  phase: "translate" | "execute";
  translatedSqlHash?: string;
  ok: boolean;
  result?: { sql?: string; page?: SlsExecutionPage };
  error?: { code?: number | string; message: string; retryable?: boolean };
}
export interface LogInvestigationDeps {
  registry: SlsTarget[];
  stateStore: InvestigationStateStore;
  now: () => Date;
  delay(ms: number, signal: AbortSignal): Promise<void>;
  signal?: AbortSignal;
  slsClient?: SlsClient;
  knowledgePreflight?: KnowledgeEvidencePreflight;
}
export type LogInvestigationResult =
  | { status: "awaiting_sls_execution"; continuation: InvestigationContinuation; pendingCalls: PendingSlsCall[] }
  | { status: TargetQueryStatus; sessionId: string; request: ValidatedInvestigationRequest; targets: TargetInvestigationResult[]; warnings: string[]; knowledgeSeed?: import("./log-investigation-contract.js").KnowledgeEvidenceSeed; continuation?: InvestigationContinuation };

function targetInput(target: SlsTarget) { return { targetId: target.targetId, regionId: target.regionId, project: target.project, logstore: target.logstore }; }
function pendingForStep(step: SlsQueryStep): PendingSlsCall {
  if (step.kind === "direct_sql") return { server: "aliyun_sls", tool: "sls_execute_sql", phase: "execute", stepId: step.stepId, targetId: step.target.targetId, queryHash: step.queryHash, arguments: { target: targetInput(step.target), query: step.sql, from: step.from, to: step.to, limit: step.limit } };
  return { server: "aliyun_sls", tool: "sls_text_to_sql", phase: "translate", stepId: step.stepId, targetId: step.target.targetId, queryHash: step.queryHash, arguments: { target: targetInput(step.target), prompt: step.prompt, from: step.from, to: step.to, requiredFields: ["_time_", "trace_id", "span_id", "msg", "content"], limit: step.limit } };
}
function emptyState(target: SlsTarget, plan: SlsQueryPlan): TargetInvestigationState {
  return { target, completedStepIds: [], pendingStepIds: plan.steps.map((step) => step.stepId), attempts: 0, rows: [], truncated: false, warnings: [], translatedSqlByStep: {} };
}
function transient(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  return code === "ETIMEDOUT" || code === "ECONNRESET" || code === "429" || /^5\d\d$/.test(code);
}
function statusForError(error: unknown): TargetQueryStatus {
  const code = String((error as { code?: unknown })?.code ?? "");
  const message = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  if (code === "ETIMEDOUT" || message.includes("timeout")) return "timeout";
  if (code === "401" || code === "403" || message.includes("unauthoriz")) return "unauthorized";
  if (code === "400" || message.includes("invalid query")) return "invalid_query";
  return "unavailable";
}
function validateTranslatedSql(sql: string, step: SlsQueryStep): void {
  const trimmed = sql.trim();
  if (!trimmed || trimmed.includes(";")) throw Object.assign(new Error("invalid query: multiple statements are not allowed"), { code: "400" });
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|select\s+into)\b/i.test(trimmed)) throw Object.assign(new Error("invalid query: mutation/admin SQL is not allowed"), { code: "400" });
  const limit = trimmed.match(/\bLIMIT\s+(\d+)/i);
  if (!limit || Number(limit[1]) > step.limit) throw Object.assign(new Error("invalid query: bounded LIMIT is required"), { code: "400" });
}

async function executeStep(step: SlsQueryStep, client: SlsClient, request: ValidatedInvestigationRequest, deps: LogInvestigationDeps, state: TargetInvestigationState): Promise<void> {
  let query = step.sql;
  if (step.kind === "text_to_sql") {
    const translated = await client.textToSql({ target: targetInput(step.target), prompt: step.prompt!, from: step.from, to: step.to, requiredFields: ["_time_", "trace_id", "span_id", "msg", "content"], limit: step.limit });
    validateTranslatedSql(translated.sql, step);
    query = translated.sql;
    if (translated.warnings) state.warnings.push(...translated.warnings);
  }
  let cursor: string | undefined;
  let pages = 0;
  while (state.rows.length < request.budgets.maxRowsPerTarget) {
    let page: SlsExecutionPage | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= 2; attempt++) {
      state.attempts += 1;
      try {
        page = await client.executeSql({ target: targetInput(step.target), query: query!, from: step.from, to: step.to, limit: Math.min(step.limit, request.budgets.maxRowsPerTarget - state.rows.length), ...(cursor ? { cursor } : {}) });
        break;
      } catch (error) {
        lastError = error;
        if (!transient(error) || attempt === 2) throw error;
        await deps.delay([250, 1000][attempt], deps.signal ?? new AbortController().signal);
      }
    }
    if (!page) throw lastError ?? new Error("SLS returned no page");
    state.rows.push(...page.rows.slice(0, request.budgets.maxRowsPerTarget - state.rows.length));
    state.truncated ||= page.truncated;
    state.warnings.push(...page.warnings);
    pages += 1;
    if (state.rows.length >= request.budgets.maxRowsPerTarget) { state.truncated = true; break; }
    if (page.done || !page.nextCursor || pages > 100) break;
    cursor = page.nextCursor;
  }
}

function resultFromState(state: TargetInvestigationState, startedAt: string, completedAt: string, error?: unknown): TargetInvestigationResult {
  const queryStatus = error ? statusForError(error) : state.rows.length === 0 ? "no_match" : state.truncated ? "partial" : "success";
  return { ...state, queryStatus, startedAt, completedAt, ...(error ? { warnings: [...state.warnings, String((error as Error).message ?? error)] } : {}) };
}

function continuationCalls(state: import("./log-investigation-contract.js").InvestigationSessionState): PendingSlsCall[] {
  const calls: PendingSlsCall[] = [];
  for (const targetState of state.targets) {
    const plan = planTargetQueries(state.request, targetState.target);
    for (const step of plan.steps.filter((item) => targetState.pendingStepIds.includes(item.stepId))) {
      const translated = targetState.translatedSqlByStep?.[step.stepId];
      if (step.kind === "text_to_sql" && translated) {
        calls.push({ server: "aliyun_sls", tool: "sls_execute_sql", phase: "execute", stepId: step.stepId, targetId: step.target.targetId, queryHash: step.queryHash, translatedSqlHash: canonicalHash(translated), arguments: { target: targetInput(step.target), query: translated, from: step.from, to: step.to, limit: step.limit } });
      } else {
        calls.push(pendingForStep(step));
      }
    }
  }
  return calls;
}

export async function planLogInvestigation(request: InvestigationRequest, deps: Omit<LogInvestigationDeps, "slsClient">): Promise<LogInvestigationResult> {
  const validated = validateInvestigationRequest(request);
  const targets = selectInvestigationTargets(validated, deps.registry);
  const knowledgeSeed = deps.knowledgePreflight
    ? await deps.knowledgePreflight.collect({ request: validated, targets })
    : { collectedAt: deps.now().toISOString(), facts: [], gaps: [{ gapId: "gap_knowledge_preflight_unavailable", code: "knowledge_preflight_unavailable", message: "Knowledge preflight was not configured; SLS planning continues without code or Wiki context.", targetIds: targets.map((target) => target.targetId), evidenceIds: [] }], targetHints: [], evidence: [] };
  const plans = targets.map((target) => planTargetQueries(validated, target));
  const startedAt = deps.now().toISOString();
  const continuation = deps.stateStore.create({ version: 1, request: validated, targets: plans.map((plan) => emptyState(plan.target, plan)), knowledgeEvidenceIds: knowledgeSeed.evidence.map((item) => item.evidenceId), knowledgeSeed, startedAt, deadlineAt: new Date(deps.now().getTime() + validated.budgets.maxDurationMs).toISOString() });
  return { status: "awaiting_sls_execution", continuation, pendingCalls: plans.flatMap((plan) => plan.steps.map(pendingForStep)) };
}

export async function runLogInvestigation(request: InvestigationRequest, deps: LogInvestigationDeps & { slsClient: SlsClient }): Promise<LogInvestigationResult> {
  const validated = validateInvestigationRequest(request);
  const targets = selectInvestigationTargets(validated, deps.registry);
  const knowledgeSeed = deps.knowledgePreflight
    ? await deps.knowledgePreflight.collect({ request: validated, targets })
    : { collectedAt: deps.now().toISOString(), facts: [], gaps: [], targetHints: [], evidence: [] };
  const startedAt = deps.now().toISOString();
  const outputs = await Promise.all(targets.map(async (target) => {
    const plan = planTargetQueries(validated, target);
    const state = emptyState(target, plan);
    let error: unknown;
    try {
      for (const step of plan.steps) {
        await executeStep(step, deps.slsClient, validated, deps, state);
        state.completedStepIds.push(step.stepId);
        state.pendingStepIds = state.pendingStepIds.filter((id) => id !== step.stepId);
      }
    } catch (caught) { error = caught; }
    return resultFromState(state, startedAt, deps.now().toISOString(), error);
  }));
  return { status: aggregateInvestigationStatus(outputs.map((output) => output.queryStatus)), sessionId: `run-${Date.now()}`, request: validated, targets: outputs, warnings: outputs.flatMap((output) => output.warnings), knowledgeSeed };
}

export async function continueLogInvestigation(continuation: InvestigationContinuation, results: SlsToolResultEnvelope[], deps: Omit<LogInvestigationDeps, "slsClient">): Promise<LogInvestigationResult> {
  const state = deps.stateStore.load(continuation);
  const known = new Set(state.targets.flatMap((target) => target.pendingStepIds));
  for (const result of results) {
    if (!known.has(result.stepId)) throw new Error(`unknown or duplicate SLS step: ${result.stepId}`);
    const target = state.targets.find((item) => item.target.targetId === result.targetId);
    if (!target) throw new Error("SLS result target mismatch");
    if (!target.pendingStepIds.includes(result.stepId)) throw new Error(`unknown or duplicate SLS step: ${result.stepId}`);
    const step = planTargetQueries(state.request, target.target).steps.find((item) => item.stepId === result.stepId);
    if (!step) throw new Error("SLS result step mismatch");
    if (result.queryHash !== step.queryHash) throw new Error("SLS result query hash mismatch");
    if (result.phase === "translate") {
      if (step.kind !== "text_to_sql" || !result.ok || typeof result.result?.sql !== "string" || !result.result.sql.trim()) throw new Error("translation result requires a non-empty SQL string");
      if (result.result.sql.includes(";") || !/\bLIMIT\s+\d+/i.test(result.result.sql)) throw new Error("translated SQL must be one bounded statement");
      target.translatedSqlByStep ??= {};
      target.translatedSqlByStep[result.stepId] = result.result.sql;
      continue;
    }
    if (result.phase !== "execute" || !result.ok || !result.result?.page) throw new Error("continuation requires validated execute page results");
    target.rows.push(...result.result.page.rows);
    target.warnings.push(...result.result.page.warnings);
    target.truncated ||= result.result.page.truncated;
    target.queryStatus = result.result.page.rows.length === 0 ? "no_match" : "success";
    target.completedStepIds.push(result.stepId);
    target.pendingStepIds = target.pendingStepIds.filter((id) => id !== result.stepId);
  }
  const next = deps.stateStore.save(state);
  if (state.targets.some((target) => target.pendingStepIds.length > 0)) return { status: "awaiting_sls_execution", continuation: next, pendingCalls: continuationCalls(state) };
  const now = deps.now().toISOString();
  const outputs = state.targets.map((target) => resultFromState(target, state.startedAt, now));
  return { status: aggregateInvestigationStatus(outputs.map((output) => output.queryStatus)), sessionId: state.sessionId, request: state.request, targets: outputs, warnings: outputs.flatMap((output) => output.warnings), knowledgeSeed: state.knowledgeSeed, continuation: next };
}
