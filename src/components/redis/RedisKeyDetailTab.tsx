import { invoke } from "@tauri-apps/api/core";
import { Copy, Plus, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Key Detail tab (Phase 3) — key list (left) + type-specific value editor (right).
// Routed by (connectionId, db); covers String / Hash / List / Set / ZSet / Stream.
// ---------------------------------------------------------------------------

interface EnrichedKey {
  key: string;
  key_type: string;
  ttl: number;
  size_bytes: number;
}

interface EnrichedScanPage {
  keys: EnrichedKey[];
  next_cursor: number;
  done: boolean;
  scanned: number;
}

const TYPE_COLORS: Record<string, string> = {
  string: "bg-emerald-500/20 text-emerald-400",
  hash: "bg-sky-500/20 text-sky-400",
  list: "bg-amber-500/20 text-amber-400",
  set: "bg-violet-500/20 text-violet-400",
  zset: "bg-rose-500/20 text-rose-400",
  stream: "bg-orange-500/20 text-orange-400",
};

function ttlText(ttl: number): string {
  if (ttl === -1) {
    return "∞";
  }
  if (ttl === -2) {
    return "—";
  }
  return `${ttl}s`;
}

export function RedisKeyDetailTab({ connectionId }: { connectionId: string }): ReactElement {
  const [db, setDb] = useState(0);
  // WHY: empty box, not literal "*" — the backend treats empty as match-all.
  const [pattern, setPattern] = useState("");
  const [keys, setKeys] = useState<EnrichedKey[]>([]);
  const [cursor, setCursor] = useState(0);
  const [done, setDone] = useState(true);
  const [selected, setSelected] = useState<EnrichedKey | null>(null);
  // DIAGNOSTIC: surface scan errors instead of silently showing "没有 key".
  const [scanError, setScanError] = useState<string | null>(null);
  // WHY: show a loading state — cluster scan over the network is slow; "没有 key"
  // during the in-flight scan made it look broken/empty.
  const [scanning, setScanning] = useState(false);

  // WHY: monotonic scan id — a slow scan for the previous db/connection must
  // not overwrite the list after the user has already switched (stale response).
  const scanSeqRef = useRef(0);

  const scan = useCallback(
    async (fresh: boolean) => {
      const seq = ++scanSeqRef.current;
      setScanning(true);
      const startCursor = fresh ? 0 : cursor;
      const page = await invoke<EnrichedScanPage>("reg_scan", {
        id: connectionId,
        db,
        pattern,
        cursor: startCursor,
        count: 200,
      }).catch((error) => {
        if (seq === scanSeqRef.current) setScanError(String(error));
        return null;
      });
      if (seq !== scanSeqRef.current) {
        return; // superseded by a newer scan — drop this response
      }
      setScanning(false);
      if (page === null) {
        return;
      }
      setScanError(null);
      setKeys((previous) => (fresh ? page.keys : [...previous, ...page.keys]));
      setCursor(page.next_cursor);
      setDone(page.done);
    },
    [connectionId, db, pattern, cursor],
  );

  useEffect(() => {
    setSelected(null);
  }, [connectionId, db]);

  // WHY: auto-search — re-scan as the filter changes (debounced so a slow cluster
  // scan doesn't fire on every keystroke). Also covers initial load + db switch.
  useEffect(() => {
    const timer = setTimeout(() => void scan(true), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, db, pattern]);

  return (
    <div className="flex h-full">
      {/* Key list */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border/60">
        <div className="flex items-center gap-1 border-b border-border/60 p-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void scan(true);
                }
              }}
              placeholder="Filter（默认全部）"
              className="h-7 w-full rounded border border-border bg-background pl-7 pr-2 text-xs"
            />
          </div>
          <select
            value={db}
            onChange={(event) => setDb(Number(event.target.value))}
            className="h-7 rounded border border-border bg-background px-1 text-xs"
          >
            {Array.from({ length: 16 }, (_, index) => (
              <option key={index} value={index}>
                db{index}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void scan(true)}
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted"
            title="刷新"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {keys.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setSelected(item)}
              className={cn(
                "flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-muted",
                selected?.key === item.key ? "bg-primary/10" : "",
              )}
            >
              {item.key_type !== "" ? (
                <span
                  className={cn(
                    "shrink-0 rounded px-1 py-0.5 text-[9px] uppercase",
                    TYPE_COLORS[item.key_type] ?? "bg-muted text-muted-foreground",
                  )}
                >
                  {item.key_type.slice(0, 3)}
                </span>
              ) : (
                <span className="shrink-0 text-[9px] text-muted-foreground">•</span>
              )}
              <span className="min-w-0 flex-1 truncate font-mono">{item.key}</span>
              {item.ttl >= 0 ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">{ttlText(item.ttl)}</span>
              ) : null}
            </button>
          ))}
          {keys.length === 0 ? (
            scanning ? (
              <div className="flex items-center justify-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                加载中…
              </div>
            ) : scanError !== null ? (
              <div className="px-2 py-6 text-center text-xs text-rose-300 break-all">
                扫描出错：{scanError}
              </div>
            ) : (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">没有 key</div>
            )
          ) : null}
          {!done ? (
            <button
              type="button"
              onClick={() => void scan(false)}
              className="w-full py-2 text-center text-xs text-primary hover:bg-muted"
            >
              加载更多…
            </button>
          ) : null}
        </div>
      </div>

      {/* Value editor */}
      <div className="min-h-0 flex-1 overflow-auto">
        {selected === null ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            选一个 key 查看 / 编辑
          </div>
        ) : (
          <KeyValueEditor
            connectionId={connectionId}
            db={db}
            keyItem={selected}
            onChanged={() => void scan(true)}
            onDeleted={() => {
              setSelected(null);
              void scan(true);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Value editor — header (name/type/TTL/delete) + per-type body
// ---------------------------------------------------------------------------

function KeyValueEditor({
  connectionId,
  db,
  keyItem,
  onChanged,
  onDeleted,
}: {
  connectionId: string;
  db: number;
  keyItem: EnrichedKey;
  onChanged: () => void;
  onDeleted: () => void;
}): ReactElement {
  const base = { id: connectionId, db, key: keyItem.key };
  // WHY: lazy enrichment — scan now returns names only; fetch this key's real
  // TYPE + TTL on select (single routed command, fred follows MOVED on cluster).
  const [resolvedType, setResolvedType] = useState<string>(keyItem.key_type);
  const [resolvedTtl, setResolvedTtl] = useState<number>(keyItem.ttl);
  // DIAGNOSTIC: surface the real TYPE error instead of silently showing "none".
  const [typeError, setTypeError] = useState<string | null>(null);

  useEffect(() => {
    setTypeError(null);
    void invoke<string>("reg_key_type", base)
      .then((value) => setResolvedType(value || "none"))
      .catch((error) => {
        setResolvedType("none");
        setTypeError(String(error));
      });
    void invoke<number>("reg_ttl", base)
      .then((value) => setResolvedTtl(value))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, db, keyItem.key]);

  const deleteKey = useCallback(async () => {
    await invoke("reg_del", base).catch(() => {});
    onDeleted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, db, keyItem.key, onDeleted]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] uppercase",
            TYPE_COLORS[resolvedType] ?? "bg-muted",
          )}
        >
          {resolvedType || "…"}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{keyItem.key}</span>
        <span className="text-xs text-muted-foreground">TTL {ttlText(resolvedTtl)}</span>
        <button
          type="button"
          onClick={() => void deleteKey()}
          className="flex h-7 items-center gap-1 rounded border border-border px-2 text-xs text-destructive hover:bg-muted"
        >
          <Trash2 className="h-3.5 w-3.5" />
          删除
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {resolvedType === "string" ? (
          <StringEditor base={base} onChanged={onChanged} />
        ) : null}
        {resolvedType === "hash" ? <HashEditor base={base} onChanged={onChanged} /> : null}
        {resolvedType === "list" ? <ListEditor base={base} onChanged={onChanged} /> : null}
        {resolvedType === "set" ? <SetEditor base={base} onChanged={onChanged} /> : null}
        {resolvedType === "zset" ? <ZSetEditor base={base} onChanged={onChanged} /> : null}
        {resolvedType === "stream" ? <StreamViewer base={base} /> : null}
        {resolvedType === "" ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            加载类型中…
          </div>
        ) : null}
        {resolvedType === "none" ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-rose-300 break-all">
            {typeError !== null
              ? `类型查询出错：${typeError}`
              : "TYPE 返回 none（key 不存在 / 路由到错误节点）"}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type Base = { id: string; db: number; key: string };

// --- Value view formats (Phase 6a) — display-only decode -------------------

type ViewFormat = "raw" | "json" | "base64" | "hex";

function formatValue(raw: string, format: ViewFormat): string {
  if (format === "json") {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return `（不是合法 JSON）\n\n${raw}`;
    }
  }
  if (format === "base64") {
    try {
      return atob(raw);
    } catch {
      return "（不是合法 base64）";
    }
  }
  if (format === "hex") {
    const bytes = new TextEncoder().encode(raw);
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ");
  }
  return raw;
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

// --- String ---------------------------------------------------------------

function StringEditor({ base, onChanged }: { base: Base; onChanged: () => void }): ReactElement {
  const [value, setValue] = useState("");
  const [totalBytes, setTotalBytes] = useState(0);
  const [loaded, setLoaded] = useState(false);
  // WHY: the backend returns a 4KB preview for large values — saving that
  // preview back would overwrite the full value with its truncation.
  const [truncated, setTruncated] = useState(false);
  const [format, setFormat] = useState<ViewFormat>("raw");

  useEffect(() => {
    void invoke<{ value: string; truncated: boolean; total_bytes: number }>("reg_string_get", base)
      .then((result) => {
        const loadedValue = result?.value ?? "";
        setValue(loadedValue);
        setTotalBytes(result?.total_bytes ?? 0);
        setTruncated(result?.truncated ?? false);
        // WHY: auto-pick JSON view for JSON-shaped values, like Tiny RDM.
        setFormat(looksLikeJson(loadedValue) ? "json" : "raw");
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base.id, base.db, base.key]);

  const save = useCallback(async () => {
    if (truncated) return;
    await invoke("reg_string_set", { ...base, value, ttlSecs: null }).catch(() => {});
    onChanged();
  }, [base, value, truncated, onChanged]);

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <select
          value={format}
          onChange={(event) => setFormat(event.target.value as ViewFormat)}
          className="h-7 rounded border border-border bg-background px-2 text-xs"
        >
          <option value="raw">Raw</option>
          <option value="json">JSON</option>
          <option value="base64">Base64</option>
          <option value="hex">Hex</option>
        </select>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(value).catch(() => {})}
            className="flex h-7 items-center gap-1.5 rounded border border-border px-2.5 text-xs hover:bg-muted"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy Value
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={truncated}
            title={truncated ? "值超过预览上限，已截断显示 — 保存会截毁原值，故禁用" : undefined}
            className="flex h-7 items-center gap-1.5 rounded bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save className="h-3.5 w-3.5" />
            Save
          </button>
        </div>
      </div>
      {truncated && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600">
          ⚠️ 值过大（{totalBytes} bytes），仅显示前 4KB 预览 — 为防止数据丢失已禁用保存
        </div>
      )}
      {format === "raw" ? (
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={!loaded || truncated}
          className="min-h-[200px] flex-1 resize-none rounded border border-border bg-background p-2 font-mono text-xs"
        />
      ) : (
        // WHY: decoded views are display-only; editing stays on the Raw view.
        <pre className="min-h-[200px] flex-1 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-background p-2 font-mono text-xs">
          {formatValue(value, format)}
        </pre>
      )}
      <div className="flex justify-between border-t border-border/40 pt-1 text-[11px] text-muted-foreground">
        <span>Length: {totalBytes}</span>
        <span>
          {truncated ? "截断预览 · 只读" : format === "raw" ? "Raw（可编辑）" : `${format} · 只读`}
        </span>
      </div>
    </div>
  );
}

// --- Hash ------------------------------------------------------------------

function HashEditor({ base, onChanged }: { base: Base; onChanged: () => void }): ReactElement {
  const [fields, setFields] = useState<Array<{ field: string; value: string }>>([]);
  const [newField, setNewField] = useState("");
  const [newValue, setNewValue] = useState("");

  const load = useCallback(async () => {
    const result = await invoke<Array<{ field: string; value: string }>>("reg_hash_getall", base).catch(() => []);
    setFields(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base.id, base.db, base.key]);

  useEffect(() => {
    void load();
  }, [load]);

  const setField = useCallback(
    async (field: string, value: string) => {
      await invoke("reg_hash_set", { ...base, field, value }).catch(() => {});
      await load();
      onChanged();
    },
    [base, load, onChanged],
  );

  const delField = useCallback(
    async (field: string) => {
      await invoke("reg_hash_del", { ...base, field }).catch(() => {});
      await load();
      onChanged();
    },
    [base, load, onChanged],
  );

  return (
    <div className="space-y-2">
      <table className="w-full text-xs">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1 font-medium">Field</th>
            <th className="py-1 font-medium">Value</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {fields.map((row) => (
            <tr key={row.field} className="border-t border-border/40">
              <td className="py-1 pr-2 font-mono">{row.field}</td>
              <td className="py-1 pr-2">
                <input
                  defaultValue={row.value}
                  onBlur={(event) => {
                    if (event.target.value !== row.value) {
                      void setField(row.field, event.target.value);
                    }
                  }}
                  className="h-7 w-full rounded border border-border bg-background px-2 font-mono"
                />
              </td>
              <td className="py-1">
                <button
                  type="button"
                  onClick={() => void delField(row.field)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-2 border-t border-border/40 pt-2">
        <input
          value={newField}
          onChange={(event) => setNewField(event.target.value)}
          placeholder="field"
          className="h-7 flex-1 rounded border border-border bg-background px-2 text-xs"
        />
        <input
          value={newValue}
          onChange={(event) => setNewValue(event.target.value)}
          placeholder="value"
          className="h-7 flex-1 rounded border border-border bg-background px-2 text-xs"
        />
        <button
          type="button"
          onClick={() => {
            if (newField !== "") {
              void setField(newField, newValue);
              setNewField("");
              setNewValue("");
            }
          }}
          className="flex h-7 items-center gap-1 rounded border border-border px-2 text-xs hover:bg-muted"
        >
          <Plus className="h-3.5 w-3.5" />
          添加
        </button>
      </div>
    </div>
  );
}

// --- List ------------------------------------------------------------------

function ListEditor({ base, onChanged }: { base: Base; onChanged: () => void }): ReactElement {
  const [items, setItems] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [newValue, setNewValue] = useState("");

  const load = useCallback(async () => {
    const page = await invoke<{ items: string[]; total: number }>("reg_list_range", {
      ...base,
      start: 0,
      stop: 199,
    }).catch(() => ({ items: [], total: 0 }));
    setItems(page.items);
    setTotal(page.total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base.id, base.db, base.key]);

  useEffect(() => {
    void load();
  }, [load]);

  const push = useCallback(
    async (left: boolean) => {
      if (newValue === "") {
        return;
      }
      await invoke("reg_list_push", { ...base, value: newValue, left }).catch(() => {});
      setNewValue("");
      await load();
      onChanged();
    },
    [base, newValue, load, onChanged],
  );

  const setAt = useCallback(
    async (index: number, value: string) => {
      await invoke("reg_list_set", { ...base, index, value }).catch(() => {});
      await load();
    },
    [base, load],
  );

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">共 {total} 项（显示前 {items.length}）</div>
      <div className="space-y-1">
        {items.map((item, index) => (
          // WHY: key includes the server value — after LPUSH shifts the list,
          // an index-only key kept stale defaultValues on screen and a blur
          // would LSET the wrong content over the freshly pushed element.
          <div key={`${index}:${item}`} className="flex items-center gap-2">
            <span className="w-10 shrink-0 text-right text-[10px] text-muted-foreground">{index}</span>
            <input
              defaultValue={item}
              onBlur={(event) => {
                if (event.target.value !== item) {
                  void setAt(index, event.target.value);
                }
              }}
              className="h-7 flex-1 rounded border border-border bg-background px-2 font-mono text-xs"
            />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-border/40 pt-2">
        <input
          value={newValue}
          onChange={(event) => setNewValue(event.target.value)}
          placeholder="新元素"
          className="h-7 flex-1 rounded border border-border bg-background px-2 text-xs"
        />
        <button
          type="button"
          onClick={() => void push(true)}
          className="h-7 rounded border border-border px-2 text-xs hover:bg-muted"
        >
          LPUSH
        </button>
        <button
          type="button"
          onClick={() => void push(false)}
          className="h-7 rounded border border-border px-2 text-xs hover:bg-muted"
        >
          RPUSH
        </button>
      </div>
    </div>
  );
}

// --- Set -------------------------------------------------------------------

function SetEditor({ base, onChanged }: { base: Base; onChanged: () => void }): ReactElement {
  const [members, setMembers] = useState<string[]>([]);
  const [newMember, setNewMember] = useState("");

  const load = useCallback(async () => {
    const result = await invoke<string[]>("reg_set_members", base).catch(() => []);
    setMembers(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base.id, base.db, base.key]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = useCallback(async () => {
    if (newMember === "") {
      return;
    }
    await invoke("reg_set_add", { ...base, member: newMember }).catch(() => {});
    setNewMember("");
    await load();
    onChanged();
  }, [base, newMember, load, onChanged]);

  const rem = useCallback(
    async (member: string) => {
      await invoke("reg_set_rem", { ...base, member }).catch(() => {});
      await load();
      onChanged();
    },
    [base, load, onChanged],
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {members.map((member) => (
          <span
            key={member}
            className="flex items-center gap-1 rounded bg-muted px-2 py-1 font-mono text-xs"
          >
            {member}
            <button
              type="button"
              onClick={() => void rem(member)}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-border/40 pt-2">
        <input
          value={newMember}
          onChange={(event) => setNewMember(event.target.value)}
          placeholder="新成员"
          className="h-7 flex-1 rounded border border-border bg-background px-2 text-xs"
        />
        <button
          type="button"
          onClick={() => void add()}
          className="flex h-7 items-center gap-1 rounded border border-border px-2 text-xs hover:bg-muted"
        >
          <Plus className="h-3.5 w-3.5" />
          SADD
        </button>
      </div>
    </div>
  );
}

// --- ZSet ------------------------------------------------------------------

function ZSetEditor({ base, onChanged }: { base: Base; onChanged: () => void }): ReactElement {
  const [entries, setEntries] = useState<Array<{ member: string; score: number }>>([]);
  const [newMember, setNewMember] = useState("");
  const [newScore, setNewScore] = useState("0");

  const load = useCallback(async () => {
    const page = await invoke<{ entries: Array<{ member: string; score: number }>; total: number }>(
      "reg_zset_range",
      { ...base, start: 0, stop: 199 },
    ).catch(() => ({ entries: [], total: 0 }));
    setEntries(page.entries);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base.id, base.db, base.key]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = useCallback(async () => {
    if (newMember === "") {
      return;
    }
    await invoke("reg_zset_add", { ...base, member: newMember, score: Number(newScore) || 0 }).catch(() => {});
    setNewMember("");
    setNewScore("0");
    await load();
    onChanged();
  }, [base, newMember, newScore, load, onChanged]);

  const rem = useCallback(
    async (member: string) => {
      await invoke("reg_zset_rem", { ...base, member }).catch(() => {});
      await load();
      onChanged();
    },
    [base, load, onChanged],
  );

  return (
    <div className="space-y-2">
      <table className="w-full text-xs">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1 font-medium">Member</th>
            <th className="py-1 font-medium">Score</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.member} className="border-t border-border/40">
              <td className="py-1 pr-2 font-mono">{entry.member}</td>
              <td className="py-1 pr-2 font-mono">{entry.score}</td>
              <td className="py-1">
                <button
                  type="button"
                  onClick={() => void rem(entry.member)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-2 border-t border-border/40 pt-2">
        <input
          value={newMember}
          onChange={(event) => setNewMember(event.target.value)}
          placeholder="member"
          className="h-7 flex-1 rounded border border-border bg-background px-2 text-xs"
        />
        <input
          value={newScore}
          onChange={(event) => setNewScore(event.target.value)}
          placeholder="score"
          className="h-7 w-24 rounded border border-border bg-background px-2 text-xs"
        />
        <button
          type="button"
          onClick={() => void add()}
          className="flex h-7 items-center gap-1 rounded border border-border px-2 text-xs hover:bg-muted"
        >
          <Plus className="h-3.5 w-3.5" />
          ZADD
        </button>
      </div>
    </div>
  );
}

// --- Stream (read-only) ----------------------------------------------------

function StreamViewer({ base }: { base: Base }): ReactElement {
  const [entries, setEntries] = useState<Array<{ id: string; fields: Array<[string, string]> }>>([]);

  useEffect(() => {
    void invoke<Array<{ id: string; fields: Array<[string, string]> }>>("reg_stream_range", {
      ...base,
      count: 100,
    })
      .then((result) => setEntries(result ?? []))
      .catch(() => setEntries([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base.id, base.db, base.key]);

  return (
    <div className="space-y-2 font-mono text-xs">
      {entries.map((entry) => (
        <div key={entry.id} className="rounded border border-border/60 p-2">
          <div className="mb-1 text-amber-400">{entry.id}</div>
          {entry.fields.map(([field, value], index) => (
            <div key={index} className="flex gap-2">
              <span className="text-muted-foreground">{field}</span>
              <span>{value}</span>
            </div>
          ))}
        </div>
      ))}
      {entries.length === 0 ? <div className="text-muted-foreground">空 stream</div> : null}
    </div>
  );
}
