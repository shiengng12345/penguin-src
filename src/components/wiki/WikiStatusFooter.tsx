import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { knowledgeStatusPanel, type RepoStatusPanel, type StatusPanel } from "@/lib/knowledge-client";

interface WikiStatusFooterProps {
  // Which repo's row to render, when the caller knows the current repo
  // context (e.g. a repo/branch selected in the browse tree). Falls back to
  // the first repo in the panel — fine for the common single-repo case.
  repoId?: string;
}

const POLL_INTERVAL_MS = 30_000;

const REVISION_LABEL: Record<RepoStatusPanel["revisionAlignment"], string> = {
  aligned: "Aligned",
  behind: "Behind",
  branch_not_indexed: "Branch not indexed",
  git_unavailable: "Git unavailable",
};

// Homegrown relative time — "3m ago", "2h ago", "5d ago". No new deps; this
// footer polls often enough that Intl.RelativeTimeFormat would be overkill.
function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "never";
  const ms = Date.now() - then;
  if (ms < 0) return "just now"; // clock skew guard
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function pickRepo(repos: RepoStatusPanel[], repoId?: string): RepoStatusPanel | null {
  if (repos.length === 0) return null;
  if (repoId) {
    const match = repos.find((r) => r.repoId === repoId);
    if (match) return match;
  }
  return repos[0];
}

// Real status panel for the Wiki footer (replaces a hardcoded "Connected ·
// SQLite · Workspace Penguin" that lied whenever the DB was actually
// unreachable). Self-fetching: mount, every 30s, and on window focus — a
// fetch failure always renders "DB: Unavailable", never a fake green dot.
export function WikiStatusFooter({ repoId }: WikiStatusFooterProps) {
  const [panel, setPanel] = useState<StatusPanel | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchStatus = () => {
      knowledgeStatusPanel()
        .then((p) => {
          if (cancelled) return;
          setPanel(p);
          setFailed(false);
        })
        .catch(() => {
          if (cancelled) return;
          setFailed(true);
        });
    };
    fetchStatus();
    const interval = window.setInterval(fetchStatus, POLL_INTERVAL_MS);
    window.addEventListener("focus", fetchStatus);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", fetchStatus);
    };
  }, []);

  if (failed || !panel) {
    return (
      <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-slate-800 bg-[#101826] px-3 text-[11px] text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
          DB: Unavailable
        </span>
      </footer>
    );
  }

  const repo = pickRepo(panel.repos, repoId);
  const coverage = repo?.coverage ?? null;
  // null = not computed yet; {0,0,0} happens when only stale coverage rows
  // exist. Both need to avoid a bogus "0/0 looks fine" read — null gets its
  // own neutral label, an all-zero (or zero-admitted) row gets flagged the
  // same as genuinely low coverage.
  const total = coverage ? coverage.admitted + coverage.excluded + coverage.failed : 0;
  const coverageIsLow = coverage != null && (total === 0 || coverage.admitted === 0);
  const branchNotIndexed = repo?.revisionAlignment === "branch_not_indexed";

  return (
    <footer
      className="flex h-7 shrink-0 items-center gap-3 border-t border-slate-800 bg-[#101826] px-3 text-[11px] text-slate-400"
      title={repo ? `${repo.repoName} — ${repo.rootPath}` : undefined}
    >
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        DB: Connected (v{panel.db.schemaVersion})
      </span>
      {repo ? (
        <>
          <span className="text-slate-600">·</span>
          <span className={cn(branchNotIndexed ? "text-amber-300" : "text-slate-400")}>
            Revision: {REVISION_LABEL[repo.revisionAlignment]}
            {branchNotIndexed ? " — run penguin index" : null}
          </span>
          <span className="text-slate-600">·</span>
          <span className="text-slate-400">Index: {formatRelativeTime(repo.lastIndexedAt)}</span>
          <span className="text-slate-600">·</span>
          <span className={cn(coverageIsLow ? "text-amber-300" : "text-slate-400")}>
            {coverage ? `Coverage: ${coverage.admitted}/${total} files` : "Coverage: not computed"}
          </span>
        </>
      ) : (
        <span className="text-slate-600">No repo indexed</span>
      )}
    </footer>
  );
}
