// TopologyTree — presentational tenant -> namespace navigation tree.
//
// Purely props-driven, same split as TopicTable/ConnectionTable: the state
// (`useBrokerTopology`) lives in a hook, this component only renders what
// it is handed and reports selections upward rather than navigating or
// fetching itself. `role="tree"` / `role="treeitem"` with `aria-selected`
// (never colour alone) so the selection is announced, and every treeitem is
// a real tab stop with its own Enter/Space handling — an operator
// mid-incident should not need the mouse.
//
// `state` reuses the shared `DataTableState` its siblings use. `stale` (and
// `partial`) deliberately do NOT hide the tree: Tasks 2-4 built a cache path
// where a stale or clock-skewed row, or a broker failure served from the
// last known cache, still carries real data — hiding it behind a notice
// would be worse than marking it. Only `loading`/`empty` render with no
// tenants to show in the first place.
import type { NamespaceSummary, TenantSummary } from "@penguin/broker-contracts";
import type { DataTableState } from "@/components/ui/data-table-types";
import { cn } from "@/lib/utils";

export interface TopologyTreeProps {
  tenants: TenantSummary[];
  namespaces: NamespaceSummary[];
  selectedTenant: string | null;
  selectedNamespace: string | null;
  onSelectTenant: (tenant: string) => void;
  onSelectNamespace: (namespace: string) => void;
  state: DataTableState;
  /** Every warning attached to the current `state` — a stale/skew footnote,
   *  a broker failure's message, a malformed-namespace-entry notice, or any
   *  combination, since `useBrokerTopology` can attach more than one at
   *  once and none of them may be dropped on the way to the screen. Empty
   *  or omitted for `"ready"`/`"empty"`/`"loading"`. */
  warnings?: string[];
}

// Subject-neutral: this tree shows two independently-sourced lists
// (tenants, namespaces), and either one can be the one that's actually
// stale — a fixed "tenants" wording here would misname the namespace list's
// own staleness (fix round 1, item 3). The specific warning text appended
// below names the actual subject; this prefix only names the state.
const STATUS_TEXT: Partial<Record<DataTableState, string>> = {
  loading: "Loading tenants…",
  empty: "No tenants found.",
  stale: "Showing cached data — this list may be stale.",
  partial: "Showing partial results — some tenants or namespaces may be missing.",
};

const ITEM_CLASS =
  "cursor-pointer rounded px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function TopologyTree({
  tenants,
  namespaces,
  selectedTenant,
  selectedNamespace,
  onSelectTenant,
  onSelectNamespace,
  state,
  warnings,
}: TopologyTreeProps) {
  return (
    <div className="flex flex-col gap-1">
      <StatusRegion state={state} warnings={warnings} />
      <div role="tree" aria-label="Tenants and namespaces" className="flex flex-col gap-0.5 text-sm">
        {tenants.map((tenant) => {
          const isSelected = tenant.name === selectedTenant;
          return (
            <div key={tenant.name} className="flex flex-col">
              <TreeRow
                label={tenant.name}
                selected={isSelected}
                onSelect={() => onSelectTenant(tenant.name)}
              />
              {isSelected && (
                <div role="group" className="ml-4 flex flex-col gap-0.5">
                  {namespaces
                    .filter((ns) => ns.tenant === tenant.name)
                    .map((ns) => (
                      <TreeRow
                        key={ns.full}
                        label={ns.name}
                        selected={ns.name === selectedNamespace}
                        onSelect={() => onSelectNamespace(ns.name)}
                      />
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface TreeRowProps {
  label: string;
  selected: boolean;
  onSelect: () => void;
}

function TreeRow({ label, selected, onSelect }: TreeRowProps) {
  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(ITEM_CLASS, selected ? "bg-accent font-medium text-accent-foreground" : "hover:bg-muted/60")}
    >
      {label}
    </div>
  );
}

function StatusRegion({ state, warnings = [] }: { state: DataTableState; warnings?: string[] }) {
  if (state === "ready") return null;

  if (state === "error") {
    return (
      <div
        role="alert"
        className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive"
      >
        {warnings.length > 0 ? warnings.join(" ") : "Failed to load tenants."}
      </div>
    );
  }

  const message = STATUS_TEXT[state] ?? "Loading…";
  return (
    <div role="status" className="rounded border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
      <p>{message}</p>
      {warnings.length > 0 && (
        <ul className="mt-0.5 list-disc pl-4">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
