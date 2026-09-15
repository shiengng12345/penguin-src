// ConnectionTable — lists saved broker connections.
//
// Built on `DataTable` (Task 16). Its row markup used to have no seam for a
// per-row DOM attribute, which is exactly what marking the active
// connection needs (`aria-current` on that row's own `role="row"` div) —
// so this component previously bypassed DataTable and hand-rolled row
// markup instead. That bypass is gone: `DataTable` now takes a `rowProps`
// prop (`src/components/ui/data-table.tsx` / `data-table-row-props.ts`)
// that merges caller-supplied attributes onto its row without losing the
// row's own role/className, and this is that seam's first real consumer.
//
// `lastStatus` and `brokerVersion` are rendered as plain text, never colour
// alone, and a connection that has not been tested shows "Unknown" /
// "Not measured" rather than a guess — this project's spec forbids
// presenting inference as fact (see CapabilitySnapshot.canWriteProbed for
// the same principle applied to write capability).
import type { HTMLAttributes } from "react";
import type { BrokerConnection, ConnectionStatus } from "@penguin/broker-contracts";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import type { DataTableState } from "@/components/ui/data-table-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface ConnectionTableProps {
  connections: BrokerConnection[];
  activeId: string | null;
  state: DataTableState;
  errorMessage?: string;
  onTest: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onSetActive: (id: string) => void;
}

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  unknown: "Unknown",
  ok: "OK",
  unreachable: "Unreachable",
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  tls_error: "TLS error",
};

export function ConnectionTable({
  connections,
  activeId,
  state,
  errorMessage,
  onTest,
  onEdit,
  onDelete,
  onSetActive,
}: ConnectionTableProps) {
  const columns: DataTableColumn<BrokerConnection>[] = [
    { key: "name", header: "Name", render: (c) => c.name },
    { key: "status", header: "Status", render: (c) => STATUS_LABELS[c.lastStatus] },
    { key: "version", header: "Version", render: (c) => c.brokerVersion ?? "Not measured" },
    {
      key: "access",
      header: "Access",
      render: (c) =>
        c.readOnly ? (
          <Badge variant="secondary">Read-only</Badge>
        ) : (
          <Badge variant="destructive">Read-write</Badge>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      width: 320,
      render: (c) => (
        <div className="flex flex-wrap gap-1">
          <Button type="button" size="sm" variant="outline" onClick={() => onSetActive(c.id)}>
            {c.id === activeId ? "Active" : "Set active"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onTest(c.id)}>
            Test
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onEdit(c.id)}>
            Edit
          </Button>
          <Button type="button" size="sm" variant="destructive" onClick={() => onDelete(c.id)}>
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={connections}
      total={connections.length}
      offset={0}
      limit={Math.max(connections.length, 1)}
      rowKey={(c) => c.id}
      state={state}
      errorMessage={errorMessage}
      // Connections aren't paged in Rust the way topics are — the whole
      // list is always in memory — so there is nothing to report here.
      onPageChange={() => {}}
      rowProps={(c): HTMLAttributes<HTMLDivElement> =>
        c.id === activeId ? { "aria-current": "true" } : {}
      }
    />
  );
}
