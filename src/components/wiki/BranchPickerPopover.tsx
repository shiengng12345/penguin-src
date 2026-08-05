import { useEffect, useRef } from "react";

// Service-graph node click, when the repo behind it has 2+ live branches:
// Core deliberately refuses to guess which one the caller meant (see
// resolveRevisionContext's "multiple live branches; pass --branch, --commit,
// or --snapshot" ambiguity), so the UI must stop silently picking
// `find(live) ?? [0]` too. This is the explicit-pick surface for that —
// anchored at the click point, closed by picking a branch, clicking outside,
// or Escape.

export interface BranchPickerOption {
  branchId: string;
  name: string;
  // KnowledgeIndexStatus's branch `status` field ("live" | "stale" | ...) —
  // kept as the raw string so a future status value renders instead of
  // silently vanishing behind a boolean.
  status: string;
  lastIndexedAt: string | null;
}

export interface BranchPickerPopoverProps {
  branches: BranchPickerOption[];
  // Viewport coordinates (clientX/clientY) of the click that opened this —
  // the popover is anchored there, clamped to stay on-screen.
  anchor: { x: number; y: number };
  onPick: (branchId: string) => void;
  onClose: () => void;
}

// Homegrown relative time ("3m ago", "2h ago", "5d ago") — mirrors
// WikiStatusFooter's formatRelativeTime. Duplicated rather than shared: it's
// three lines, and importing across these two leaf components for that isn't
// worth the coupling.
function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "never";
  const ms = Date.now() - then;
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

const POPOVER_WIDTH = 240;
const POPOVER_MAX_HEIGHT = 280;

export function BranchPickerPopover({ branches, anchor, onPick, onClose }: BranchPickerPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const left = Math.min(Math.max(8, anchor.x), window.innerWidth - POPOVER_WIDTH - 8);
  const top = Math.min(Math.max(8, anchor.y), window.innerHeight - 8);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="选择分支"
      style={{ left, top, width: POPOVER_WIDTH, maxHeight: POPOVER_MAX_HEIGHT }}
      className="fixed z-50 overflow-auto rounded-lg border border-slate-700 bg-slate-950/95 p-1 text-sm text-slate-200 shadow-2xl backdrop-blur"
    >
      <div className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-slate-500">此仓库有多个活跃分支，请选择</div>
      {branches.map((branch) => (
        <button
          key={branch.branchId}
          type="button"
          role="menuitem"
          onClick={() => onPick(branch.branchId)}
          className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-cyan-500/10"
        >
          <span className="min-w-0 truncate">{branch.name}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="text-[11px] text-slate-500">{formatRelativeTime(branch.lastIndexedAt)}</span>
            <span
              className={
                branch.status === "live"
                  ? "rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300"
                  : "rounded bg-slate-700/40 px-1.5 py-0.5 text-[10px] text-slate-400"
              }
            >
              {branch.status === "live" ? "live" : "stale"}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
