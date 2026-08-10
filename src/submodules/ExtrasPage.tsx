import { ArrowLeft, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { submodules } from "./registry";
import { submoduleAvailability } from "./availability";
import { useSubmoduleStore } from "./submodule-store";

// The "Extras" surface — a full page in the content area (not a modal), opened
// from the top-left penguin icon. Master (tile grid) → detail (the selected
// submodule's component) within the same page. Layered above the current
// primary module; closing returns to it without touching activeModule.
export function ExtrasPage() {
  const selectedId = useSubmoduleStore((s) => s.selectedId);
  const selectSubmodule = useSubmoduleStore((s) => s.selectSubmodule);
  const clearSelection = useSubmoduleStore((s) => s.clearSelection);
  const closeLauncher = useSubmoduleStore((s) => s.closeLauncher);

  const selected = selectedId ? submodules.find((d) => d.id === selectedId) ?? null : null;

  return (
    <section className="flex h-full flex-col bg-background">
      {/* Header row */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border/60 px-6 py-3">
        {selected ? (
          <button
            type="button"
            onClick={clearSelection}
            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Extras
          </button>
        ) : (
          <div>
            <h1 className="text-sm font-semibold text-foreground">Extras</h1>
            <p className="text-[11px] text-muted-foreground">Experimental add-ons</p>
          </div>
        )}
        <button
          type="button"
          onClick={closeLauncher}
          title="Close Extras"
          aria-label="Close Extras"
          className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {selected && selected.component ? (
          <selected.component onClose={clearSelection} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {submodules.map((def) => {
              const { available, reason } = submoduleAvailability(def);
              const status = def.useStatus?.();
              return (
                <button
                  key={def.id}
                  type="button"
                  disabled={!available}
                  onClick={() => available && selectSubmodule(def.id)}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border border-border p-4 text-left transition-colors",
                    available
                      ? "hover:border-primary/40 hover:bg-accent/40"
                      : "cursor-not-allowed opacity-50",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xl">{def.icon}</span>
                    <span className="text-sm font-medium text-foreground">{def.title}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">{def.description}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {def.availability?.experimental && <Badge variant="secondary">Experimental</Badge>}
                    {def.availability?.platforms?.map((p) => (
                      <Badge key={p} variant="outline">
                        {p}
                      </Badge>
                    ))}
                    {status && status !== "disabled" && (
                      <span
                        className={cn(
                          "text-[10px] font-medium",
                          status === "running" && "text-emerald-500",
                          status === "paused" && "text-amber-500",
                          status === "error" && "text-red-500",
                        )}
                      >
                        ● {status}
                      </span>
                    )}
                    {!available && reason && (
                      <span className="text-[10px] text-muted-foreground">{reason}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
