import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export const KIND_COLOR: Record<string, string> = {
  note: "#34d399", file: "#f59e0b", endpoint: "#fb7185", entity: "#e879f9", symbol: "#7c8db5",
};

export function Center({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">{children}</div>;
}

export function TabBtn({ on, onClick, icon, children }: { on: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={cn("flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition", on ? "bg-cyan-500/12 text-cyan-100 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.35)]" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
      {icon}{children}
    </button>
  );
}

export function RelChip({ n, label }: { n: number; label: string }) {
  return <span className="rounded-md border border-border bg-background/45 px-2 py-1 text-foreground"><b className="font-mono text-foreground">{n}</b> {label}</span>;
}

export function Dot({ t }: { t: string }) {
  return <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[t] ?? KIND_COLOR.symbol }} />;
}
