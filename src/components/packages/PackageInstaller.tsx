import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  CheckCircle2,
  Clock,
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
  completePackageSpec,
  filterPackageRows,
  isPackageRowInstalled,
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

function RowRadio({ selected }: { selected: boolean }) {
  return (
    <span
      className={cn(
        "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 transition-colors",
        selected ? "border-cyan-400" : "border-slate-600",
      )}
      aria-hidden="true"
    >
      {selected && <span className="h-2 w-2 rounded-full bg-cyan-400" />}
    </span>
  );
}

function TypeChip({ protocol }: { protocol: PackageProtocol }) {
  return (
    <span
      className={cn(
        // 自然紧凑宽度；版本对齐由外层 mini-grid 的固定列负责
        "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded px-2 text-[11px] font-medium leading-none",
        protocol === "sdk"
          ? "border border-purple-400/25 bg-purple-500/15 text-purple-200"
          : "border border-cyan-400/20 bg-cyan-400/10 text-cyan-200",
      )}
    >
      {PROTOCOL_LABELS[protocol]}
    </span>
  );
}

function BranchChip({ branch }: { branch: string }) {
  if (!branch) return null;
  return (
    <span
      title={branch}
      // 填满分支列：无论分支名长短，chip 统一成同宽的框，过长截断
      className="inline-flex h-5 w-full items-center gap-1 whitespace-nowrap rounded-md border border-slate-700/70 bg-slate-800/70 px-2 text-[11px] leading-none text-slate-300"
    >
      <GitBranch className="h-3 w-3 shrink-0 text-slate-400" />
      <span className="truncate">{branch}</span>
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
  const [branchQuery, setBranchQuery] = useState("");
  const [manualSpec, setManualSpec] = useState("");
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [registryList, setRegistryList] = useState<RegistryPackage[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadRegistryList = async (
    options: { useCache?: boolean; force?: boolean } = {},
  ) => {
    setListLoading(true);
    setListError(null);
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
      if (!showedCache) setListError(String(err));
    } finally {
      setListLoading(false);
    }
  };

  useEffect(() => {
    void loadRegistryList();
    clearInstallLog();
  }, []);

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
        setSelectedRowKey(null);
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

  const searchResults = useMemo(() => {
    if (!registryList) return [];
    return filterPackageRows(registryList, {
      query: searchQuery,
      branch: branchQuery,
      protocol: typeFilter,
    });
  }, [registryList, searchQuery, branchQuery, typeFilter]);

  useEffect(() => {
    if (selectedRowKey && !searchResults.some((pkg) => packageRowKey(pkg) === selectedRowKey)) {
      setSelectedRowKey(null);
    }
  }, [searchResults, selectedRowKey]);

  const manualCompletedSpec = completePackageSpec(manualSpec);
  const hasManualSpec = manualSpec.trim().length > 0;
  const selectedPackage = selectedRowKey
    ? searchResults.find((pkg) => packageRowKey(pkg) === selectedRowKey)
    : null;
  const selectedSpec = selectedPackage
    ? packageInstallSpec(selectedPackage)
    : "";
  const installSpec = hasManualSpec ? manualCompletedSpec : selectedSpec;
  const manualProtocol = hasManualSpec ? protocolFromSnsoftPackageSpec(manualCompletedSpec) : null;
  const canInstall = installSpec.length > 0 && isAllowedSnsoftPackageSpec(installSpec) && !isInstalling;

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
    setIsInstalling(true);
    try {
      const ok = await onInstall(installSpec);
      if (ok) {
        setManualSpec("");
        setSelectedRowKey(null);
      }
    } finally {
      setIsInstalling(false);
    }
  };

  const selectPackage = (key: string) => {
    setSelectedRowKey((cur) => (cur === key ? null : key));
    setManualSpec("");
  };

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
        <header className="flex shrink-0 items-start justify-between border-b border-slate-800/90 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-400/25 bg-cyan-400/10 text-cyan-300">
              <Package className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-xl font-semibold leading-6 text-slate-50">安装包</h2>
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

        <div className="flex min-h-0 flex-1 flex-col gap-5 px-6 py-5">
          <section className="shrink-0">
            <label className="mb-1.5 block text-[11px] font-medium text-slate-300">包类型</label>
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
              <label className="mb-1.5 block text-[11px] font-medium text-slate-300">搜索包名</label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && searchResults.length > 0) {
                      e.preventDefault();
                      selectPackage(packageRowKey(searchResults[0]));
                    }
                  }}
                  placeholder="搜索包名，例如：player, auth, ccms"
                  name="penguin-package-search"
                  disabled={isInstalling}
                  autoFocus
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="h-9 rounded-md border-cyan-400/55 bg-slate-950/35 pl-10 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-cyan-400/70"
                />
              </div>
            </div>
            <div className="min-w-0 sm:flex-[35_1_0%]">
              <label className="mb-1.5 block text-[11px] font-medium text-slate-300">搜索分支</label>
              <div className="relative">
                <GitBranch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <Input
                  value={branchQuery}
                  onChange={(e) => setBranchQuery(e.target.value)}
                  placeholder="搜索分支，例如：brazil-v2"
                  name="penguin-branch-search"
                  disabled={isInstalling}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="h-9 rounded-md border-slate-700/80 bg-slate-950/35 pl-10 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-cyan-400/70"
                />
                {branchQuery && (
                  <button
                    type="button"
                    onClick={() => setBranchQuery("")}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-500 hover:text-slate-200"
                    aria-label="清除分支筛选"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
            <button
              type="button"
              title="刷新"
              onClick={() => void loadRegistryList({ useCache: false, force: true })}
              disabled={listLoading || isInstalling}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-700/80 bg-slate-950/40 text-slate-300 transition-colors hover:border-cyan-400/50 hover:bg-cyan-400/10 hover:text-cyan-200 disabled:opacity-45"
            >
              <RefreshCw className={cn("h-4 w-4", listLoading && "animate-spin")} />
            </button>
          </section>

          <section className="flex min-h-0 flex-1 flex-col">
            <div className="mb-1.5 flex shrink-0 items-center justify-between gap-3">
              <label className="block text-[11px] font-medium text-slate-300">搜索结果</label>
              {registryList && (
                <span className="text-[11px] text-slate-400">共 {searchResults.length} 个结果</span>
              )}
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
                    const selected = selectedRowKey === key && !hasManualSpec;
                    const installed = isPackageRowInstalled(pkg, packages);
                    const stamp = stampFromVersion(pkg.version);
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => selectPackage(key)}
                        disabled={isInstalling}
                        className={cn(
                          "grid min-h-[68px] w-full grid-cols-[minmax(0,1fr)_190px_168px_84px] items-center gap-4 border px-4 py-2.5 text-left transition-colors",
                          selected
                            ? "border-cyan-400/70 bg-cyan-500/10"
                            : "border-transparent hover:bg-slate-900/55",
                        )}
                      >
                        {/* 名称列：单选 + 图标块 + （包名 / 类型 chip + 版本） */}
                        <div className="flex min-w-0 items-center gap-3">
                          <RowRadio selected={selected} />
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
                            <Package className="h-[18px] w-[18px]" />
                          </div>
                          <div className="min-w-0">
                            <div
                              title={pkg.name}
                              className="truncate font-mono text-sm font-semibold text-slate-50"
                            >
                              {pkg.name}
                            </div>
                            {/* mini-grid：chip 自然宽度居左，版本号固定从 70px 起对齐 */}
                            <div className="mt-1 grid grid-cols-[70px_minmax(0,1fr)] items-center gap-2">
                              <TypeChip protocol={pkg.protocol} />
                              <span
                                title={pkg.version}
                                className="min-w-0 truncate font-mono text-[12px] text-slate-400"
                              >
                                {pkg.version}
                              </span>
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
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </section>

          <section className="shrink-0">
            <label className="mb-1.5 block text-[11px] font-medium text-slate-300">
              手动输入包规格（可选）
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-slate-500">
                @
              </span>
              <Input
                value={manualSpec}
                onChange={(e) => {
                  setManualSpec(normalizePackageSpec(e.target.value));
                  setSelectedRowKey(null);
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

        <footer className="flex items-center justify-end gap-2.5 border-t border-slate-800/90 px-5 py-3">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isInstalling}
            className="h-9 border-slate-700 bg-transparent px-5 text-slate-100 hover:bg-white/5"
          >
            取消
          </Button>
          <Button
            onClick={handleInstall}
            disabled={!canInstall}
            className="h-9 bg-cyan-500 px-6 text-slate-950 hover:bg-cyan-400 disabled:bg-cyan-500/40"
          >
            <Download className="h-4 w-4" />
            {isInstalling ? "安装中" : "安装"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
