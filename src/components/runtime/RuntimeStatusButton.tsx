// Status-bar ☕ launcher for the Runtime popover (Prevent Sleep). Lit
// (emerald) when prevent-sleep is active, dim otherwise. Positioned to
// open its panel ABOVE the button since it lives in the bottom status bar.

import { useEffect, useRef, useState } from "react";
import { Coffee } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRuntime } from "@/hooks/useRuntime";
import { RuntimePanel } from "./RuntimePanel";

export function RuntimeStatusButton() {
  const { status } = useRuntime();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const enabled = status?.prevent_sleep ?? false;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={enabled ? "Prevent Sleep · Enabled" : "Prevent Sleep · Disabled"}
        aria-label="Runtime — Prevent Sleep"
        className={cn(
          "flex items-center justify-center rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground",
          enabled ? "text-emerald-500" : "text-muted-foreground/60",
        )}
      >
        <Coffee className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-1">
          <RuntimePanel />
        </div>
      )}
    </div>
  );
}
