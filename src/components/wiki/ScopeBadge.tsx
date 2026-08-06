import { cn } from "@/lib/utils";
import type { KnowledgeLocator, ScopeAlignment, StructuredWarning } from "@/lib/knowledge-client";

interface ScopeBadgeProps {
  locator?: KnowledgeLocator | null;
  alignment?: ScopeAlignment | null;
  warnings?: StructuredWarning[] | null;
  className?: string;
}

// The CLI bridge falls back to whatever revision it can actually answer from
// (branch checked out locally but never indexed) instead of failing outright.
// That's the right call for availability, but it means an answer can silently
// come from a different branch than the one the user is looking at — this is
// the one warning code that earns its own inline sentence instead of just a
// tooltip line.
const BRANCH_NOT_INDEXED_FALLBACK = "BRANCH_NOT_INDEXED_FALLBACK";

// One-line scope/trust summary for every Context Pack, flow, graph, and
// search answer: which repo@branch/commit actually produced this result, so
// a fallback or stale-index answer never masquerades as a clean hit on the
// currently open code. Neutral (slate) when the bridge answered from exactly
// the scope it was asked for; amber — plus a tooltip listing every warning
// message — when it fell back or reported anything else worth a second look.
// Renders nothing when `locator` is absent (unscoped legacy results).
export function ScopeBadge({ locator, alignment, warnings, className }: ScopeBadgeProps) {
  if (!locator) return null;
  const list = warnings ?? [];
  const isWarning = alignment === "fallback" || list.length > 0;
  const sha7 = locator.commitSha ? locator.commitSha.slice(0, 7) : null;
  const branchLabel = locator.branchName ?? locator.branchId ?? "?";
  const tooltip = list.length > 0 ? list.map((w) => w.message).join("\n") : undefined;
  const branchNotIndexed = list.some((w) => w.code === BRANCH_NOT_INDEXED_FALLBACK);

  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]", isWarning ? "text-amber-300" : "text-muted-foreground", className)}
      title={tooltip}
    >
      <span className="flex items-center gap-1.5">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", isWarning ? "bg-amber-400" : "bg-emerald-400")} />
        <span className="font-mono">
          {locator.repoName}@{branchLabel}{sha7 ? ` ${sha7}` : ""} ({locator.worktreeState})
        </span>
      </span>
      {branchNotIndexed && (
        <span className="text-amber-300">answering from {branchLabel} — your checkout is not indexed</span>
      )}
    </div>
  );
}
