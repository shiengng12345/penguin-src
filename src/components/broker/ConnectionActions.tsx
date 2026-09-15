// ConnectionActions — wires ConnectionTable + ConnectionForm to whatever
// `useBrokerConnections` state the caller hands it, so a page mounting the
// broker connections surface only needs to render this one component.
//
// Takes that state as props rather than calling the hook itself: the hook's
// own header calls it "the single source of truth for the connection list",
// and `BrokerPage` also needs the active connection's tenant/namespace to
// drive `TopicTable`. Two independent hook instances (one here, one in
// BrokerPage) would each fetch and hold their own copy, so a connection
// added/edited/activated on this screen would not be visible to the Topics
// tab until something forced a second fetch. Lifting the hook to BrokerPage
// and passing its result down keeps there being exactly one.
import { useState } from "react";
import type { BrokerConnection, BrokerConnectionDraft } from "@penguin/broker-contracts";
import type { UseBrokerConnectionsResult } from "@/hooks/useBrokerConnections";
import { ConnectionTable } from "./ConnectionTable";
import { ConnectionForm } from "./ConnectionForm";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Strips the fields the backend owns (id, measured status/version,
 *  timestamps) down to what the form edits — the mirror of what
 *  `broker-client.ts`'s `upsertConnection` adds back before the IPC call. */
function toDraft(connection: BrokerConnection): BrokerConnectionDraft {
  const {
    id: _id,
    lastStatus: _lastStatus,
    lastCheckedAt: _lastCheckedAt,
    brokerVersion: _brokerVersion,
    capabilities: _capabilities,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...draft
  } = connection;
  return draft;
}

export type ConnectionActionsProps = Pick<
  UseBrokerConnectionsResult,
  "connections" | "activeId" | "setActive" | "save" | "remove" | "test" | "state" | "error"
>;

export function ConnectionActions({
  connections,
  activeId,
  setActive,
  save,
  remove,
  test,
  state,
  error,
}: ConnectionActionsProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const editingConnection = editingId ? connections.find((c) => c.id === editingId) ?? null : null;

  function openCreate() {
    setEditingId(null);
    setFormOpen(true);
  }

  function openEdit(id: string) {
    setEditingId(id);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
  }

  async function handleSave(draft: BrokerConnectionDraft) {
    await save(draft, editingId ?? undefined);
    closeForm();
  }

  function confirmDelete(id: string) {
    setPendingDeleteId(id);
  }

  async function handleConfirmedDelete() {
    if (!pendingDeleteId) return;
    await remove(pendingDeleteId);
    setPendingDeleteId(null);
  }

  const pendingDeleteName = connections.find((c) => c.id === pendingDeleteId)?.name ?? "";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button type="button" onClick={openCreate}>
          Add connection
        </Button>
      </div>

      <ConnectionTable
        connections={connections}
        activeId={activeId}
        state={state}
        errorMessage={error}
        onTest={test}
        onEdit={openEdit}
        onDelete={confirmDelete}
        onSetActive={setActive}
      />

      <Dialog open={formOpen} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent onClose={closeForm}>
          <DialogHeader>
            <DialogTitle>{editingConnection ? "Edit connection" : "Add connection"}</DialogTitle>
          </DialogHeader>
          <ConnectionForm
            initial={editingConnection ? toDraft(editingConnection) : undefined}
            onSave={handleSave}
            onCancel={closeForm}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={pendingDeleteId !== null} onOpenChange={(open) => !open && setPendingDeleteId(null)}>
        <DialogContent onClose={() => setPendingDeleteId(null)}>
          <DialogHeader>
            <DialogTitle>Delete connection</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Delete {pendingDeleteName || "this connection"}? Its keychain entry is removed too — this
            cannot be undone.
          </p>
          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="outline" onClick={() => setPendingDeleteId(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={handleConfirmedDelete}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
