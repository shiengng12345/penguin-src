import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// `penguin init` drops guidance into a repo's CLAUDE.md / AGENTS.md so AI coding
// agents working there query the knowledge graph FIRST (faster + more precise
// than reading files). The block is delimited by markers and re-managed
// idempotently — safe to re-run, never touches the user's own prose around it.

const BEGIN = "<!-- BEGIN PENGUIN KNOWLEDGE (auto-managed) -->";
const END = "<!-- END PENGUIN KNOWLEDGE (auto-managed) -->";

// The managed block. Kept marker-wrapped so a re-run replaces exactly this
// region, leaving any hand-written content in the file intact.
function block(): string {
  return [
    BEGIN,
    "## Penguin Knowledge",
    "",
    "This repo is indexed by **Penguin Knowledge** (a local code knowledge graph).",
    "Before reading files to understand or change code, query it — it is faster and",
    "more precise than grep/manual reading:",
    "",
    "- `penguin context <symbol|route>` — everything needed before editing a symbol",
    "  (callers, callees, types, routes, tests, thrown errors, notes, branch status)",
    "- `penguin flow <endpoint|symbol>` — linear execution chain (endpoint→service→db→…)",
    "- `penguin affected <file>…` — blast radius of a change (impacted symbols/tests/routes)",
    "- `penguin architecture` — repo / microservice overview; `penguin services` — cross-service map",
    "- `penguin search <query>` / `penguin node <name>` — find + inspect symbols",
    "",
    "Re-index after edits with `penguin index`.",
    END,
  ].join("\n");
}

// Insert/replace the managed block in one file's content. Returns the new
// content, or null if it already matches (no write needed).
function reconcile(existing: string | null): string | null {
  const fresh = block();
  if (existing == null) return `${fresh}\n`;
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + END.length);
    const next = `${before}${fresh}${after}`;
    return next === existing ? null : next;
  }
  // No managed block yet — append it, keeping the user's content on top.
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${sep}${fresh}\n`;
}

export interface AgentGuidanceResult {
  written: string[]; // absolute paths actually written
}

// Write/refresh the Penguin block in CLAUDE.md and AGENTS.md at repoRoot.
export function writeAgentGuidance(repoRoot: string): AgentGuidanceResult {
  const written: string[] = [];
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const path = join(repoRoot, name);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    const next = reconcile(existing);
    if (next != null) {
      writeFileSync(path, next);
      written.push(path);
    }
  }
  return { written };
}
