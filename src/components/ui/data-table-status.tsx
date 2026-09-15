// Status/notice region for DataTable.
//
// Five states share one contract: `loading`, `empty`, `stale`, `partial` and
// `error`. The first four share a single `role="status"` live region (only
// one such region ever exists at a time — never one per state). `error` is
// the odd one out: it gets `role="alert"` because it is not a passive notice,
// it is something the operator must notice immediately.
//
// `stale` and `partial` intentionally do NOT suppress the table body — this
// component only renders the notice text; DataTable decides whether rows
// also render alongside it. Old or incomplete data is still data an
// operator needs to see, so hiding it behind a spinner or blank state would
// be worse than marking it.
//
// Every message is plain text carrying the state in words, never conveyed by
// colour or icon alone (there is a dedicated a11y test for this upstream).
import type { DataTableState } from "./data-table-types";

interface DataTableStatusRegionProps {
  state: DataTableState;
  errorMessage?: string;
}

export function DataTableStatusRegion({ state, errorMessage }: DataTableStatusRegionProps) {
  if (state === "ready") return null;

  if (state === "error") {
    return (
      <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {errorMessage ?? "An error occurred while loading this data."}
      </div>
    );
  }

  const message = {
    loading: "Loading…",
    empty: "No rows to show.",
    stale: "Showing cached data — this list may be stale.",
    partial: "Partial results — some data may be missing.",
  }[state];

  return (
    <div role="status" className="border-b border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      {message}
    </div>
  );
}
