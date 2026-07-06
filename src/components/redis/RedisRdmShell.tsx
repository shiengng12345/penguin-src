import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Activity,
  BarChart3,
  Database,
  FileText,
  HardDrive,
  History,
  Radio,
  RefreshCw,
  Settings,
  Square,
  Terminal,
  Timer,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { RedisConnectionManager } from "@/components/redis/RedisConnectionManager";
import { RedisConsoleTab } from "@/components/redis/RedisConsoleTab";
import { RedisKeyDetailTab } from "@/components/redis/RedisKeyDetailTab";
import { RedisPubSubTab } from "@/components/redis/RedisPubSubTab";
import { RedisSlowLogTab } from "@/components/redis/RedisSlowLogTab";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// RDM Shell — Tiny-RDM-style layout in Pengvi style.
// Icon rail · connection manager (address book) · top tabs of open connections ·
// main area with 6 tabs. Status (live INFO) + Monitor (live stream) functional.
// ---------------------------------------------------------------------------

interface LiveConnection {
  id: string;
  label: string;
  host: string;
  port: number;
}

interface KeyspaceEntry {
  db: string;
  keys: number;
  expires: number;
}

interface RedisStats {
  redis_version: string;
  redis_mode: string;
  role: string;
  uptime_in_seconds: number;
  connected_clients: number;
  blocked_clients: number;
  used_memory: number;
  used_memory_human: string;
  used_memory_peak_human: string;
  used_memory_rss_human: string;
  total_commands_processed: number;
  instantaneous_ops_per_sec: number;
  total_net_input_bytes: number;
  total_net_output_bytes: number;
  keyspace: KeyspaceEntry[];
}

interface Sample {
  ops: number;
  clients: number;
  memory: number;
  netIn: number;
  netOut: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

type MainTab = "status" | "keys" | "console" | "slowlog" | "monitor" | "pubsub";

const MAIN_TABS: Array<{ id: MainTab; label: string; icon: ReactElement }> = [
  { id: "status", label: "Status", icon: <BarChart3 className="h-3.5 w-3.5" /> },
  { id: "keys", label: "Key Detail", icon: <FileText className="h-3.5 w-3.5" /> },
  { id: "console", label: "Console", icon: <Terminal className="h-3.5 w-3.5" /> },
  { id: "slowlog", label: "Slow Log", icon: <Timer className="h-3.5 w-3.5" /> },
  { id: "monitor", label: "Monitor Commands", icon: <Activity className="h-3.5 w-3.5" /> },
  { id: "pubsub", label: "Pub/Sub", icon: <Radio className="h-3.5 w-3.5" /> },
];

const MAX_MONITOR_LINES = 500;

function formatUptime(seconds: number): string {
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} m`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)} h`;
  }
  return `${Math.floor(seconds / 86400)} d`;
}

export function RedisRdmShell(): ReactElement {
  const [connections, setConnections] = useState<LiveConnection[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>("status");

  const refreshList = useCallback(async () => {
    const list = await invoke<LiveConnection[]>("redis_reg_list").catch(() => []);
    setConnections(list);
    setActiveId((current) => {
      const stillExists = list.some((connection) => connection.id === current);
      if (stillExists) {
        return current;
      }
      return list.length > 0 ? list[0].id : null;
    });
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const handleOpened = useCallback(
    async (liveId: string) => {
      await refreshList();
      setActiveId(liveId);
      setMainTab("status");
    },
    [refreshList],
  );

  const handleDisconnect = useCallback(
    async (id: string) => {
      await invoke("redis_reg_disconnect", { id }).catch(() => {});
      await refreshList();
    },
    [refreshList],
  );

  const activeConnection =
    connections.find((connection) => connection.id === activeId) ?? null;

  return (
    <div className="flex h-full bg-background text-sm">
      {/* Far-left icon rail */}
      <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border/60 py-2">
        <RailButton icon={<Database className="h-4 w-4" />} active />
        <RailButton icon={<HardDrive className="h-4 w-4" />} />
        <RailButton icon={<History className="h-4 w-4" />} />
        <div className="mt-auto" />
        <RailButton icon={<Settings className="h-4 w-4" />} />
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top tabs — opened (live) connections */}
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          {connections.map((connection) => (
            <button
              key={connection.id}
              type="button"
              onClick={() => setActiveId(connection.id)}
              className={cn(
                "group flex h-7 items-center gap-1.5 rounded-t border-b-2 px-3 text-xs",
                connection.id === activeId
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Database className="h-3.5 w-3.5 text-red-400" />
              <span className="max-w-[160px] truncate">{connection.label}</span>
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDisconnect(connection.id);
                }}
                className="rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          ))}
          {connections.length === 0 ? (
            <span className="px-2 text-xs text-muted-foreground">
              双击左侧连接打开
            </span>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Connection manager (address book) */}
          <RedisConnectionManager activeLiveId={activeId} onOpened={handleOpened} />

          {/* Main area */}
          <main className="flex min-h-0 flex-1 flex-col">
            {activeConnection === null ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                <Database className="h-6 w-6" />
                双击左侧已保存的连接打开，或点左下 + 新建连接
              </div>
            ) : (
              <>
                <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2">
                  {MAIN_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setMainTab(tab.id)}
                      className={cn(
                        "flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs",
                        mainTab === tab.id
                          ? "border-primary text-foreground"
                          : "border-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {tab.icon}
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="min-h-0 flex-1 overflow-auto">
                  {mainTab === "status" ? <StatusTab connection={activeConnection} /> : null}
                  {mainTab === "monitor" ? <MonitorTab connectionId={activeConnection.id} /> : null}
                  {mainTab === "keys" ? (
                    <RedisKeyDetailTab connectionId={activeConnection.id} />
                  ) : null}
                  {mainTab === "console" ? (
                    <RedisConsoleTab connectionId={activeConnection.id} />
                  ) : null}
                  {mainTab === "slowlog" ? (
                    <RedisSlowLogTab connectionId={activeConnection.id} />
                  ) : null}
                  {mainTab === "pubsub" ? (
                    <RedisPubSubTab connectionId={activeConnection.id} />
                  ) : null}
                </div>
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function RailButton({
  icon,
  active,
}: {
  icon: ReactElement;
  active?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {icon}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Status tab — live INFO every 3s
// ---------------------------------------------------------------------------

function StatusTab({ connection }: { connection: LiveConnection }): ReactElement {
  const [stats, setStats] = useState<RedisStats | null>(null);
  const [subTab, setSubTab] = useState<"activity" | "server">("activity");
  const [samples, setSamples] = useState<Sample[]>([]);
  const prevNet = useRef<{ in: number; out: number } | null>(null);

  const refresh = useCallback(async () => {
    const result = await invoke<RedisStats>("redis_reg_info", {
      id: connection.id,
    }).catch(() => null);
    setStats(result);
    if (result !== null) {
      let netIn = 0;
      let netOut = 0;
      if (prevNet.current !== null) {
        // WHY: network charts plot per-interval rate = delta of cumulative counters.
        netIn = Math.max(0, result.total_net_input_bytes - prevNet.current.in);
        netOut = Math.max(0, result.total_net_output_bytes - prevNet.current.out);
      }
      prevNet.current = { in: result.total_net_input_bytes, out: result.total_net_output_bytes };
      setSamples((previous) => {
        const next = [
          ...previous,
          {
            ops: result.instantaneous_ops_per_sec,
            clients: result.connected_clients,
            memory: result.used_memory,
            netIn,
            netOut,
          },
        ];
        return next.length > 30 ? next.slice(next.length - 30) : next;
      });
    }
  }, [connection.id]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const totalKeys = stats?.keyspace.reduce((sum, entry) => sum + entry.keys, 0) ?? 0;

  return (
    <div className="p-6">
      <div className="mb-5 flex items-center gap-2">
        <h2 className="text-lg font-semibold">{connection.label}</h2>
        {stats?.redis_version ? (
          <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] font-medium text-rose-400">
            v{stats.redis_version}
          </span>
        ) : null}
        {stats?.redis_mode ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {stats.redis_mode}
          </span>
        ) : null}
        {stats?.role ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {stats.role}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void refresh()}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded text-rose-400 hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-6 grid grid-cols-4 gap-4">
        <StatCard label="Uptime" value={stats ? formatUptime(stats.uptime_in_seconds) : "—"} />
        <StatCard label="Clients" value={stats ? String(stats.connected_clients) : "—"} />
        <StatCard label="Keys" value={String(totalKeys)} />
        <StatCard label="Memory" value={stats?.used_memory_human ?? "—"} />
      </div>

      <div className="mb-4 flex gap-4 border-b border-border/60">
        <SubTabButton active={subTab === "activity"} onClick={() => setSubTab("activity")} label="Activity" />
        <SubTabButton active={subTab === "server"} onClick={() => setSubTab("server")} label="Server Info" />
      </div>

      {subTab === "activity" ? (
        <div className="grid grid-cols-2 gap-4">
          <AreaChart
            title="Commands/Sec"
            dot="bg-rose-400"
            fill="fill-rose-400/20"
            stroke="stroke-rose-400"
            data={samples.map((s) => s.ops)}
            format={(n) => String(Math.round(n))}
          />
          <AreaChart
            title="Clients"
            dot="bg-amber-400"
            fill="fill-amber-400/20"
            stroke="stroke-amber-400"
            data={samples.map((s) => s.clients)}
            format={(n) => String(Math.round(n))}
          />
          <AreaChart
            title="Memory"
            dot="bg-violet-400"
            fill="fill-violet-400/20"
            stroke="stroke-violet-400"
            data={samples.map((s) => s.memory)}
            format={formatBytes}
          />
          <AreaChart
            title="Network Out"
            dot="bg-sky-400"
            fill="fill-sky-400/20"
            stroke="stroke-sky-400"
            data={samples.map((s) => s.netOut)}
            format={formatBytes}
          />
        </div>
      ) : (
        <div className="space-y-1 font-mono text-xs">
          <InfoRow label="Redis Version" value={stats?.redis_version ?? "—"} />
          <InfoRow label="Uptime (s)" value={String(stats?.uptime_in_seconds ?? 0)} />
          <InfoRow label="Connected Clients" value={String(stats?.connected_clients ?? 0)} />
          <InfoRow label="Blocked Clients" value={String(stats?.blocked_clients ?? 0)} />
          <InfoRow label="Memory Used" value={stats?.used_memory_human ?? "—"} />
          <InfoRow label="Memory Peak" value={stats?.used_memory_peak_human ?? "—"} />
          <InfoRow label="Memory RSS" value={stats?.used_memory_rss_human ?? "—"} />
          <InfoRow label="Total Commands" value={String(stats?.total_commands_processed ?? 0)} />
          <InfoRow label="Ops / Sec" value={String(stats?.instantaneous_ops_per_sec ?? 0)} />
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function AreaChart({
  title,
  dot,
  fill,
  stroke,
  data,
  format,
}: {
  title: string;
  dot: string;
  fill: string;
  stroke: string;
  data: number[];
  format: (value: number) => string;
}): ReactElement {
  const width = 100;
  const height = 40;
  const max = Math.max(1, ...data);
  let points: string[] = [];
  if (data.length > 1) {
    points = data.map(
      (value, index) =>
        `${(index / (data.length - 1)) * width},${height - (value / max) * height}`,
    );
  } else if (data.length === 1) {
    const y = height - (data[0] / max) * height;
    points = [`0,${y}`, `${width},${y}`];
  }
  const line = points.join(" ");
  const area = points.length > 0 ? `0,${height} ${line} ${width},${height}` : "";
  const latest = data.length > 0 ? data[data.length - 1] : 0;

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <span className={cn("inline-block h-2 w-4 rounded-sm", dot)} />
        {title}
      </div>
      <div className="flex gap-2">
        <div className="flex w-12 shrink-0 flex-col justify-between py-1 text-right text-[10px] text-muted-foreground">
          <span>{format(max)}</span>
          <span>{format(0)}</span>
        </div>
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-28 flex-1">
          {area !== "" ? <polygon points={area} className={fill} /> : null}
          {line !== "" ? (
            <polyline
              points={line}
              fill="none"
              className={stroke}
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
      </div>
      <div className="mt-1 text-center font-mono text-xs">{format(latest)}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex justify-between border-b border-border/40 py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function SubTabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "border-b-2 pb-2 text-sm",
        active ? "border-rose-400 text-foreground" : "border-transparent text-muted-foreground",
      )}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Monitor Commands tab — live stream (functional)
// ---------------------------------------------------------------------------

function MonitorTab({ connectionId }: { connectionId: string }): ReactElement {
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [search, setSearch] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  // WHY: the stream belongs to the connection it was started on. Switching
  // connections (or unmounting) must stop THAT stream and reset the button —
  // otherwise the UI shows "Stop" for connection B while A's stream leaks.
  const runningIdRef = useRef<string | null>(null);

  useEffect(() => {
    setRunning(false);
    setLines([]);
    return () => {
      const startedId = runningIdRef.current;
      if (startedId !== null) {
        runningIdRef.current = null;
        void invoke("redis_reg_monitor_stop", { id: startedId }).catch(() => {});
      }
    };
  }, [connectionId]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen<string>(`redis://monitor/${connectionId}`, (event) => {
      setLines((previous) => {
        const next = [...previous, event.payload];
        if (next.length > MAX_MONITOR_LINES) {
          return next.slice(next.length - MAX_MONITOR_LINES);
        }
        return next;
      });
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten !== null) {
        unlisten();
      }
    };
  }, [connectionId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  const toggle = useCallback(async () => {
    if (running) {
      await invoke("redis_reg_monitor_stop", { id: connectionId }).catch(() => {});
      runningIdRef.current = null;
      setRunning(false);
      return;
    }
    setLines([]);
    try {
      await invoke("redis_reg_monitor_start", { id: connectionId });
      runningIdRef.current = connectionId;
      setRunning(true);
    } catch (error) {
      setLines([`MONITOR start failed: ${String(error)}`]);
    }
  }, [running, connectionId]);

  const filtered =
    search.trim() === ""
      ? lines
      : lines.filter((line) => line.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border/60 px-4 py-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void toggle()}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded border px-2.5 text-xs",
              running
                ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
            )}
          >
            {running ? <Square className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5" />}
            {running ? "Stop" : "Start"}
          </button>
          <span className="text-[11px] text-amber-500/80">
            ⚠️ 命令监控可能阻塞服务器，生产环境慎用
          </span>
          <button
            type="button"
            onClick={() => setLines([])}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            清空
          </button>
        </div>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search"
          className="mt-2 h-7 w-full rounded border border-border bg-background px-2 text-xs"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-black/30 p-3 font-mono text-[11px] leading-relaxed">
        {filtered.length === 0 ? (
          <div className="text-muted-foreground">
            点「Start」，然后在 Redis 上跑命令就能实时看到…
          </div>
        ) : (
          filtered.map((line, index) => (
            <div key={index} className="whitespace-pre-wrap break-all text-foreground/90">
              {line}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

