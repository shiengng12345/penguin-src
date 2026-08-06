import { GitBranch, Loader2 } from "lucide-react";
import type { ScopeBlockedError } from "@/lib/knowledge-client";

interface ScopeBlockerPanelProps {
  error: ScopeBlockedError;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}

// A checked-out branch that git/CLI resolution touched name, but the query
// itself matched no --branch/--commit/--snapshot text — pulled out of the
// CLI's own message ("checked-out branch \"<name>\" is not indexed; run
// `penguin index` ...", query-scope.ts's BRANCH_NOT_INDEXED message) instead
// of duplicating that string. Falls back to null when the shape doesn't
// match (e.g. SCOPE_NOT_FOUND has no "checked-out branch" phrasing).
function blockedBranchName(message: string): string | null {
  return message.match(/checked-out branch "([^"]+)"/)?.[1] ?? null;
}

// Phase 1B Task 8: the query-server `knowledge.cli` bridge no longer force-
// injects --allow-fallback, so an un-indexed checked-out branch now reaches
// the Wiki as a real, structured error instead of a silent fallback answer
// (Phase 1A's temporary shield). This is the actionable blocker that removal
// requires — a caller sees exactly what's blocked and why, plus a one-click
// way to opt into the fallback answer for this one query, instead of an
// opaque error banner. Rendered full-pane in place of the Context view.
//
// The retry button ONLY applies to BRANCH_NOT_INDEXED: --allow-fallback is
// consulted solely by resolveQueryScope's no-explicit-selector path
// (query-scope.ts) — every SCOPE_NOT_FOUND throw (an explicit --branch/
// --commit/--snapshot that didn't resolve, or a snapshot that no longer
// exists) happens unconditionally, before allowFallback is ever read. Retrying
// one of those with --allow-fallback would just reproduce the identical
// error, so SCOPE_NOT_FOUND renders the message with no button at all.
export function ScopeBlockerPanel({ error, onRetry, retrying, className }: ScopeBlockerPanelProps) {
  const branchNotIndexed = error.code === "BRANCH_NOT_INDEXED";
  const branchName = branchNotIndexed ? blockedBranchName(error.message) : null;
  const fallbackBranch = error.candidates[0]?.branchName;

  return (
    <div className={`flex flex-1 items-center justify-center p-8 ${className ?? ""}`}>
      <div className="max-w-lg rounded-2xl border border-amber-500/30 bg-card/85 p-6 text-center">
        <GitBranch className="mx-auto mb-4 h-8 w-8 text-amber-300" />
        <div className="text-base font-semibold text-foreground">
          {branchName ? <>Branch <span className="font-mono text-amber-200">{branchName}</span> is not indexed</> : "Scope not found"}
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {branchName
            ? "This checkout has switched to a branch Penguin hasn't indexed yet, so an answer scoped to it would be a guess."
            : error.message}
        </p>
        {branchNotIndexed && (
          <p className="mt-3 text-sm text-muted-foreground">
            Run <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[13px] text-cyan-200">penguin index</code> in this repo to index it, then retry —
            or answer from an already-indexed branch right now:
          </p>
        )}
        {error.candidates.length > 0 && (
          <ul className="mx-auto mt-3 max-w-sm space-y-1 text-left font-mono text-[11px] text-muted-foreground">
            {error.candidates.slice(0, 5).map((candidate) => (
              <li key={candidate.branchName} className="truncate">
                {candidate.branchName} @ {candidate.commitSha.slice(0, 7)}
              </li>
            ))}
          </ul>
        )}
        {branchNotIndexed && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/15 disabled:opacity-50"
          >
            {retrying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {retrying ? "Retrying…" : `Answer from ${fallbackBranch ?? "an indexed branch"} instead`}
          </button>
        )}
      </div>
    </div>
  );
}
