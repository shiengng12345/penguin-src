import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Box,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  Download,
  GitBranch,
  Globe,
  LayoutGrid,
  Loader2,
  Package,
  RefreshCw,
  Search,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { isAllowedSnsoftPackageSpec, normalizePackageSpec, protocolFromSnsoftPackageSpec } from "@penguin/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAppStore, type InstalledPackage } from "@/lib/store";
import {
  canBackgroundRefreshRegistry,
  REGISTRY_AUTO_REFRESH_INTERVAL_MS,
} from "@/lib/registry-auto-refresh";
import { useDeveloperMode } from "@/hooks/useDeveloperMode";
import {
  completePackageSpec,
  filterPackageRows,
  isAllowedClientPackage,
  isPackageRowInstalled,
  suggestPackageStems,
  type PackageProtocol,
  type PackageProtocolFilter,
  type PackageResultRow,
  type RegistryPackage,
} from "@/lib/registry-search-core";
import { fetchRegistryPackages, loadCachedRegistryPackages } from "@/lib/registry-search";

interface PackageInstallerProps {
  onInstall: (spec: string) => Promise<boolean>;
  onClose: () => void;
  packages: InstalledPackage[];
}

const TYPE_FILTERS: Array<{
  value: PackageProtocolFilter;
  label: string;
  Icon?: LucideIcon;
  iconClass: string;
}> = [
  { value: "all", label: "全部", Icon: LayoutGrid, iconClass: "text-cyan-300" },
  { value: "grpc", label: "gRPC", Icon: Box, iconClass: "text-cyan-300" },
  { value: "grpc-web", label: "gRPC-Web", Icon: Globe, iconClass: "text-emerald-300" },
  { value: "sdk", label: "JS-SDK", iconClass: "text-purple-300" }, // JS 徽标
];

const PROTOCOL_LABELS: Record<PackageProtocol, string> = {
  grpc: "gRPC",
  "grpc-web": "gRPC-Web",
  sdk: "JS-SDK",
};

function packageRowKey(pkg: Pick<PackageResultRow, "name" | "install_tag" | "version">): string {
  return `${pkg.name}@${pkg.install_tag}:${pkg.version}`;
}

function packageInstallSpec(pkg: Pick<PackageResultRow, "name" | "version">): string {
  return `${pkg.name}@${pkg.version}`;
}

function stampFromVersion(version: string): Date | null {
  const iso = version.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (iso) {
    const dt = new Date(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], +iso[6]);
    if (!Number.isNaN(dt.getTime())) return dt;
  }
  const m = version.match(/(\d{14})(?:\D|$)/);
  if (!m) return null;
  const s = m[1];
  const dt = new Date(
    +s.slice(0, 4),
    +s.slice(4, 6) - 1,
    +s.slice(6, 8),
    +s.slice(8, 10),
    +s.slice(10, 12),
    +s.slice(12, 14),
  );
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function fmtStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatElapsed(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

// 多选勾选框：选中为实心 cyan + 勾
function RowCheck({ selected }: { selected: boolean }) {
  return (
    <span
      className={cn(
        "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border-2 transition-colors",
        selected ? "border-cyan-400 bg-cyan-400 text-slate-950" : "border-slate-600",
      )}
      aria-hidden="true"
    >
      {selected && <Check className="h-3 w-3" strokeWidth={3} />}
    </span>
  );
}

// 协议 = 左侧图标区分（不再用文字标签，包名已可辨识）：
// gRPC 立方(青) / gRPC-Web 地球(绿) / JS-SDK 花括号(紫)。
const PROTOCOL_ICON: Record<PackageProtocol, { Icon: LucideIcon; box: string; icon: string }> = {
  grpc: { Icon: Box, box: "border-cyan-400/20 bg-cyan-400/10", icon: "text-cyan-300" },
  "grpc-web": { Icon: Globe, box: "border-emerald-400/20 bg-emerald-400/10", icon: "text-emerald-300" },
  sdk: { Icon: Braces, box: "border-violet-400/20 bg-violet-400/10", icon: "text-violet-300" },
};

function ProtocolIcon({ protocol }: { protocol: PackageProtocol }) {
  const meta = PROTOCOL_ICON[protocol];
  return (
    <div
      title={PROTOCOL_LABELS[protocol]}
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border",
        meta.box,
      )}
    >
      <meta.Icon className={cn("h-[18px] w-[18px]", meta.icon)} />
    </div>
  );
}

function BranchChip({ branch }: { branch: string }) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  if (!branch) return null;
  // 名字被截断时才在 hover 弹出完整分支名；tooltip 用 fixed + portal 到 body，
  // 不会被结果列表的 overflow 容器裁掉。
  const onEnter = () => {
    const el = labelRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const r = el.getBoundingClientRect();
    setTip({ x: r.left + r.width / 2, y: r.top });
  };
  return (
    <span
      onMouseEnter={onEnter}
      onMouseLeave={() => setTip(null)}
      // 纯元数据：灰蓝极淡底 + ring-white/5，不用青色、不像可选中/可编辑
      className="inline-flex max-w-[160px] items-center gap-1 whitespace-nowrap rounded-md bg-slate-800/45 px-2 py-0.5 text-[11px] text-slate-400 ring-1 ring-white/5"
    >
      <GitBranch className="h-3 w-3 shrink-0 text-slate-500" />
      <span ref={labelRef} className="truncate">
        {branch}
      </span>
      {tip &&
        createPortal(
          <div
            style={{
              position: "fixed",
              left: tip.x,
              top: tip.y - 8,
              transform: "translate(-50%, -100%)",
            }}
            className="pointer-events-none z-[70] max-w-[360px] break-all rounded-md border border-slate-700 bg-[#0d1420] px-2.5 py-1 font-mono text-[11px] text-slate-100 shadow-[0_8px_24px_rgba(0,0,0,0.55)]"
          >
            {branch}
          </div>,
          document.body,
        )}
    </span>
  );
}

function mergeRegistryPackages(
  current: RegistryPackage[] | null,
  incoming: RegistryPackage[],
): RegistryPackage[] {
  const byName = new Map((current ?? []).map((pkg) => [pkg.name, pkg] as const));
  for (const pkg of incoming) {
    byName.set(pkg.name, pkg);
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function PackageInstaller({ onInstall, onClose, packages }: PackageInstallerProps) {
  const installLog = useAppStore((s) => s.installLog);
  const clearInstallLog = useAppStore((s) => s.clearInstallLog);

  const [typeFilter, setTypeFilter] = useState<PackageProtocolFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  // family 多选筛选：勾选的产品线家族（存 stem，如 player / ai-chat）。空=全部。
  const [selectedFamilies, setSelectedFamilies] = useState<Set<string>>(new Set());
  // 「仅 master」勾选框：默认勾上 → 按 master 分支过滤；在分支框输入即自动
  // 取消勾选、改按输入框的值走（空=全部分支）。
  const [branchQuery, setBranchQuery] = useState("");
  // 默认关闭：默认显示全部分支（用户要能看到最新发布，不被 master 挡住）。
  const [masterOnly, setMasterOnly] = useState(false);
  const effectiveBranch = masterOnly ? "master" : branchQuery;
  const [manualSpec, setManualSpec] = useState("");
  // 多选：勾选多个包一次批量安装（对齐一次装一整批的工作流）
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  // 行内「复制安装规格」的短暂反馈：记住刚复制的那一行 key + 弹出的 toast 文案，
  // 1.5s 后一起清除。
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [nameSuggestOpen, setNameSuggestOpen] = useState(false);
  const [nameSuggestIdx, setNameSuggestIdx] = useState(-1);
  const nameBlurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [registryList, setRegistryList] = useState<RegistryPackage[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 自动刷新开关（绿色=开）：开启即静默重拉一次最新列表，之后每 30s 后台重拉。
  // 后台刷新只替换底层列表，不触碰搜索/勾选/loading UI，不打断用户操作。
  // 权限：仅 admin / super-admin（有效 dev token）可用自动刷新；普通用户该按钮
  // 退化为「点一下刷新一次」。
  // 持久化到 store：绿灯开关跨「关闭→重开」记住，且 app 级 poller 在关闭期间
  // 后台续刷（严格门控见 canBackgroundRefreshRegistry）。
  const autoRefresh = useAppStore((s) => s.installerAutoRefresh);
  const setInstallerAutoRefresh = useAppStore((s) => s.setInstallerAutoRefresh);
  const { enabled: devModeEnabled, hasValidToken } = useDeveloperMode();
  const canAutoRefresh = devModeEnabled && hasValidToken;

  const loadRegistryList = async (
    // silent：后台自动刷新用——不动 loading/error UI，只在拿到新列表后静默替换，
    // 不打断用户当前的搜索/勾选/滚动。
    options: { useCache?: boolean; force?: boolean; silent?: boolean } = {},
  ) => {
    if (!options.silent) {
      setListLoading(true);
      setListError(null);
    }
    let showedCache = false;
    if (options.useCache !== false) {
      const cached = await loadCachedRegistryPackages();
      if (cached) {
        setRegistryList(cached);
        showedCache = true;
      }
    }
    try {
      const list = options.force
        ? await fetchRegistryPackages({ force: true })
        : await fetchRegistryPackages();
      setRegistryList(list);
    } catch (err) {
      if (!showedCache && !options.silent) setListError(String(err));
    } finally {
      if (!options.silent) setListLoading(false);
    }
  };

  useEffect(() => {
    void loadRegistryList();
    clearInstallLog();
  }, []);

  // 自动刷新开启：立刻静默重拉一次，之后每 30s 后台重拉最新（安装中暂停，
  // 避免与安装流程抢刷新）。关闭或卸载即停。
  useEffect(() => {
    // While the installer is open, it owns refresh (and pauses during install);
    // the app-level poller stands down. Same strict gate as the background one.
    const active =
      canBackgroundRefreshRegistry({ enabled: autoRefresh, devModeEnabled, hasValidToken }) &&
      !isInstalling;
    if (!active) return;
    void loadRegistryList({ useCache: false, force: true, silent: true });
    const id = setInterval(() => {
      void loadRegistryList({ useCache: false, force: true, silent: true });
    }, REGISTRY_AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, devModeEnabled, hasValidToken, isInstalling]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const unlistenDiscovered = await listen<string[]>("registry-search:discovered", (event) => {
        setRegistryList((cur) => {
          const seen = new Set((cur ?? []).map((p) => p.name));
          const additions = event.payload
            .filter((n) => !seen.has(n) && !n.endsWith("-coco"))
            .map((name) => ({
              name,
              latest_version: "...",
              newest_version: "...",
              description: null,
              tags: [],
              versions: [],
            }));
          if (additions.length === 0) return cur;
          return mergeRegistryPackages(cur, additions);
        });
      });
      const unlistenEnriched = await listen<RegistryPackage[]>("registry-search:enriched", (event) => {
        setRegistryList((cur) => mergeRegistryPackages(cur, event.payload));
      });
      if (disposed) {
        unlistenDiscovered();
        unlistenEnriched();
      } else {
        unlisten = () => {
          unlistenDiscovered();
          unlistenEnriched();
        };
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const prefill = useAppStore.getState().installerPrefill;
    if (prefill) {
      setManualSpec(prefill);
      useAppStore.getState().setInstallerPrefill("");
      return;
    }
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.installerPrefill && state.installerPrefill !== prev.installerPrefill) {
        setManualSpec(state.installerPrefill);
        setSelectedKeys(new Set());
        useAppStore.getState().setInstallerPrefill("");
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (isInstalling) {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((t) => t + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isInstalling]);

  // 只展示白名单客户端包（Rust 首拉已过滤；此处再挡一次，防旧磁盘缓存把
  // 后端 xxx-grpc 漏进来）。
  const allowedList = useMemo(
    () => (registryList ?? []).filter((p) => isAllowedClientPackage(p.name)),
    [registryList],
  );

  const familyFilter = useMemo(() => [...selectedFamilies], [selectedFamilies]);

  const searchResults = useMemo(() => {
    if (!registryList) return [];
    return filterPackageRows(allowedList, {
      query: searchQuery,
      branch: effectiveBranch,
      protocol: typeFilter,
      families: familyFilter,
    });
  }, [registryList, allowedList, searchQuery, effectiveBranch, typeFilter, familyFilter]);

  // 多选下拉展示全部家族（21 个 + js-sdk），所以放开条数上限。
  const nameSuggestions = useMemo(
    () => suggestPackageStems(allowedList, searchQuery, 50),
    [allowedList, searchQuery],
  );

  const toggleFamily = (stem: string) => {
    setSelectedFamilies((cur) => {
      const next = new Set(cur);
      if (next.has(stem)) next.delete(stem);
      else next.add(stem);
      return next;
    });
  };

  const clearFamilies = () => setSelectedFamilies(new Set());

  useEffect(() => () => {
    if (nameBlurTimer.current) clearTimeout(nameBlurTimer.current);
  }, []);

  // 结果集变化时，剔除已不在列表里的勾选项
  useEffect(() => {
    setSelectedKeys((cur) => {
      if (cur.size === 0) return cur;
      const visible = new Set(searchResults.map((pkg) => packageRowKey(pkg)));
      const next = new Set([...cur].filter((k) => visible.has(k)));
      return next.size === cur.size ? cur : next;
    });
  }, [searchResults]);

  const manualCompletedSpec = completePackageSpec(manualSpec);
  const hasManualSpec = manualSpec.trim().length > 0;
  // 勾选的包（按列表显示顺序 = 时间新→旧，批量安装即按此序）
  const selectedRows = searchResults.filter((pkg) => selectedKeys.has(packageRowKey(pkg)));
  const selectedSpecs = selectedRows.map(packageInstallSpec);
  const installSpecs = hasManualSpec ? [manualCompletedSpec] : selectedSpecs;
  const manualProtocol = hasManualSpec ? protocolFromSnsoftPackageSpec(manualCompletedSpec) : null;
  const canInstall =
    !isInstalling &&
    installSpecs.length > 0 &&
    installSpecs.every((s) => isAllowedSnsoftPackageSpec(s));

  const lastLog = installLog[installLog.length - 1] ?? "";
  const installDone =
    lastLog === "Installation complete!" ||
    lastLog === "Package removed!" ||
    lastLog.startsWith("Installation failed") ||
    lastLog.startsWith("Removal failed") ||
    lastLog.startsWith("Error:");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isInstalling) {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && installDone) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isInstalling, installDone, onClose]);

  const handleInstall = async () => {
    if (!canInstall) return;
    const specs = installSpecs;
    setIsInstalling(true);
    setBatchProgress(specs.length > 1 ? { done: 0, total: specs.length } : null);
    let okCount = 0;
    try {
      for (let i = 0; i < specs.length; i++) {
        if (specs.length > 1) setBatchProgress({ done: i, total: specs.length });
        const ok = await onInstall(specs[i]);
        if (ok) okCount += 1;
      }
      if (okCount === specs.length) {
        setManualSpec("");
        setSelectedKeys(new Set());
      }
    } finally {
      setIsInstalling(false);
      setBatchProgress(null);
    }
  };

  const toggleRow = (key: string) => {
    setSelectedKeys((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setManualSpec("");
  };

  // 复制该行的完整安装规格（@snsoft/x-grpc-web@版本），带 1.5s「已复制」反馈。
  const copySpec = async (key: string, spec: string) => {
    try {
      await navigator.clipboard.writeText(spec);
    } catch {
      // 剪贴板不可用时静默失败——不打断安装流程
    }
    setCopiedKey(key);
    setCopyToast(spec);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      setCopiedKey(null);
      setCopyToast(null);
    }, 1500);
  };

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const logStatus = (() => {
    const isSuccess = lastLog === "Installation complete!" || lastLog === "Package removed!";
    const isFailed =
      lastLog.startsWith("Installation failed") ||
      lastLog.startsWith("Removal failed") ||
      lastLog.startsWith("Error:");
    const logLines = isSuccess || isFailed ? installLog.slice(0, -1) : installLog;
    return { isSuccess, isFailed, logLines };
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/45 backdrop-blur-[6px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-50 flex h-[86vh] max-h-[880px] min-h-[560px] w-full max-w-[1040px] flex-col overflow-hidden rounded-xl border border-slate-700/70 bg-[#0b111a] shadow-[0_28px_80px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-slate-800/90 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-cyan-400/25 bg-cyan-400/10 text-cyan-300">
              <Package className="h-[18px] w-[18px]" />
            </div>
            <div>
              <h2 className="text-lg font-semibold leading-6 text-slate-50">安装包</h2>
              <p className="mt-0.5 text-[13px] text-slate-400">
                安装 gRPC / gRPC-Web / JS-SDK package
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isInstalling}
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-6 py-4">
          <section className="shrink-0">
            <label className="mb-1 block text-[11px] font-medium text-slate-300">包类型</label>
            <div className="flex flex-wrap gap-2">
              {TYPE_FILTERS.map((item) => {
                const active = typeFilter === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setTypeFilter(item.value)}
                    disabled={isInstalling}
                    className={cn(
                      "flex h-9 items-center gap-2 rounded-lg border px-4 text-sm font-medium transition-colors",
                      active
                        ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100"
                        : "border-slate-700/70 bg-slate-950/40 text-slate-300 hover:border-slate-600 hover:text-slate-100",
                    )}
                  >
                    {item.Icon ? (
                      <item.Icon className={cn("h-4 w-4", active ? "text-cyan-200" : item.iconClass)} />
                    ) : (
                      <span
                        className={cn(
                          "grid h-4 w-4 place-items-center rounded-[3px] text-[8px] font-bold leading-none",
                          active ? "bg-cyan-300/30 text-cyan-100" : "bg-purple-500/20 text-purple-300",
                        )}
                      >
                        JS
                      </span>
                    )}
                    {item.label}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 sm:flex-[65_1_0%]">
              <label className="mb-1 block text-[11px] font-medium text-slate-300">搜索包名</label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <Input
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setNameSuggestOpen(true);
                    setNameSuggestIdx(-1);
                  }}
                  // 只在已有输入时聚焦才重开下拉；空 query（含 Cmd+S 自动聚焦）不弹
                  onFocus={() => {
                    if (searchQuery.trim()) setNameSuggestOpen(true);
                  }}
                  // 点击输入框显式打开家族多选清单（Cmd+S 只聚焦不点击 → 不弹）
                  onClick={() => setNameSuggestOpen(true)}
                  onBlur={() => {
                    // 延迟关闭，让下拉项的 mousedown 先触发
                    nameBlurTimer.current = setTimeout(() => setNameSuggestOpen(false), 120);
                  }}
                  onKeyDown={(e) => {
                    const open = nameSuggestOpen && nameSuggestions.length > 0;
                    if (open && e.key === "ArrowDown") {
                      e.preventDefault();
                      setNameSuggestIdx((i) => Math.min(i + 1, nameSuggestions.length - 1));
                      return;
                    }
                    if (open && e.key === "ArrowUp") {
                      e.preventDefault();
                      setNameSuggestIdx((i) => Math.max(i - 1, -1));
                      return;
                    }
                    if (e.key === "Escape" && open) {
                      e.preventDefault();
                      setNameSuggestOpen(false);
                      return;
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (open && nameSuggestIdx >= 0) {
                        // 高亮的家族 → 勾选/取消（多选，下拉保持打开）
                        toggleFamily(nameSuggestions[nameSuggestIdx]);
                      } else if (searchResults.length > 0) {
                        toggleRow(packageRowKey(searchResults[0]));
                      }
                    }
                  }}
                  placeholder="搜索 / 勾选产品线，例如：player, auth, ccms"
                  name="penguin-package-search"
                  disabled={isInstalling}
                  autoFocus
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="h-9 rounded-md border-cyan-400/55 bg-slate-950/35 pl-10 pr-14 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-cyan-400/70"
                />
                <button
                  type="button"
                  // 清空搜索词 + 取消所有已勾选的产品线（移除筛选，恢复全部）
                  onClick={() => {
                    setSearchQuery("");
                    setSelectedFamilies(new Set());
                    setNameSuggestIdx(-1);
                  }}
                  disabled={isInstalling}
                  className="absolute right-8 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-500 hover:text-slate-200"
                  aria-label="清除包名搜索与产品线筛选"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="展开产品线清单"
                  // mousedown 早于 input blur，避免先关再开
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setNameSuggestOpen((o) => !o);
                  }}
                  disabled={isInstalling}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:text-slate-300"
                >
                  <ChevronDown
                    className={cn("h-4 w-4 transition-transform", nameSuggestOpen && "rotate-180")}
                  />
                </button>
                {nameSuggestOpen && nameSuggestions.length > 0 && (
                  <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-64 overflow-y-auto rounded-lg border border-slate-700/80 bg-[#0d1420] py-1 shadow-[0_16px_40px_rgba(0,0,0,0.5)]">
                    {nameSuggestions.map((stem, i) => {
                      const checked = selectedFamilies.has(stem);
                      return (
                        <button
                          key={stem}
                          type="button"
                          // mousedown 早于 input 的 blur，避免下拉先被关掉；勾选后保持打开
                          onMouseDown={(e) => {
                            e.preventDefault();
                            toggleFamily(stem);
                          }}
                          onMouseEnter={() => setNameSuggestIdx(i)}
                          className={cn(
                            "flex w-full items-center gap-2.5 px-3 py-1.5 text-left font-mono text-[13px]",
                            i === nameSuggestIdx
                              ? "bg-cyan-500/15 text-cyan-100"
                              : "text-slate-200 hover:bg-white/5",
                          )}
                        >
                          <span
                            className={cn(
                              "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                              checked
                                ? "border-cyan-400 bg-cyan-400 text-slate-950"
                                : "border-slate-600",
                            )}
                          >
                            {checked && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                          </span>
                          {stem}
                        </button>
                      );
                    })}
                    {selectedFamilies.size > 0 && (
                      <div className="mt-1 border-t border-slate-800 px-3 pb-0.5 pt-1.5">
                        <button
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            clearFamilies();
                          }}
                          className="text-[11px] text-slate-400 hover:text-cyan-300"
                        >
                          清除筛选（已选 {selectedFamilies.size}）
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="min-w-0 sm:flex-[35_1_0%]">
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="block text-[11px] font-medium text-slate-300">搜索分支</label>
                <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-slate-400">
                  <input
                    type="checkbox"
                    checked={masterOnly}
                    onChange={(e) => setMasterOnly(e.target.checked)}
                    disabled={isInstalling}
                    className="h-3.5 w-3.5 accent-cyan-500"
                  />
                  仅 master
                </label>
              </div>
              <div className="relative">
                <GitBranch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <Input
                  value={branchQuery}
                  onChange={(e) => {
                    setBranchQuery(e.target.value);
                    setMasterOnly(false);
                  }}
                  placeholder={masterOnly ? "已锁定 master（勾选框控制）" : "搜索分支，例如：brazil-v2"}
                  name="penguin-branch-search"
                  disabled={isInstalling || masterOnly}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="h-9 rounded-md border-slate-700/80 bg-slate-950/35 pl-10 pr-9 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-cyan-400/70 disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setBranchQuery("")}
                  disabled={isInstalling || masterOnly}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-500 hover:text-slate-200 disabled:opacity-40"
                  aria-label="清除分支筛选"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <button
              type="button"
              // admin/super-admin：自动刷新开关（绿色=开，每 30s 后台拉最新）；
              // 普通用户：点一下刷新一次，无自动。
              title={
                canAutoRefresh
                  ? autoRefresh
                    ? "自动刷新：开（每 30s 拉取最新，点击关闭）"
                    : "自动刷新：关（点击开启）"
                  : "刷新"
              }
              aria-pressed={canAutoRefresh ? autoRefresh : undefined}
              onClick={() => {
                if (canAutoRefresh) setInstallerAutoRefresh(!autoRefresh);
                else void loadRegistryList({ useCache: false, force: true });
              }}
              disabled={isInstalling || (!canAutoRefresh && listLoading)}
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-45",
                canAutoRefresh && autoRefresh
                  ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-300 hover:bg-emerald-400/25"
                  : "border-slate-700/80 bg-slate-950/40 text-slate-300 hover:border-cyan-400/50 hover:bg-cyan-400/10 hover:text-cyan-200",
              )}
            >
              {/* 绿灯（自动刷新开）持续旋转；普通用户单次刷新时转到加载完成 */}
              <RefreshCw
                className={cn(
                  "h-4 w-4",
                  ((canAutoRefresh && autoRefresh) || (!canAutoRefresh && listLoading)) &&
                    "animate-spin",
                )}
              />
            </button>
          </section>

          {/* flex-1 吃掉剩余空间（正常窗口 5-6+ 行）；min-h 给个下限，安装日志出现时
              结果区不会被挤成 1 行——放不下时由 body 整体滚动（footer 在 body 外，不重叠） */}
          <section className="flex min-h-[220px] flex-1 flex-col">
            <div className="mb-1.5 flex shrink-0 items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <label className="block text-[11px] font-medium text-slate-300">搜索结果</label>
                {selectedKeys.size > 0 && (
                  <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[11px] font-medium text-cyan-200">
                    已选 {selectedKeys.size}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-[11px] text-slate-400">
                {selectedKeys.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedKeys(new Set())}
                    disabled={isInstalling}
                    className="text-slate-400 hover:text-slate-200 disabled:opacity-50"
                  >
                    清除勾选
                  </button>
                )}
                {registryList && <span>共 {searchResults.length} 个结果</span>}
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-800/80 bg-slate-950/25">
              {listError ? (
                <div className="m-2 rounded-md border border-yellow-500/25 bg-yellow-500/10 px-3 py-3 text-sm text-yellow-200">
                  搜索不可用：{listError}
                </div>
              ) : listLoading && !registryList ? (
                <div className="flex items-center gap-2 px-3 py-8 text-sm text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin text-cyan-300" />
                  正在从 registry 拉取包列表...
                </div>
              ) : registryList && searchResults.length === 0 ? (
                <div className="px-3 py-8 text-sm text-slate-500">
                  没有匹配的包 / 分支{branchQuery ? "（试试放宽分支关键字）" : ""}
                </div>
              ) : registryList ? (
                <div className="min-h-0 flex-1 divide-y divide-slate-800/70 overflow-y-auto pb-1">
                  {searchResults.map((pkg) => {
                    const key = packageRowKey(pkg);
                    const selected = selectedKeys.has(key) && !hasManualSpec;
                    const installed = isPackageRowInstalled(pkg, packages);
                    const stamp = stampFromVersion(pkg.version);
                    return (
                      <div
                        key={key}
                        role="button"
                        tabIndex={0}
                        aria-label={`复制 ${packageInstallSpec(pkg)}`}
                        // 整行点击 = 复制安装规格；勾选用左侧的勾选框（独立点击）
                        // 点击整行 = 复制规格 + 同时勾选（下方勾选框仍可单独勾选/取消）
                        onClick={() => {
                          void copySpec(key, packageInstallSpec(pkg));
                          if (!isInstalling) toggleRow(key);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            void copySpec(key, packageInstallSpec(pkg));
                            if (!isInstalling) toggleRow(key);
                          }
                        }}
                        className={cn(
                          "group grid min-h-[63px] w-full cursor-pointer grid-cols-[minmax(0,1fr)_190px_168px_84px_44px] items-center gap-4 border px-4 py-2 text-left transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60",
                          selected
                            ? "border-cyan-400/70 bg-cyan-500/10"
                            : "border-transparent hover:bg-slate-900/55",
                        )}
                      >
                        {/* 名称列：勾选框（点击=选择安装） + 图标块 + （包名 / 版本） */}
                        <div className="flex min-w-0 items-center gap-3">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!isInstalling) toggleRow(key);
                            }}
                            disabled={isInstalling}
                            aria-pressed={selected}
                            aria-label={selected ? "取消选择" : "选择以安装"}
                            title={selected ? "取消选择" : "选择以安装"}
                            className="shrink-0 rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60 disabled:opacity-50"
                          >
                            <RowCheck selected={selected} />
                          </button>
                          <ProtocolIcon protocol={pkg.protocol} />
                          <div className="min-w-0">
                            <div
                              title={pkg.name}
                              className="truncate font-mono text-sm font-semibold text-slate-50"
                            >
                              {pkg.name}
                            </div>
                            <div
                              title={pkg.version}
                              className="mt-1 truncate font-mono text-[12px] text-slate-400"
                            >
                              {pkg.version}
                            </div>
                          </div>
                        </div>
                        {/* 构建时间列 */}
                        <span className="flex items-center gap-1.5 whitespace-nowrap font-mono text-[12px] tabular-nums text-slate-400">
                          <Clock className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                          {stamp ? fmtStamp(stamp) : "-"}
                        </span>
                        {/* 分支列 */}
                        <div className="min-w-0">
                          {pkg.branch ? <BranchChip branch={pkg.branch} /> : null}
                        </div>
                        {/* 状态列 */}
                        <div className="flex justify-end">
                          {installed && (
                            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                              <CheckCircle2 className="h-3 w-3" />
                              已安装
                            </span>
                          )}
                        </div>
                        {/* 复制安装规格列：hover 显示复制按钮；已复制变绿勾 */}
                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void copySpec(key, packageInstallSpec(pkg));
                            }}
                            title={`复制 ${packageInstallSpec(pkg)}`}
                            aria-label={`复制 ${packageInstallSpec(pkg)}`}
                            className={cn(
                              "flex h-7 w-7 items-center justify-center rounded-md transition-all hover:bg-white/10 hover:text-slate-100 focus:outline-none focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-cyan-400/60",
                              copiedKey === key
                                ? "text-emerald-300 opacity-100"
                                : "text-slate-400 opacity-0 group-hover:opacity-100",
                            )}
                          >
                            {copiedKey === key ? (
                              <Check className="h-4 w-4" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </section>

          <section className="shrink-0 rounded-lg border border-slate-700/70 bg-slate-900/40 p-3">
            <div className="mb-2 flex items-center gap-1.5">
              <Braces className="h-3.5 w-3.5 text-cyan-300" />
              <span className="text-xs font-semibold text-slate-200">手动输入包规格</span>
              <span className="text-[11px] font-normal text-slate-500">（可选）</span>
            </div>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-slate-500">
                @
              </span>
              <Input
                value={manualSpec}
                onChange={(e) => {
                  setManualSpec(normalizePackageSpec(e.target.value));
                  setSelectedKeys(new Set());
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (installDone) {
                      onClose();
                      return;
                    }
                    if (canInstall) void handleInstall();
                  }
                }}
                placeholder="例如：@snsoft/example-grpc-web@1.0.0"
                disabled={isInstalling}
                className="h-9 rounded-md border-slate-700/80 bg-slate-950/35 pl-9 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-cyan-400/70"
              />
              {manualProtocol && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md border border-cyan-400/25 bg-cyan-400/10 px-2 py-0.5 text-xs text-cyan-200">
                  {PROTOCOL_LABELS[manualProtocol]}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-500">不填写版本时默认安装 latest</p>
          </section>

          {(installLog.length > 0 || isInstalling) && (
            <section className="shrink-0 space-y-2">
              {logStatus.logLines.length > 0 && (
                <div className="max-h-24 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/50 p-2 font-mono text-[10px] text-slate-400">
                  {logStatus.logLines.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              )}
              {isInstalling && !logStatus.isSuccess && !logStatus.isFailed && (
                <div className="flex items-center gap-3 rounded-md border border-cyan-400/25 bg-cyan-400/10 px-3 py-2">
                  <Loader2 className="h-5 w-5 animate-spin text-cyan-300" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-cyan-100">安装中...</p>
                    <p className="text-xs text-cyan-200/65">大型包可能需要较长时间</p>
                  </div>
                  <span className="font-mono text-xs tabular-nums text-cyan-200">
                    {formatElapsed(elapsed)}
                  </span>
                </div>
              )}
              {logStatus.isSuccess && (
                <div className="flex items-center gap-3 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-2">
                  <CheckCircle2 className="h-5 w-5 text-emerald-300" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-emerald-200">安装成功</p>
                    <p className="text-xs text-emerald-200/65">
                      Package is ready to use ({formatElapsed(elapsed)})
                    </p>
                  </div>
                </div>
              )}
              {logStatus.isFailed && (
                <div className="flex items-center gap-3 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2">
                  <XCircle className="h-5 w-5 text-red-300" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-red-200">安装失败</p>
                    <p className="truncate text-xs text-red-200/70">{lastLog}</p>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2.5 border-t border-slate-800/90 px-6 py-4">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isInstalling}
            className="h-10 border-slate-700 bg-transparent px-5 text-slate-100 hover:bg-white/5"
          >
            取消
          </Button>
          <Button
            onClick={handleInstall}
            disabled={!canInstall}
            className="h-10 bg-cyan-500 px-6 font-medium text-slate-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-cyan-500/30 disabled:text-cyan-50/70"
          >
            <Download className="h-4 w-4" />
            {isInstalling
              ? batchProgress
                ? `安装中 ${batchProgress.done + 1}/${batchProgress.total}`
                : "安装中"
              : !hasManualSpec && selectedSpecs.length > 1
                ? `安装 ${selectedSpecs.length} 个`
                : "安装"}
          </Button>
        </footer>
      </div>

      {copyToast &&
        createPortal(
          <div className="pointer-events-none fixed inset-x-0 bottom-8 z-[80] flex justify-center">
            <div className="flex max-w-[90vw] items-center gap-2 rounded-lg border border-emerald-400/30 bg-[#0d1420] px-4 py-2.5 shadow-[0_12px_32px_rgba(0,0,0,0.6)]">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-300" />
              <span className="text-sm font-medium text-slate-100">已复制</span>
              <span className="truncate font-mono text-[12px] text-slate-400">{copyToast}</span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
