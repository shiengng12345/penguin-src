import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeStore } from "@penguin/knowledge-core";
import { indexNote, parseNote, type ParsedNote } from "./notes.js";

export interface EvidenceTarget { targetId: string; environment: string; aliases: string[]; regionId: string; project: string; logstore: string; services: string[]; enabled: boolean; source: string }
export interface EvidenceClaim { claimId: string; statement: string; targetId?: string; evidenceIds: string[] }
export interface EvidenceGap { gapId: string; code: string; message: string; targetId?: string; evidenceIds: string[] }
export interface EvidenceObservation { observationId: string; targetId: string; sourceTimestamp?: string; traceId?: string; requestId?: string; raw: Record<string, unknown>; evidenceIds: string[] }
export interface EvidenceProvenance { evidenceId: string; source: string; targetId?: string; queryHash?: string; repoId?: string; commitSha?: string; snapshotId?: string; trust?: string }
export interface TargetEvidencePacket {
  target: EvidenceTarget;
  topicHash: string;
  question: string;
  result: { queryStatus: string; rows?: Array<Record<string, unknown>>; warnings?: string[] };
  codeFacts: EvidenceClaim[];
  wikiFacts: EvidenceClaim[];
  slsFacts: EvidenceClaim[];
  inferences: EvidenceClaim[];
  gaps: EvidenceGap[];
  evidence: EvidenceProvenance[];
  observations: EvidenceObservation[];
}
export interface EvidenceHashes { topicHash: string; queryHashes: string[]; evidenceHash: string }
export type EvidenceCaptureStatus = "created" | "updated" | "duplicate_observed" | "written_not_indexed" | "failed";
export interface EvidenceDocument {
  id: string; title: string; target: EvidenceTarget; topicHash: string; lastEvidenceHash: string;
  firstSeen: string; lastSeen: string; observationCount: number; status: "draft" | "reviewed" | "verified" | "resolved" | "archived";
  codeFacts: EvidenceClaim[]; wikiFacts: EvidenceClaim[]; slsFacts: EvidenceClaim[]; inferences: EvidenceClaim[]; gaps: EvidenceGap[]; observations: EvidenceObservation[]; evidence: EvidenceProvenance[];
}
export type EvidenceCaptureResult =
  | { status: Exclude<EvidenceCaptureStatus, "failed">; targetId: string; topicHash: string; evidenceHash: string; slug: string; path: string; nodeId?: string; identityKey?: string; observationCount: number; searchable: boolean; warnings: string[] }
  | { status: "failed"; targetId: string; topicHash: string; searchable: false; warnings: string[]; reason: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function safeSlug(targetId: string, topicHash: string): string { return `evidence-${targetId.replace(/[^a-zA-Z0-9_-]+/g, "-")}-${topicHash.slice(0, 16)}`; }
function parseExisting(source: string): { frontmatter: Record<string, string>; observations: EvidenceObservation[]; evidenceHash?: string; count: number } {
  const parsed = parseNote({ path: "evidence.md", source });
  const frontmatter: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.frontmatter)) frontmatter[key] = String(value);
  const observations: EvidenceObservation[] = [];
  for (const match of parsed.body.matchAll(/### Observation\s+([^\n]+)\n```json\n([\s\S]*?)\n```/g)) {
    try { observations.push(JSON.parse(match[2]) as EvidenceObservation); } catch { /* keep malformed historical body readable */ }
  }
  return { frontmatter, observations, evidenceHash: frontmatter.evidence_hash, count: Number(frontmatter.observation_count ?? observations.length) || 0 };
}

export function computeEvidenceHashes(packet: TargetEvidencePacket): EvidenceHashes {
  return { topicHash: packet.topicHash, queryHashes: packet.evidence.flatMap((evidence) => evidence.queryHash ? [evidence.queryHash] : []).sort(), evidenceHash: sha({ target: packet.target, facts: [packet.codeFacts, packet.wikiFacts, packet.slsFacts, packet.inferences], gaps: packet.gaps, observations: packet.observations }) };
}

export function mergeEvidenceDocument(existing: ParsedNote | null, packet: TargetEvidencePacket): EvidenceDocument {
  const hashes = computeEvidenceHashes(packet);
  const current = existing ? parseExisting(["---", ...Object.entries(existing.frontmatter).map(([key, value]) => `${key}: ${String(value)}`), "---", existing.body].join("\n")) : null;
  const now = new Date().toISOString();
  const priorObservations = current?.observations ?? [];
  const duplicate = current?.evidenceHash === hashes.evidenceHash;
  const observations = duplicate ? priorObservations : [...priorObservations, ...packet.observations.filter((candidate) => !priorObservations.some((prior) => prior.observationId === candidate.observationId))];
  return {
    id: current?.frontmatter.id ?? `evidence_${randomUUID()}`,
    title: current?.frontmatter.title ?? `Evidence ${packet.target.targetId} ${packet.topicHash.slice(0, 8)}`,
    target: packet.target,
    topicHash: hashes.topicHash,
    lastEvidenceHash: hashes.evidenceHash,
    firstSeen: current?.frontmatter.first_seen ?? now,
    lastSeen: now,
    observationCount: (current?.count ?? 0) + packet.observations.length,
    status: (current?.frontmatter.status as EvidenceDocument["status"] | undefined) ?? "draft",
    codeFacts: packet.codeFacts, wikiFacts: packet.wikiFacts, slsFacts: packet.slsFacts, inferences: packet.inferences, gaps: packet.gaps, observations, evidence: packet.evidence,
  };
}

export function renderEvidenceMarkdown(document: EvidenceDocument): string {
  const f = document.target;
  const frontmatter = [
    `id: ${document.id}`, `title: ${document.title}`, "type: evidence", `status: ${document.status}`,
    `target_id: ${f.targetId}`, `environment: ${f.environment}`, `region: ${f.regionId}`, `project: ${f.project}`, `logstore: ${f.logstore}`,
    `topic_hash: ${document.topicHash}`, `evidence_hash: ${document.lastEvidenceHash}`, `first_seen: ${document.firstSeen}`, `last_seen: ${document.lastSeen}`, `observation_count: ${document.observationCount}`,
    "sensitive: true", "mcp_access: allowed",
  ].join("\n");
  const claims = (title: string, items: EvidenceClaim[]) => [ `## ${title}`, ...(items.length ? items.map((item) => `- ${item.statement} [evidence: ${item.evidenceIds.join(", ")}]`) : ["_(none)_"]), "" ];
  const fence = "```";
  const observations = ["## Observations", ...(document.observations.length ? document.observations.map((observation) => `### Observation ${observation.observationId}\n${fence}json\n${JSON.stringify(observation, null, 2)}\n${fence}`) : ["_(none)_"]), ""];
  const gaps = ["## Evidence Gaps", ...(document.gaps.length ? document.gaps.map((gap) => `- **${gap.code}**: ${gap.message}`) : ["_(none)_"]), ""];
  return `---\n${frontmatter}\n---\n\n# ${document.title}\n\n## Scope\n- target: ${f.targetId}\n- environment: ${f.environment}\n- region: ${f.regionId}\n- project: ${f.project}\n- logstore: ${f.logstore}\n\n${claims("Verified Knowledge/Code Facts", document.codeFacts)}${claims("Verified Wiki Facts", document.wikiFacts)}${claims("Verified SLS Facts", document.slsFacts)}${claims("Inferences", document.inferences)}${gaps.join("\n")}\n${observations.join("\n")}Related evidence: ${document.evidence.map((item) => item.evidenceId).join(", ")}\n`;
}

function indexEvidence(store: KnowledgeStore, path: string, source: string): string {
  return indexNote({ store, repoRelPath: path, parsed: parseNote({ path, source }) }).nodeId;
}

export function upsertEvidenceNote(input: { store: KnowledgeStore; notesDir: string; packet: TargetEvidencePacket; now?: Date }): EvidenceCaptureResult {
  const hashes = computeEvidenceHashes(input.packet);
  const slug = safeSlug(input.packet.target.targetId, hashes.topicHash);
  const path = join(input.notesDir, `${slug}.md`);
  mkdirSync(input.notesDir, { recursive: true });
  const lockPath = join(input.notesDir, `${slug}.lock`);
  let lockFd: number | undefined;
  try {
    lockFd = openSync(lockPath, "wx", 0o600);
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const existingSource = existsSync(path) ? readFileSync(path, "utf8") : null;
    const existingParsed = existingSource ? parseNote({ path: `${slug}.md`, source: existingSource }) : null;
    const existing = existingSource ? parseExisting(existingSource) : null;
    const document = mergeEvidenceDocument(existingParsed, input.packet);
    const status: EvidenceCaptureStatus = existing == null ? "created" : existing.evidenceHash === hashes.evidenceHash ? "duplicate_observed" : "updated";
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const source = renderEvidenceMarkdown(document);
    writeFileSync(temporary, source, { mode: 0o600 });
    const fd = openSync(temporary, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    let nodeId: string | undefined;
    let searchable = false;
    try { nodeId = indexEvidence(input.store, `${slug}.md`, source); searchable = true; } catch { /* Markdown remains durable */ }
    return { status: searchable ? status : "written_not_indexed", targetId: input.packet.target.targetId, topicHash: hashes.topicHash, evidenceHash: hashes.evidenceHash, slug, path, ...(nodeId ? { nodeId } : {}), observationCount: document.observationCount, searchable, warnings: searchable ? [] : ["Markdown written but SQLite indexing failed"] };
  } catch (error) {
    return { status: "failed", targetId: input.packet.target.targetId, topicHash: hashes.topicHash, searchable: false, warnings: [], reason: String((error as Error).message ?? error) };
  } finally {
    if (lockFd !== undefined) closeSync(lockFd);
    try { unlinkSync(lockPath); } catch { /* already removed */ }
  }
}
