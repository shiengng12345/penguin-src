// ConnectionTable — lists saved broker connections.
//
// Deliberately does NOT reuse `DataTable`'s virtualised row engine: that
// component's row markup (`src/components/ui/data-table.tsx`) has no seam
// for a per-row DOM attribute, and this table must stamp `aria-current` on
// the active connection's row. A handful of saved connections also never
// needs virtualisation the way a topic or message list does. What IS reused
// is `DataTableStatusRegion` — the same five-state contract (`loading`,
// `empty`, `stale`, `partial`, `error`) other broker surfaces use, so a
// connection list marks its state in text exactly the same way.
//
// `lastStatus` and `brokerVersion` are rendered as plain text, never colour
// alone, and a connection that has not been tested shows "Unknown" /
// "Not measured" rather than a guess — this project's spec forbids
// presenting inference as fact (see CapabilitySnapshot.canWriteProbed for
// the same principle applied to write capability).
import type { ReactNode } from "react";
import type { BrokerConnection, ConnectionStatus } from "@penguin/broker-contracts";
import { DataTableStatusRegion } from "@/components/ui/data-table-status";
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
  const showTable = state !== "error";

  return (
    <div className="flex flex-col rounded-md border border-border" data-state={state}>
      <DataTableStatusRegion state={state} errorMessage={errorMessage} />

      {showTable && connections.length > 0 && (
        <div role="table" aria-rowcount={connections.length} className="min-w-full text-sm">
          <div role="row" className="flex items-stretch border-b border-border bg-muted/60 font-medium">
            <HeaderCell>Name</HeaderCell>
            <HeaderCell>Status</HeaderCell>
            <HeaderCell>Version</HeaderCell>
            <HeaderCell>Access</HeaderCell>
            <HeaderCell wide>Actions</HeaderCell>
          </div>

          {connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              active={connection.id === activeId}
              onTest={onTest}
              onEdit={onEdit}
              onDelete={onDelete}
              onSetActive={onSetActive}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionRow({
  connection,
  active,
  onTest,
  onEdit,
  onDelete,
  onSetActive,
}: {
  connection: BrokerConnection;
  active: boolean;
  onTest: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onSetActive: (id: string) => void;
}) {
  return (
    <div
      role="row"
      aria-current={active ? "true" : undefined}
      className={active ? "flex items-stretch border-b border-border bg-accent/40" : "flex items-stretch border-b border-border"}
    >
      <Cell>{connection.name}</Cell>
      <Cell>{STATUS_LABELS[connection.lastStatus]}</Cell>
      <Cell>{connection.brokerVersion ?? "Not measured"}</Cell>
      <Cell>
        {connection.readOnly ? (
          <Badge variant="secondary">Read-only</Badge>
        ) : (
          <Badge variant="destructive">Read-write</Badge>
        )}
      </Cell>
      <Cell wide>
        <div className="flex flex-wrap gap-1">
          <Button type="button" size="sm" variant="outline" onClick={() => onSetActive(connection.id)}>
            {active ? "Active" : "Set active"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onTest(connection.id)}>
            Test
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onEdit(connection.id)}>
            Edit
          </Button>
          <Button type="button" size="sm" variant="destructive" onClick={() => onDelete(connection.id)}>
            Delete
          </Button>
        </div>
      </Cell>
    </div>
  );
}

function HeaderCell({ children, wide }: { children: string; wide?: boolean }) {
  return (
    <div role="columnheader" className={wide ? "flex-[2] px-2 py-2" : "flex-1 px-2 py-2"}>
      {children}
    </div>
  );
}

function Cell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div role="cell" className={wide ? "flex-[2] items-center px-2 py-2" : "flex-1 items-center px-2 py-2"}>
      {children}
    </div>
  );
}
