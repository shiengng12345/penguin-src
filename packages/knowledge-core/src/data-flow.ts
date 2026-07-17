import type { KnowledgeStore } from "./store.js";
import { SourceStore } from "./source-store.js";
import type { SearchLocator } from "@penguin/knowledge-contracts";

export interface DataFlowRequest { snapshotId: string; filePath: string; variable: string; maxSteps?: number; }
export interface DataFlowStep { kind: "definition" | "use" | "return" | "call"; variable: string; expression: string; line: number; locator: { revisionId: string; filePath: string; startLine: number; endLine: number }; evidence: "verified"; }
export interface DataFlowResult { status: "found" | "source_unavailable" | "not_found"; variable: string; steps: DataFlowStep[]; gaps: string[]; }

export interface GraphEndpoint { kind: "variable" | "field" | "call" | "return"; name: string; locator: SearchLocator; }
export interface DataFlowPath {
  source: GraphEndpoint;
  sink: GraphEndpoint;
  steps: Array<{ kind: "assign" | "argument" | "return" | "field" | "guard" | "call"; locator: SearchLocator; status: "verified" | "candidate"; expression: string }>;
  truncated: boolean;
  gaps: string[];
}

export interface DataFlowPathRequest extends DataFlowRequest { maxNodes?: number; }

function pathLocator(store: KnowledgeStore, snapshotId: string, filePath: string, line: number): SearchLocator {
  const row = store.db.prepare("SELECT sf.repo_id AS repoId,r.name AS repoName FROM effective_snapshot_sources e JOIN source_facts sf ON sf.id=e.source_fact_id JOIN repos r ON r.id=sf.repo_id WHERE e.snapshot_id=? AND e.file_path=? LIMIT 1").get(snapshotId, filePath) as { repoId: string; repoName: string } | undefined;
  return { repoId: row?.repoId ?? "unknown", repoName: row?.repoName ?? "unknown", revisionId: snapshotId, revisionKind: "commit", filePath, startLine: line, endLine: line, offsetEncoding: "utf8_normalized" };
}

/**
 * Bounded intra-procedural SSA-lite trace. Every verified step is text-backed
 * in the requested revision; an ordinary call is a candidate boundary unless
 * a resolver has supplied a verified edge, so this function never invents an
 * inter-procedural fact.
 */
export function traceDataFlowPath(store: KnowledgeStore, request: DataFlowPathRequest): DataFlowPath | null {
  const source = new SourceStore(store).getEffectiveSource(request.snapshotId, request.filePath);
  if (!source?.decodedContent) return null;
  const variable = request.variable.trim();
  if (!variable) return null;
  const lines = source.decodedContent.split(/\r?\n/);
  const tracked = new Set([variable]);
  const steps: DataFlowPath["steps"] = [];
  const gaps: string[] = [];
  const maxSteps = Math.max(1, Math.min(request.maxSteps ?? 100, request.maxNodes ?? 200));
  let sourceEndpoint: GraphEndpoint | undefined;
  const add = (kind: DataFlowPath["steps"][number]["kind"], line: number, expression: string, name: string, status: "verified" | "candidate" = "verified", endpointKind: GraphEndpoint["kind"] = "variable") => {
    if (steps.length >= maxSteps) return false;
    const locator = pathLocator(store, request.snapshotId, request.filePath, line);
    steps.push({ kind, locator, status, expression: expression.trim() });
    sourceEndpoint ??= { kind: endpointKind, name: variable, locator };
    return true;
  };
  const containsTracked = (text: string) => [...tracked].some((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`).test(text));
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const text = raw.trim();
    if (!text || text.startsWith("//")) continue;
    const destructure = text.match(/^const\s*\{\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*\}\s*=\s*(.+)$/);
    if (destructure && (tracked.has(destructure[1]) || containsTracked(destructure[3]))) {
      const next = destructure[2] ?? destructure[1]; tracked.add(next); add("field", line, text, next); continue;
    }
    const assignment = text.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
    if (assignment && containsTracked(assignment[2])) {
      tracked.add(assignment[1]);
      add("assign", line, assignment[2], assignment[1]);
      const assignedCall = assignment[2].match(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(([^)]*)\)/);
      if (assignedCall && containsTracked(assignedCall[2])) { add("argument", line, text, assignedCall[1], "candidate", "call"); gaps.push(`opaque call boundary at ${request.filePath}:${line} (${assignedCall[1]})`); }
      continue;
    }
    const parameter = text.match(/^(?:function\s+[\w$]+|(?:async\s+)?\([^)]*\)\s*=>)[^{]*\(([^)]*)\)/);
    if (parameter && parameter[1].split(",").map((item) => item.trim()).includes(variable)) add("assign", line, parameter[1], variable);
    const objectField = text.match(/([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/);
    if (objectField && tracked.has(objectField[2])) { add("field", line, text, objectField[1]); tracked.add(objectField[1]); continue; }
    if (/^(?:if|while|switch|assert|invariant|validate|isValid|guard)\b/i.test(text) && containsTracked(text)) { add("guard", line, text, variable); continue; }
    if (/^return\b/.test(text) && containsTracked(text)) { add("return", line, text, variable, "verified", "return"); continue; }
    if (/^(?:throw\b|(?:return\s+)?(?:new\s+)?(?:Error|reject)\b)/.test(text) && containsTracked(text)) { add("call", line, text, variable, "verified", "call"); continue; }
    const call = text.match(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(([^)]*)\)/);
    if (call && containsTracked(call[2])) { add("argument", line, text, call[1], "candidate", "call"); gaps.push(`opaque call boundary at ${request.filePath}:${line} (${call[1]})`); continue; }
    if (containsTracked(text) && steps.length === 0) add("assign", line, text, variable);
  }
  if (!steps.length || !sourceEndpoint) return null;
  const last = steps.at(-1)!;
  const sinkKind: GraphEndpoint["kind"] = last.kind === "return" ? "return" : last.kind === "call" || last.kind === "argument" ? "call" : last.kind === "field" ? "field" : "variable";
  const sink = { kind: sinkKind, name: variable, locator: last.locator } satisfies GraphEndpoint;
  return { source: sourceEndpoint, sink, steps, truncated: steps.length >= maxSteps, gaps: [...new Set(gaps)] };
}

/** Bounded lexical data-flow for unsupported languages and parser gaps. It is
 * deliberately a source-trace lane, not a claim of whole-program semantics. */
export function traceDataFlow(store: KnowledgeStore, request: DataFlowRequest): DataFlowResult {
  const source = new SourceStore(store).getEffectiveSource(request.snapshotId, request.filePath);
  if (!source?.decodedContent) return { status: "source_unavailable", variable: request.variable, steps: [], gaps: ["revision content unavailable"] };
  const variable = request.variable.trim();
  if (!variable) return { status: "not_found", variable, steps: [], gaps: ["variable is empty"] };
  const steps: DataFlowStep[] = [];
  const lines = source.decodedContent.split(/\r?\n/);
  const add = (kind: DataFlowStep["kind"], line: number, expression: string) => { if (steps.length < (request.maxSteps ?? 100)) steps.push({ kind, variable, expression: expression.trim(), line, locator: { revisionId: request.snapshotId, filePath: request.filePath, startLine: line, endLine: line }, evidence: "verified" }); };
  for (const [index, text] of lines.entries()) {
    const line = index + 1;
    const definition = text.match(new RegExp(`(?:const|let|var)\\s+${variable}\\s*=\\s*(.+)`));
    if (definition) add("definition", line, definition[1]);
    else if (new RegExp(`\\breturn\\s+${variable}\\b`).test(text)) add("return", line, text);
    else if (new RegExp(`\\b${variable}\\s*\\(`).test(text)) add("call", line, text);
    else if (new RegExp(`\\b${variable}\\b`).test(text)) add("use", line, text);
  }
  return { status: steps.length ? "found" : "not_found", variable, steps, gaps: steps.length ? [] : ["no bounded lexical definition or use found"] };
}
