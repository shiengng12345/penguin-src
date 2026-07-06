import { invoke } from "@tauri-apps/api/core";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Folder,
  FolderPlus,
  Pencil,
  Plug,
  Plus,
  Search,
  Server,
  Settings,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Connection Manager (Phase 1) — the saved-connection address book.
// Grouped persistent connections + New Connection dialog (tabbed) + New Group.
// Double-click a connection → opens it into the live registry (parent gets the id).
// ---------------------------------------------------------------------------

interface SavedConnectionFull {
  id: string;
  label: string;
  group_name: string;
  conn_type: string;
  host: string;
  port: number;
  db: number;
  username: string;
  has_password: boolean;
  config_json: string;
  created_at: number;
}

interface ConnectResult {
  ok: boolean;
  id: string;
  latency_ms: number;
  error: string | null;
}

const DIALOG_TABS = [
  "General",
  "Advanced",
  "Database Alias",
  "SSL/TLS",
  "SSH Tunnel",
  "Sentinel",
  "Cluster",
  "Proxy",
] as const;
type DialogTab = (typeof DIALOG_TABS)[number];

interface DraftConnection {
  id: string | null;
  label: string;
  group_name: string;
  conn_type: string;
  host: string;
  port: number;
  db: number;
  username: string;
  password: string;
  passwordTouched: boolean;
  // Advanced (Phase 2a)
  deployment: string; // "standalone" | "sentinel" | "cluster"
  tlsEnabled: boolean;
  sentinelMaster: string;
  sentinelNodes: string;
  sentinelPassword: string;
  clusterNodes: string;
  // SSH Tunnel (Phase 2b)
  sshEnabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshAuthType: string; // "password" | "key"
  sshPassword: string;
  sshKeyPath: string;
}

function emptyDraft(): DraftConnection {
  return {
    id: null,
    label: "",
    group_name: "",
    conn_type: "tcp",
    host: "127.0.0.1",
    port: 6379,
    db: 0,
    username: "",
    password: "",
    passwordTouched: false,
    deployment: "standalone",
    tlsEnabled: false,
    sentinelMaster: "mymaster",
    sentinelNodes: "",
    sentinelPassword: "",
    clusterNodes: "",
    sshEnabled: false,
    sshHost: "",
    sshPort: 22,
    sshUsername: "",
    sshAuthType: "key",
    sshPassword: "",
    sshKeyPath: "",
  };
}

function parseNodes(text: string): Array<{ host: string; port: number }> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [host, port] = line.split(":");
      return { host: host ?? "", port: Number(port) || 6379 };
    });
}

function buildConfigJson(form: DraftConnection): string {
  return JSON.stringify({
    deployment: form.deployment,
    tls: { enabled: form.tlsEnabled },
    sentinel: {
      master: form.sentinelMaster,
      password: form.sentinelPassword,
      nodes: parseNodes(form.sentinelNodes),
    },
    cluster: { nodes: parseNodes(form.clusterNodes) },
    ssh: {
      enabled: form.sshEnabled,
      host: form.sshHost,
      port: form.sshPort,
      username: form.sshUsername,
      auth_type: form.sshAuthType,
      password: form.sshPassword,
      key_path: form.sshKeyPath,
    },
  });
}

function toDraft(connection: SavedConnectionFull): DraftConnection {
  let parsed: {
    deployment?: string;
    tls?: { enabled?: boolean };
    sentinel?: { master?: string; password?: string; nodes?: Array<{ host: string; port: number }> };
    cluster?: { nodes?: Array<{ host: string; port: number }> };
    ssh?: {
      enabled?: boolean; host?: string; port?: number;
      username?: string; auth_type?: string;
      password?: string; key_path?: string;
    };
  } = {};
  try {
    parsed = JSON.parse(connection.config_json || "{}");
  } catch {
    parsed = {};
  }
  const nodesToText = (nodes?: Array<{ host: string; port: number }>): string =>
    (nodes ?? []).map((node) => `${node.host}:${node.port}`).join("\n");
  return {
    id: connection.id,
    label: connection.label,
    group_name: connection.group_name,
    conn_type: connection.conn_type,
    host: connection.host,
    port: connection.port,
    db: connection.db,
    username: connection.username,
    password: "",
    passwordTouched: false,
    deployment: parsed.deployment ?? "standalone",
    tlsEnabled: parsed.tls?.enabled ?? false,
    sentinelMaster: parsed.sentinel?.master ?? "mymaster",
    sentinelNodes: nodesToText(parsed.sentinel?.nodes),
    sentinelPassword: parsed.sentinel?.password ?? "",
    clusterNodes: nodesToText(parsed.cluster?.nodes),
    sshEnabled: parsed.ssh?.enabled ?? false,
    sshHost: parsed.ssh?.host ?? "",
    sshPort: parsed.ssh?.port ?? 22,
    sshUsername: parsed.ssh?.username ?? "",
    sshAuthType: parsed.ssh?.auth_type ?? "key",
    sshPassword: parsed.ssh?.password ?? "",
    sshKeyPath: parsed.ssh?.key_path ?? "",
  };
}

export function RedisConnectionManager({
  activeLiveId,
  onOpened,
}: {
  activeLiveId: string | null;
  onOpened: (liveId: string) => void;
}): ReactElement {
  const [connections, setConnections] = useState<SavedConnectionFull[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<DraftConnection | null>(null);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  // DIAGNOSTIC: surface open failures instead of a silent no-op on double-click.
  const [openError, setOpenError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const exportConfig = useCallback(async () => {
    const json = await invoke<string>("redis_conn_export").catch(() => null);
    if (json === null) {
      setStatusMsg("导出失败");
      return;
    }
    await navigator.clipboard.writeText(json).catch(() => {});
    setStatusMsg("✅ 配置已复制到剪贴板（不含密码）");
  }, []);

  const reload = useCallback(async () => {
    const [conns, grps] = await Promise.all([
      invoke<SavedConnectionFull[]>("redis_conn_list_full").catch(() => []),
      invoke<string[]>("redis_group_list").catch(() => []),
    ]);
    setConnections(conns);
    setGroups(grps);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") {
      return connections;
    }
    return connections.filter((connection) =>
      connection.label.toLowerCase().includes(needle),
    );
  }, [connections, filter]);

  // Build the grouped tree: every named group (even empty) + an ungrouped root.
  const grouped = useMemo(() => {
    const byGroup = new Map<string, SavedConnectionFull[]>();
    groups.forEach((name) => byGroup.set(name, []));
    const ungrouped: SavedConnectionFull[] = [];
    filtered.forEach((connection) => {
      if (connection.group_name === "") {
        ungrouped.push(connection);
        return;
      }
      const bucket = byGroup.get(connection.group_name) ?? [];
      bucket.push(connection);
      byGroup.set(connection.group_name, bucket);
    });
    return { byGroup, ungrouped };
  }, [filtered, groups]);

  const toggleGroup = useCallback((name: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const openConnection = useCallback(
    async (connection: SavedConnectionFull) => {
      setOpeningId(connection.id);
      setOpenError(null);
      const result = await invoke<ConnectResult>("redis_conn_open", {
        id: connection.id,
      }).catch((error) => {
        return { ok: false, id: connection.id, latency_ms: 0, error: String(error) } satisfies ConnectResult;
      });
      setOpeningId(null);
      if (result.ok) {
        onOpened(result.id);
      } else {
        // WHY: a failed open used to do nothing — user saw "no reaction".
        setOpenError(`打开「${connection.label}」失败：${result.error ?? "未知错误"}`);
      }
    },
    [onOpened],
  );

  const deleteConnection = useCallback(
    async (connection: SavedConnectionFull) => {
      await invoke("redis_conn_delete", { id: connection.id }).catch(() => {});
      await reload();
    },
    [reload],
  );

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border/60">
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {/* Named groups */}
        {groups.map((name) => {
          const children = grouped.byGroup.get(name) ?? [];
          const isCollapsed = collapsed.has(name);
          return (
            <div key={name}>
              <button
                type="button"
                onClick={() => toggleGroup(name)}
                className="flex w-full items-center gap-1 px-2 py-1 text-xs text-foreground hover:bg-muted"
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                )}
                <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                <span className="truncate">{name}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  ({children.length})
                </span>
              </button>
              {!isCollapsed
                ? children.map((connection) => (
                    <ConnectionRow
                      key={connection.id}
                      connection={connection}
                      indented
                      active={connection.id === activeLiveId}
                      onOpen={() => void openConnection(connection)}
                      onEdit={() => setDraft(toDraft(connection))}
                      onDelete={() => void deleteConnection(connection)}
                    />
                  ))
                : null}
            </div>
          );
        })}

        {/* Ungrouped connections at root */}
        {grouped.ungrouped.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            active={connection.id === activeLiveId}
            onOpen={() => void openConnection(connection)}
            onEdit={() => setDraft(toDraft(connection))}
            onDelete={() => void deleteConnection(connection)}
          />
        ))}

        {connections.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            还没有连接
            <div className="mt-1">点下方 + 新建</div>
          </div>
        ) : null}
      </div>

      {openingId !== null ? (
        <div className="border-t border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
          连接中…
        </div>
      ) : null}
      {openError !== null ? (
        <div className="border-t border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300 break-all">
          {openError}
        </div>
      ) : null}
      {statusMsg !== null ? (
        <div className="border-t border-border/60 px-3 py-1.5 text-xs text-emerald-300 break-all">
          {statusMsg}
        </div>
      ) : null}

      {/* Bottom action bar */}
      <div className="flex items-center gap-1 border-t border-border/60 p-1.5">
        <button
          type="button"
          onClick={() => setDraft(emptyDraft())}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          title="新连接"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setNewGroupOpen(true)}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          title="新组"
        >
          <FolderPlus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => void exportConfig()}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          title="导出配置（复制到剪贴板）"
        >
          <Download className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          title="导入配置"
        >
          <Upload className="h-4 w-4" />
        </button>
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter"
            className="h-7 w-full rounded border border-border bg-background pl-7 pr-2 text-xs"
          />
        </div>
      </div>

      {draft !== null ? (
        <ConnectionDialog
          draft={draft}
          groups={groups}
          onClose={() => setDraft(null)}
          onSaved={async () => {
            setDraft(null);
            await reload();
          }}
        />
      ) : null}

      {newGroupOpen ? (
        <NewGroupDialog
          onClose={() => setNewGroupOpen(false)}
          onCreated={async () => {
            setNewGroupOpen(false);
            await reload();
          }}
        />
      ) : null}

      {importOpen ? (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImported={async (count) => {
            setImportOpen(false);
            setStatusMsg(`✅ 导入了 ${count} 个连接（密码需重新填写）`);
            await reload();
          }}
        />
      ) : null}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Import dialog — paste exported JSON
// ---------------------------------------------------------------------------

function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (count: number) => void;
}): ReactElement {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const doImport = useCallback(async () => {
    const count = await invoke<number>("redis_conn_import", { payload: text }).catch((err) => {
      setError(String(err));
      return null;
    });
    if (count !== null) {
      onImported(count);
    }
  }, [text, onImported]);

  return (
    <Overlay onClose={onClose}>
      <div className="w-[480px] space-y-3 rounded-lg border border-border bg-card p-5 shadow-xl">
        <div className="text-sm font-semibold">导入连接配置</div>
        <div className="text-xs text-muted-foreground">粘贴之前导出的 JSON（不含密码，导入后需重填）</div>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder='{"groups":[...],"connections":[...]}'
          className="h-48 w-full resize-none rounded border border-border bg-background p-2 font-mono text-xs"
        />
        {error !== null ? <div className="text-xs text-destructive break-all">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded border border-border px-3 text-xs hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void doImport()}
            className="h-8 rounded bg-primary px-4 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            导入
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Connection row
// ---------------------------------------------------------------------------

function ConnectionRow({
  connection,
  indented,
  active,
  onOpen,
  onEdit,
  onDelete,
}: {
  connection: SavedConnectionFull;
  indented?: boolean;
  active: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): ReactElement {
  return (
    <div
      onDoubleClick={onOpen}
      className={cn(
        "group flex cursor-pointer items-center gap-1.5 py-1 pr-2 text-xs hover:bg-muted",
        indented ? "pl-7" : "pl-3",
        active ? "bg-primary/10" : "",
      )}
      title="双击打开"
    >
      <Server className="h-3.5 w-3.5 shrink-0 text-red-400" />
      <span className="min-w-0 flex-1 truncate">{connection.label}</span>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onEdit();
        }}
        className="shrink-0 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
        title="编辑"
      >
        <Pencil className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        className="shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
        title="删除"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New / Edit connection dialog (tabbed, matches Tiny RDM)
// ---------------------------------------------------------------------------

function ConnectionDialog({
  draft,
  groups,
  onClose,
  onSaved,
}: {
  draft: DraftConnection;
  groups: string[];
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const [tab, setTab] = useState<DialogTab>("General");
  const [form, setForm] = useState<DraftConnection>(draft);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = useCallback(<K extends keyof DraftConnection>(key: K, value: DraftConnection[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  }, []);

  const test = useCallback(async () => {
    setTestResult("测试中…");
    const result = await invoke<ConnectResult>("redis_conn_test", {
      input: {
        host: form.host,
        port: form.port,
        db: form.db,
        username: form.username,
        password: form.password,
        config_json: buildConfigJson(form),
      },
    }).catch((error) => {
      return { ok: false, id: "", latency_ms: 0, error: String(error) } satisfies ConnectResult;
    });
    setTestResult(result.ok ? `✅ 连接成功 (${result.latency_ms}ms)` : `❌ ${result.error ?? "失败"}`);
  }, [form]);

  const parseUrl = useCallback(async () => {
    const text = await navigator.clipboard.readText().catch(() => "");
    // WHY: accept redis://[user:pass@]host[:port][/db]
    const match = text.match(/^redis(s)?:\/\/(?:([^:@]*):([^@]*)@)?([^:/]+)(?::(\d+))?(?:\/(\d+))?/i);
    if (match === null) {
      setTestResult("❌ 剪贴板里没有有效的 redis:// URL");
      return;
    }
    set("username", match[2] ?? "");
    set("password", match[3] ?? "");
    set("passwordTouched", true);
    set("host", match[4] ?? "127.0.0.1");
    set("port", match[5] ? Number(match[5]) : 6379);
    set("db", match[6] ? Number(match[6]) : 0);
    setTestResult("✅ 已从剪贴板解析");
  }, [set]);

  const confirm = useCallback(async () => {
    setSaving(true);
    await invoke<string>("redis_conn_save", {
      input: {
        id: form.id,
        label: form.label.trim() === "" ? `${form.host}:${form.port}` : form.label,
        group_name: form.group_name,
        conn_type: form.conn_type,
        host: form.host,
        port: form.port,
        db: form.db,
        username: form.username,
        // WHY: only send a password when the user typed one — on edit, unchanged
        // means keep the stored secret (backend treats null as "leave as-is").
        password: form.passwordTouched ? form.password : null,
        config_json: buildConfigJson(form),
      },
    }).catch(() => {});
    setSaving(false);
    onSaved();
  }, [form, onSaved]);

  return (
    <Overlay onClose={onClose}>
      <div className="flex h-[460px] w-[640px] flex-col rounded-lg border border-border bg-card shadow-xl">
        <div className="border-b border-border/60 px-5 py-3 text-sm font-semibold">
          {form.id === null ? "New Connection" : "Edit Connection"}
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Left tab nav */}
          <nav className="w-36 shrink-0 space-y-0.5 border-r border-border/60 p-2 text-right text-xs">
            {DIALOG_TABS.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setTab(name)}
                className={cn(
                  "block w-full rounded px-2 py-1.5",
                  tab === name
                    ? "border-r-2 border-primary font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {name}
              </button>
            ))}
          </nav>

          {/* Right panel */}
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {tab === "General" ? (
              <div className="space-y-3">
                <DialogField label="Name" required>
                  <input
                    value={form.label}
                    onChange={(event) => set("label", event.target.value)}
                    placeholder="Connection name"
                    className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
                  />
                </DialogField>
                <DialogField label="Group">
                  <select
                    value={form.group_name}
                    onChange={(event) => set("group_name", event.target.value)}
                    className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
                  >
                    <option value="">No Group</option>
                    {groups.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </DialogField>
                <DialogField label="Address">
                  <div className="flex items-center gap-2">
                    <select
                      value={form.conn_type}
                      onChange={(event) => set("conn_type", event.target.value)}
                      className="h-8 w-20 rounded border border-border bg-background px-2 text-xs"
                    >
                      <option value="tcp">TCP</option>
                      <option value="unix">Unix</option>
                    </select>
                    <input
                      value={form.host}
                      onChange={(event) => set("host", event.target.value)}
                      className="h-8 flex-1 rounded border border-border bg-background px-2 text-xs"
                    />
                    <span className="text-muted-foreground">:</span>
                    <input
                      value={String(form.port)}
                      onChange={(event) => set("port", Number(event.target.value) || 0)}
                      className="h-8 w-20 rounded border border-border bg-background px-2 text-xs"
                    />
                  </div>
                </DialogField>
                <div className="grid grid-cols-2 gap-3">
                  <DialogField label="Password">
                    <input
                      type="password"
                      value={form.password}
                      onChange={(event) => {
                        set("password", event.target.value);
                        set("passwordTouched", true);
                      }}
                      placeholder={form.id !== null ? "(不改留空)" : "(Optional)"}
                      className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
                    />
                  </DialogField>
                  <DialogField label="Username">
                    <input
                      value={form.username}
                      onChange={(event) => set("username", event.target.value)}
                      placeholder="(Optional)"
                      className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
                    />
                  </DialogField>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <DialogField label="Default DB">
                    <input
                      value={String(form.db)}
                      onChange={(event) => set("db", Number(event.target.value) || 0)}
                      className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
                    />
                  </DialogField>
                  <DialogField label="Deployment">
                    <select
                      value={form.deployment}
                      onChange={(event) => set("deployment", event.target.value)}
                      className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
                    >
                      <option value="standalone">Standalone</option>
                      <option value="sentinel">Sentinel</option>
                      <option value="cluster">Cluster</option>
                    </select>
                  </DialogField>
                </div>
              </div>
            ) : tab === "SSL/TLS" ? (
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.tlsEnabled}
                    onChange={(event) => set("tlsEnabled", event.target.checked)}
                  />
                  启用 TLS（默认 rustls，系统根证书）
                </label>
                <div className="rounded border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                  自定义 CA / 客户端证书 (mTLS) / 跳过校验 — 后续细化（需手搭 rustls connector）
                </div>
              </div>
            ) : tab === "Sentinel" ? (
              <div className="space-y-3">
                <div className="text-xs text-muted-foreground">
                  需在 General 把 Deployment 设为 Sentinel 才生效
                </div>
                <DialogField label="Master Name">
                  <input
                    value={form.sentinelMaster}
                    onChange={(event) => set("sentinelMaster", event.target.value)}
                    className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
                  />
                </DialogField>
                <DialogField label="Sentinel Nodes (每行 host:port)">
                  <textarea
                    value={form.sentinelNodes}
                    onChange={(event) => set("sentinelNodes", event.target.value)}
                    placeholder={"127.0.0.1:26379\n127.0.0.1:26380"}
                    className="h-20 w-full resize-none rounded border border-border bg-background px-2 py-1 font-mono text-xs"
                  />
                </DialogField>
              </div>
            ) : tab === "Cluster" ? (
              <div className="space-y-3">
                <div className="text-xs text-muted-foreground">
                  需在 General 把 Deployment 设为 Cluster 才生效（一个种子节点即可，自动发现其余）
                </div>
                <DialogField label="Cluster Nodes (每行 host:port)">
                  <textarea
                    value={form.clusterNodes}
                    onChange={(event) => set("clusterNodes", event.target.value)}
                    placeholder={"127.0.0.1:7000\n127.0.0.1:7001"}
                    className="h-24 w-full resize-none rounded border border-border bg-background px-2 py-1 font-mono text-xs"
                  />
                </DialogField>
              </div>
            ) : tab === "SSH Tunnel" ? (
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.sshEnabled}
                    onChange={(event) => set("sshEnabled", event.target.checked)}
                  />
                  Enable SSH Tunnel / 启用 SSH 隧道
                </label>
                {form.sshEnabled && (
                  <>
                    <DialogField label="SSH Host / 跳板机地址">
                      <input
                        value={form.sshHost}
                        onChange={(event) => set("sshHost", event.target.value)}
                        placeholder="jump.example.com"
                        className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
                      />
                    </DialogField>
                    <div className="flex gap-2">
                      <DialogField label="Port">
                        <input
                          type="number"
                          value={form.sshPort}
                          onChange={(event) => set("sshPort", Number(event.target.value) || 22)}
                          className="h-8 w-20 rounded border border-border bg-background px-2 text-xs"
                        />
                      </DialogField>
                      <DialogField label="Username / 用户名">
                        <input
                          value={form.sshUsername}
                          onChange={(event) => set("sshUsername", event.target.value)}
                          placeholder="root"
                          className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
                        />
                      </DialogField>
                    </div>
                    <DialogField label="Auth Type / 认证方式">
                      <select
                        value={form.sshAuthType}
                        onChange={(event) => set("sshAuthType", event.target.value)}
                        className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
                      >
                        <option value="key">SSH Key (默认 ~/.ssh/id_rsa)</option>
                        <option value="password">Password / 密码</option>
                      </select>
                    </DialogField>
                    {form.sshAuthType === "password" ? (
                      <DialogField label="Password / 密码">
                        <input
                          type="password"
                          value={form.sshPassword}
                          onChange={(event) => set("sshPassword", event.target.value)}
                          className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
                        />
                      </DialogField>
                    ) : (
                      <DialogField label="Key Path / 私钥路径 (留空用默认，需为无 passphrase 的 key)">
                        <input
                          value={form.sshKeyPath}
                          onChange={(event) => set("sshKeyPath", event.target.value)}
                          placeholder="~/.ssh/id_ed25519"
                          className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
                        />
                      </DialogField>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
                <Settings className="h-5 w-5" />
                <div className="font-medium text-foreground">{tab}</div>
                <div className="rounded border border-dashed border-border px-3 py-1.5">
                  阶段 2+ — {tab}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-border/60 px-5 py-3">
          <button
            type="button"
            onClick={() => void test()}
            className="flex h-8 items-center gap-1.5 rounded border border-border px-3 text-xs hover:bg-muted"
          >
            <Plug className="h-3.5 w-3.5" />
            Test Connection
          </button>
          {testResult !== null ? (
            <span className="truncate text-xs text-muted-foreground">{testResult}</span>
          ) : null}
          <button
            type="button"
            onClick={() => void parseUrl()}
            className="ml-auto flex h-8 items-center rounded border border-border px-3 text-xs hover:bg-muted"
          >
            Parse URL from Clipboard
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 items-center rounded border border-border px-3 text-xs hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={saving}
            className="flex h-8 items-center rounded bg-primary px-4 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Confirm
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// New group dialog
// ---------------------------------------------------------------------------

function NewGroupDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): ReactElement {
  const [name, setName] = useState("");

  const create = useCallback(async () => {
    if (name.trim() === "") {
      return;
    }
    await invoke("redis_group_create", { name: name.trim() }).catch(() => {});
    onCreated();
  }, [name, onCreated]);

  return (
    <Overlay onClose={onClose}>
      <div className="w-96 rounded-lg border border-border bg-card p-5 shadow-xl">
        <div className="mb-3 text-sm font-semibold">New Group</div>
        <input
          value={name}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void create();
            }
          }}
          className="h-8 w-full rounded border border-primary/50 bg-background px-2 text-xs"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded border border-border px-3 text-xs hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void create()}
            className="h-8 rounded bg-primary px-4 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Confirm
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Overlay({
  children,
  onClose,
}: {
  children: ReactElement;
  onClose: () => void;
}): ReactElement {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div onClick={(event) => event.stopPropagation()}>{children}</div>
    </div>
  );
}

function DialogField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactElement;
}): ReactElement {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </span>
      {children}
    </label>
  );
}
