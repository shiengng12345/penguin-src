import { createHash } from "node:crypto";
import type { SlsTarget } from "./sls-target-registry.js";
import type { KnowledgeEvidenceSeed, TargetInvestigationResult, ValidatedInvestigationRequest } from "./log-investigation-contract.js";
import type { LogInvestigationResult } from "./log-investigation.js";

export interface EvidenceProvenance {
  evidenceId: string;
  source: "knowledge" | "wiki" | "sls";
  targetId?: string;
  environment?: string;
  regionId?: string;
  project?: string;
  logstore?: string;
  sourceTimestamp?: string;
  timezone?: string;
  queryHash?: string;
  traceId?: string;
  requestId?: string;
  repoId?: string;
  repo?: string;
  branch?: string;
  commitSha?: string;
  snapshotId?: string;
  mergeBaseSha?: string;
  trust?: string;
}
export interface EvidenceClaim {
  claimId: string;
  statement: string;
  targetId?: string;
  traceId?: string;
  requestId?: string;
  evidenceIds: string[];
  provenance?: EvidenceProvenance;
}
export interface EvidenceGap {
  gapId: string;
  code: string;
  message: string;
  targetId?: string;
  evidenceIds: string[];
}
export interface EvidenceObservation {
  observationId: string;
  targetId: string;
  sourceTimestamp?: string;
  traceId?: string;
  requestId?: string;
  raw: Record<string, unknown>;
  evidenceIds: string[];
}
export interface TargetEvidencePacket {
  target: SlsTarget;
  topicHash: string;
  question: string;
  result: TargetInvestigationResult;
  codeFacts: EvidenceClaim[];
  wikiFacts: EvidenceClaim[];
  slsFacts: EvidenceClaim[];
  inferences: EvidenceClaim[];
  gaps: EvidenceGap[];
  evidence: EvidenceProvenance[];
  observations: EvidenceObservation[];
}
export interface InvestigationEvidencePacket {
  investigationId: string;
  question: string;
  targets: TargetInvestigationResult[];
  targetPackets: TargetEvidencePacket[];
  codeFacts: EvidenceClaim[];
  wikiFacts: EvidenceClaim[];
  slsFacts: EvidenceClaim[];
  inferences: EvidenceClaim[];
  gaps: EvidenceGap[];
  evidence: EvidenceProvenance[];
  observations: EvidenceObservation[];
}
export interface CodeVersionResolver {
  resolve(input: { target: SlsTarget; rows: Array<Record<string, unknown>>; request: ValidatedInvestigationRequest }): Promise<Array<{ repoId: string; repo?: string; branch?: string; commitSha?: string; snapshotId?: string; trust: string; evidenceId: string }>>;
}
export interface KnowledgeEvidencePreflight {
  collect(input: { request: ValidatedInvestigationRequest; targets: SlsTarget[] }): Promise<KnowledgeEvidenceSeed>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function pick(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (row[key] != null && String(row[key]) !== "") return String(row[key]);
  return undefined;
}
function displayTime(value: unknown): string | undefined {
  if (value == null) return undefined;
  const date = typeof value === "number" ? new Date(value < 10_000_000_000 ? value * 1000 : value) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toLocaleString("sv-SE", { timeZone: "Asia/Kuala_Lumpur", hour12: false }).replace(" ", "T") + "+08:00";
}

export async function correlateInvestigationEvidence(
  result: Extract<LogInvestigationResult, { targets: TargetInvestigationResult[] }>,
  knowledgeSeed: KnowledgeEvidenceSeed,
  deps: { codeVersionResolver?: CodeVersionResolver } = {},
): Promise<InvestigationEvidencePacket> {
  const targetPackets: TargetEvidencePacket[] = [];
  for (const targetResult of result.targets) {
    const target = targetResult.target;
    const topicHash = hash({ targetId: target.targetId, question: result.request.question, clues: result.request.clues });
    const evidence: EvidenceProvenance[] = [];
    const observations: EvidenceObservation[] = [];
    const slsFacts: EvidenceClaim[] = [];
    const seen = new Set<string>();
    for (const row of targetResult.rows) {
      const sourceTimestamp = pick(row, "_time_", "time", "timestamp");
      const traceId = pick(row, "trace_id", "traceId");
      const requestId = pick(row, "request_id", "requestId");
      const evidenceId = `sls_${hash({ target: { region: target.regionId, project: target.project, logstore: target.logstore }, sourceTimestamp, traceId, requestId, row })}`;
      if (seen.has(evidenceId)) continue;
      seen.add(evidenceId);
      const provenance: EvidenceProvenance = { evidenceId, source: "sls", targetId: target.targetId, environment: target.environment, regionId: target.regionId, project: target.project, logstore: target.logstore, sourceTimestamp, timezone: "Asia/Kuala_Lumpur", traceId, requestId };
      evidence.push(provenance);
      observations.push({ observationId: `observation_${evidenceId}`, targetId: target.targetId, sourceTimestamp, traceId, requestId, raw: row, evidenceIds: [evidenceId] });
      const message = pick(row, "msg", "message", "content") ?? "bounded log observation";
      slsFacts.push({ claimId: `claim_${evidenceId}`, statement: `Observed on ${target.targetId}: ${message}`, targetId: target.targetId, traceId, requestId, evidenceIds: [evidenceId], provenance });
    }
    const codeFacts: EvidenceClaim[] = [];
    const wikiFacts: EvidenceClaim[] = [];
    const gaps: EvidenceGap[] = [];
    for (const fact of knowledgeSeed.facts.filter((item) => item.targetIds.length === 0 || item.targetIds.includes(target.targetId))) {
      const claim = { claimId: fact.factId, statement: fact.statement, targetId: target.targetId, evidenceIds: fact.evidenceIds };
      (fact.source === "wiki" ? wikiFacts : codeFacts).push(claim);
      evidence.push(...knowledgeSeed.evidence.filter((item) => fact.evidenceIds.includes(item.evidenceId)).map((item) => ({ evidenceId: item.evidenceId, source: item.source, targetId: target.targetId, ...(item.locator ? { queryHash: item.locator } : {}) })));
    }
    for (const gap of knowledgeSeed.gaps.filter((item) => item.targetIds.length === 0 || item.targetIds.includes(target.targetId))) gaps.push({ ...gap, targetId: target.targetId });
    if (targetResult.queryStatus === "no_match" && targetResult.rows.length === 0) gaps.push({ gapId: `gap_${target.targetId}_no_match`, code: "no_matching_rows", message: "No matching rows were returned in the bounded window; this is not proof of absence.", targetId: target.targetId, evidenceIds: [] });
    if (targetResult.queryStatus !== "success" && targetResult.queryStatus !== "no_match") gaps.push({ gapId: `gap_${target.targetId}_${targetResult.queryStatus}`, code: targetResult.queryStatus, message: `SLS target ended with status ${targetResult.queryStatus}; evidence is incomplete.`, targetId: target.targetId, evidenceIds: [] });
    if (deps.codeVersionResolver && targetResult.rows.length) {
      const revisions = await deps.codeVersionResolver.resolve({ target, rows: targetResult.rows, request: result.request });
      for (const revision of revisions) {
        const claim: EvidenceClaim = { claimId: revision.evidenceId, statement: `Code revision resolved with trust ${revision.trust}.`, targetId: target.targetId, evidenceIds: [revision.evidenceId] };
        codeFacts.push(claim);
        evidence.push({ evidenceId: revision.evidenceId, source: "knowledge", targetId: target.targetId, repoId: revision.repoId, repo: revision.repo, branch: revision.branch, commitSha: revision.commitSha, snapshotId: revision.snapshotId, trust: revision.trust });
      }
    } else if (targetResult.rows.length) gaps.push({ gapId: `gap_${target.targetId}_trust`, code: "trust_unavailable", message: "No deployed-code resolver was available; current checkout is not asserted as historical code.", targetId: target.targetId, evidenceIds: [] });
    targetPackets.push({ target, topicHash, question: result.request.question, result: targetResult, codeFacts, wikiFacts, slsFacts, inferences: [], gaps, evidence, observations });
  }
  return {
    investigationId: result.sessionId,
    question: result.request.question,
    targets: result.targets,
    targetPackets,
    codeFacts: targetPackets.flatMap((packet) => packet.codeFacts),
    wikiFacts: targetPackets.flatMap((packet) => packet.wikiFacts),
    slsFacts: targetPackets.flatMap((packet) => packet.slsFacts),
    inferences: targetPackets.flatMap((packet) => packet.inferences),
    gaps: targetPackets.flatMap((packet) => packet.gaps),
    evidence: targetPackets.flatMap((packet) => packet.evidence),
    observations: targetPackets.flatMap((packet) => packet.observations),
  };
}
