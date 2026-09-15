// useBrokerConnections — the single source of truth for the connection list
// and which one is "active".
//
// The active connection is a UI concept only (every Tauri broker command
// takes `connectionId` explicitly — see commands.rs's file header), but it
// still needs to survive a webview reload, so it is persisted through the
// same SQLite-backed `app_kv` bridge every other cross-session UI
// preference uses (`src/lib/app-persistence.ts`), under
// `broker.activeConnectionId`. Whenever it changes, `testConnection` is
// re-run so the connection list's status/version columns reflect the
// connection an operator is about to act on rather than stale data from
// whenever it was last tested.
import { useCallback, useEffect, useState } from "react";
import type { BrokerConnection, BrokerConnectionDraft } from "@penguin/broker-contracts";
import { deleteConnection, listConnections, testConnection, upsertConnection } from "@/lib/broker-client";
import { getPersistedValue, setPersistedValue, deletePersistedValue } from "@/lib/app-persistence";
import type { DataTableState } from "@/components/ui/data-table-types";

const ACTIVE_CONNECTION_KEY = "broker.activeConnectionId";

export interface UseBrokerConnectionsResult {
  connections: BrokerConnection[];
  activeId: string | null;
  setActive: (id: string | null) => void;
  save: (draft: BrokerConnectionDraft, id?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  test: (id: string) => Promise<void>;
  state: DataTableState;
  error?: string;
}

export function useBrokerConnections(): UseBrokerConnectionsResult {
  const [connections, setConnections] = useState<BrokerConnection[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(() =>
    getPersistedValue(ACTIVE_CONNECTION_KEY),
  );
  const [state, setState] = useState<DataTableState>("loading");
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const rows = await listConnections();
      setConnections(rows);
      setError(undefined);
      setState(rows.length === 0 ? "empty" : "ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setActive = useCallback((id: string | null) => {
    setActiveIdState(id);
    if (id) {
      setPersistedValue(ACTIVE_CONNECTION_KEY, id);
    } else {
      deletePersistedValue(ACTIVE_CONNECTION_KEY);
    }
  }, []);

  // Re-probe whenever the active connection changes — a fresh status/version
  // reading for the connection an operator is about to act against, not
  // whatever was last measured.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void testConnection(activeId)
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) void refresh();
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, refresh]);

  const save = useCallback(
    async (draft: BrokerConnectionDraft, id?: string) => {
      const existing = id ? connections.find((c) => c.id === id) : undefined;
      const connectionId = existing?.id ?? id ?? crypto.randomUUID();
      await upsertConnection(connectionId, draft, existing);
      await refresh();
    },
    [connections, refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteConnection(id);
      if (activeId === id) setActive(null);
      await refresh();
    },
    [activeId, refresh, setActive],
  );

  const test = useCallback(
    async (id: string) => {
      await testConnection(id);
      await refresh();
    },
    [refresh],
  );

  return { connections, activeId, setActive, save, remove, test, state, error };
}
