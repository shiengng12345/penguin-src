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
//
// `subjects` (fix round 2) names which independently-fetched list —
// tenants, namespaces — actually produced `state`. Without it, "No tenants
// found." could sit directly above a populated, rendered tenant list just
// because the *selected tenant's* namespace list happened to be empty: two
// genuinely different facts ("there are no tenants" vs. "this tenant has no
// namespaces") collapsed into one message that contradicted the screen
// underneath it. `statusMessage` below picks wording per (state, subject);
// when the subject is missing or ambiguous (both lists in the same state at
// once), it falls back to neutral text — accurate beats neutral, neutral
// beats wrong, and naming one side arbitrarily would be wrong.
import type { NamespaceSummary, TenantSummary } from "@penguin/broker-contracts";
import type { TopologySubject } from "@/hooks/useBrokerTopology";
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
  /** Which list(s) `state` describes. A single-element array picks the
   *  specific wording ("No namespaces in this tenant." vs. "No tenants
   *  found."); omitted or empty falls back to the tenant-oriented default,
   *  which is also the correct reading for the no-connection/no-tenants
   *  bootstrap case this tree starts in. */
  subjects?: TopologySubject[];
  /** Every warning attached to the current `state` — a stale/skew footnote,
   *  a broker failure's message, a malformed-namespace-entry notice, or any
   *  combination, since `useBrokerTopology` can attach more than one at
   *  once and none of them may be dropped on the way to the screen. Empty
   *  or omitted for `"ready"`/`"empty"`/`"loading"`. */
  warnings?: string[];
}

/** Resolves a single, unambiguous subject to build wording around.
 *
 *  `subjects` OMITTED entirely (the prop wasn't passed at all) defaults to
 *  `"tenants"` — the top-level list, and the only one that can be in play
 *  before a tenant is even selected, so this is also the right reading for
 *  the pre-subject bootstrap case.
 *
 *  `subjects` explicitly `[]`, or with more than one entry (both lists
 *  landed in the same state at once), is genuinely ambiguous — naming one
 *  side over the other would be arbitrary — so it resolves to `null` and
 *  the caller falls back to neutral wording instead. These two empty cases
 *  are deliberately NOT the same: a caller that knows the answer and
 *  reports "no single subject" is different from a caller that never
 *  supplied one. */
function singleSubject(subjects: TopologySubject[] | undefined): TopologySubject | null {
  if (subjects === undefined) return "tenants";
  if (subjects.length === 1) return subjects[0];
  return null;
}

/** Picks the status banner's prefix text for (state, subjects). Named
 *  wording when exactly one subject is known; neutral wording — never
 *  wrong, just less specific — when it isn't. `"partial"` always stays
 *  neutral: `combine()` only reports `"partial"` when both lists
 *  contributed (one failed, one didn't), so there is no single subject to
 *  name in the first place. */
function statusMessage(state: DataTableState, subjects: TopologySubject[] | undefined): string {
  if (state === "partial") {
    return "Showing partial results — some tenants or namespaces may be missing.";
  }
  const subject = singleSubject(subjects);
  switch (state) {
    case "loading":
      return subject ? `Loading ${subject}…` : "Loading…";
    case "empty":
      return subject === "namespaces" ? "No namespaces in this tenant." : "No tenants found.";
    case "stale":
      return subject
        ? `Showing cached ${subject} — this list may be stale.`
        : "Showing cached data — this list may be stale.";
    default:
      return "Loading…";
  }
}

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
  subjects,
  warnings,
}: TopologyTreeProps) {
  return (
    <div className="flex flex-col gap-1">
      <StatusRegion state={state} subjects={subjects} warnings={warnings} />
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

function StatusRegion({
  state,
  subjects,
  warnings = [],
}: {
  state: DataTableState;
  subjects?: TopologySubject[];
  warnings?: string[];
}) {
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

  const message = statusMessage(state, subjects);
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
