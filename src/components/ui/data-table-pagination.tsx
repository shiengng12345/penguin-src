// Pagination footer for DataTable.
//
// This component never pages itself — it only reports intent via
// `onPageChange`. Paging happens in Rust, over a cached snapshot, because
// Pulsar's Admin REST ignores pagination entirely; a component that sliced
// its own rows would silently disagree with the backend's `total`.
import { Button } from "./button";

interface DataTablePaginationProps {
  offset: number;
  limit: number;
  total: number;
  onPageChange: (offset: number) => void;
}

export function DataTablePagination({ offset, limit, total, onPageChange }: DataTablePaginationProps) {
  const atFirstPage = offset === 0;
  const atLastPage = offset + limit >= total;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + limit, total);

  return (
    <div className="flex items-center justify-between border-t border-border px-3 py-2 text-sm text-muted-foreground">
      <span>
        {rangeStart}–{rangeEnd} of {total}
      </span>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Previous page"
          disabled={atFirstPage}
          onClick={() => onPageChange(Math.max(0, offset - limit))}
        >
          Previous page
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Next page"
          disabled={atLastPage}
          onClick={() => onPageChange(offset + limit)}
        >
          Next page
        </Button>
      </div>
    </div>
  );
}
