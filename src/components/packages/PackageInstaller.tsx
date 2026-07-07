import { useState, useEffect, useRef, useMemo } from "react";
import { useAppStore, useActiveTab, type InstalledPackage } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Package, X, Download, CheckCircle2, XCircle, Loader2, Search, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { isAllowedSnsoftPackageSpec, normalizePackageSpec, protocolFromSnsoftPackageSpec } from "@penguin/core";
import { filterPackages, protocolOfPackage, type PackageProtocol, type RegistryPackage } from "@/lib/registry-search-core";
import { fetchPackageVersions, fetchRegistryPackages, loadCachedRegistryPackages, type PackageVersions } from "@/lib/registry-search";

function detectProtocol(spec: string): "grpc-web" | "grpc" | "sdk" | null {
  return protocolFromSnsoftPackageSpec(spec);
}

// Split a spec into name + version on the LAST "@" (the scope's leading
// "@" sits at index 0). "@snsoft/auth-grpc@2.1.1-2026…" → name/version.
function splitSpec(spec: string): { name: string; version: string } {
  const trimmed = spec.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return { name: trimmed, version: "" };
  return { name: trimmed.slice(0, at), version: trimmed.slice(at + 1) };
}

// snsoft build versions carry a 14-digit YYYYMMDDHHMMSS stamp
// (e.g. "2.1.1-20260624172317") — that's the package's build time.
function stampFromVersion(version: string): Date | null {
  const m = version.match(/(\d{14})(?:\D|$)/);
  if (!m) return null;
  const s = m[1];
  const dt = new Date(
    +s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8),
    +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14),
  );
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// 用户拍板的可读格式：YYYY-MM-DD hh:mm:ss A（12 小时制 + AM/PM）
function fmtStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const h24 = d.getHours();
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(h12)}:${p(d.getMinutes())}:${p(d.getSeconds())} ${ampm}`;
}

const PROTOCOL_LABELS: Record<string, string> = {
  "grpc-web": "gRPC-Web",
  grpc: "gRPC",
  sdk: "JS-SDK",
  rest: "REST",
};

interface PackageInstallerProps {
  onInstall: (spec: string) => Promise<boolean>;
  onClose: () => void;
  // Currently-installed packages (active protocol) — used to show an
  // already-installed version + build time to compare against this spec.
  packages: InstalledPackage[];
}

const PLACEHOLDERS: Record<string, string> = {
  "grpc-web":
    "e.g. @snsoft/example-grpc-web@1.0.0",
  grpc: "e.g. @snsoft/example-grpc@1.0.0",
  sdk: "e.g. @snsoft/js-sdk@1.0.0",
  rest: "REST requests do not require package installation",
};

export function PackageInstaller({ onInstall, onClose, packages }: PackageInstallerProps) {
  const tab = useActiveTab();
  const protocolTab = tab?.protocolTab ?? "grpc-web";
  const installLog = useAppStore((s) => s.installLog);
  const clearInstallLog = useAppStore((s) => s.clearInstallLog);
  const [spec, setSpec] = useState("");
  const [isInstalling, setIsInstalling] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // —— Sonatype 模糊搜索状态 ——
  const [searchQuery, setSearchQuery] = useState("");
  // 默认全部协议：团队按项目 tag 成对装 -grpc-web / -grpc，且 js-sdk 要能被
  // 任何页签搜到；勾选后才收窄到当前页签。
  const [allProtocols, setAllProtocols] = useState(true);
  const [registryList, setRegistryList] = useState<RegistryPackage[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedPkg, setSelectedPkg] = useState<string | null>(null);
  const [versionsInfo, setVersionsInfo] = useState<PackageVersions | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  // stale-while-revalidate：缓存先秒出，同时永远实时重爬、完成后替换。
  // 有缓存在展示时，刷新失败保持静默（旧列表仍可用）。
  const loadRegistryList = async () => {
    setListLoading(true);
    setListError(null);
    let showedCache = false;
    const cached = await loadCachedRegistryPackages();
    if (cached) {
      setRegistryList(cached);
      showedCache = true;
    }
    try {
      const list = await fetchRegistryPackages();
      setRegistryList(list);
    } catch (err) {
      if (!showedCache) setListError(String(err));
    } finally {
      setListLoading(false);
    }
  };

  useEffect(() => {
    if (protocolTab !== "rest") void loadRegistryList();
  }, []);

  const searchResults = useMemo(() => {
    if (!registryList) return [];
    const protocol = allProtocols
      ? null
      : ((protocolTab === "rest" ? null : protocolTab) as PackageProtocol | null);
    return filterPackages(registryList, searchQuery, protocol);
  }, [registryList, searchQuery, allProtocols, protocolTab]);

  const selectPackage = (name: string) => {
    if (selectedPkg === name) {
      setSelectedPkg(null);
      return;
    }
    setSelectedPkg(name);
    setVersionsInfo(null);
    setVersionsError(null);
    setVersionsLoading(true);
    fetchPackageVersions(name)
      .then((info) => setVersionsInfo(info))
      .catch((err) => setVersionsError(String(err)))
      .finally(() => setVersionsLoading(false));
  };

  const pickVersion = (name: string, version: string) => {
    setSpec(`${name}@${version}`);
  };

  useEffect(() => { clearInstallLog(); }, []);

  useEffect(() => {
    const prefill = useAppStore.getState().installerPrefill;
    if (prefill) {
      setSpec(prefill);
      useAppStore.getState().setInstallerPrefill("");
      return;
    }
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.installerPrefill && state.installerPrefill !== prev.installerPrefill) {
        setSpec(state.installerPrefill);
        useAppStore.getState().setInstallerPrefill("");
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (isInstalling) {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((t) => t +1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isInstalling]);

  const detectedProtocol = detectProtocol(spec);
  const isValid = isAllowedSnsoftPackageSpec(spec);

  // Compare the typed spec against an already-installed package of the
  // same name — surfaces the installed version + build time so the user
  // can tell whether this spec is newer / older / identical.
  const comparison = useMemo(() => {
    const { name, version } = splitSpec(spec);
    if (!name) return null;
    const installed = packages.find((p) => p.name === name) ?? null;
    if (!installed) return null;
    const installedStamp = stampFromVersion(installed.version);
    const newStamp = stampFromVersion(version);
    let relation: "newer" | "older" | "same" | null = null;
    if (version) {
      if (version === installed.version) relation = "same";
      else if (installedStamp && newStamp) relation = newStamp > installedStamp ? "newer" : "older";
    }
    return { installed, installedStamp, version, newStamp, relation };
  }, [spec, packages]);

  const lastLog = installLog[installLog.length - 1] ?? "";
  const installDone =
    lastLog === "Installation complete!" ||
    lastLog === "Package removed!" ||
    lastLog.startsWith("Installation failed") ||
    lastLog.startsWith("Removal failed") ||
    lastLog.startsWith("Error:");

  // Global keyboard close: Esc closes (unless mid-install, matching the
  // disabled Cancel); once an install finishes, Enter closes too — works
  // no matter where focus landed after the install (the input's own
  // Enter handler only fires while it's focused).
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
    const trimmed = spec.trim();
    if (!trimmed || !isValid) return;

    setIsInstalling(true);

    try {
      const ok = await onInstall(trimmed);
      if (ok) {
        setSpec("");
      }
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        className="relative z-50 w-full max-w-xl rounded-lg border border-border bg-popover p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border pb-4">
          <div className="flex items-center gap-2">
            <Package className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">
              Install Package / 安装包
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          {protocolTab !== "rest" && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Search registry / 搜索 Sonatype
              </label>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && searchResults.length > 0) {
                        e.preventDefault();
                        selectPackage(searchResults[0].name);
                      }
                    }}
                    placeholder="fuzzy search, e.g. auth grpc / 模糊搜索"
                    className="pl-8 text-sm"
                    disabled={isInstalling}
                    autoFocus
                  />
                </div>
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={!allProtocols}
                    onChange={(e) => setAllProtocols(!e.target.checked)}
                    className="h-3 w-3 accent-primary"
                  />
                  仅当前协议 / {PROTOCOL_LABELS[protocolTab] ?? protocolTab}
                </label>
                <button
                  type="button"
                  title="Refresh list / 刷新列表"
                  onClick={() => void loadRegistryList()}
                  disabled={listLoading || isInstalling}
                  className="rounded p-1.5 text-muted-foreground hover:bg-accent disabled:opacity-40"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", listLoading && "animate-spin")} />
                </button>
              </div>

              {listError ? (
                <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-600 dark:text-amber-400">
                  搜索不可用：{listError}
                  <div className="mt-0.5 text-[10px] opacity-80">
                    手动输入安装不受影响 / Manual install below still works
                  </div>
                </div>
              ) : listLoading && !registryList ? (
                <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  首次拉取需遍历 Nexus 全部版本，可能 10-30 秒；之后秒开（本地缓存）
                </div>
              ) : registryList && searchResults.length === 0 ? (
                <div className="mt-2 rounded-md border border-border bg-muted/30 p-2 text-[11px] text-muted-foreground">
                  No match / 无匹配{!allProtocols ? " — 试试取消「仅当前协议」" : ""} — 也可直接在下方手动输入
                </div>
              ) : registryList ? (
                <div className="mt-2 max-h-56 divide-y divide-border/50 overflow-y-auto rounded-md border border-border">
                  {searchResults.map((pkg) => {
                    const pkgProtocol = protocolOfPackage(pkg.name);
                    const isSelected = selectedPkg === pkg.name;
                    const installed = packages.find((p) => p.name === pkg.name);
                    return (
                      <div key={pkg.name}>
                        <button
                          type="button"
                          onClick={() => selectPackage(pkg.name)}
                          disabled={isInstalling}
                          className={cn(
                            "flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent/60",
                            isSelected && "bg-accent/40"
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                            {pkg.name}
                          </span>
                          {pkg.tags.slice(0, 2).map((t) => (
                            <span
                              key={t}
                              className="max-w-32 shrink-0 truncate rounded bg-amber-500/15 px-1 py-0.5 text-[9px] text-amber-600 dark:text-amber-400"
                              title={t}
                            >
                              {t}
                            </span>
                          ))}
                          {pkg.tags.length > 2 && (
                            <span className="shrink-0 text-[9px] text-muted-foreground/70">
                              +{pkg.tags.length - 2}
                            </span>
                          )}
                          {installed && (
                            <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 text-[9px] text-primary">
                              installed
                            </span>
                          )}
                          {pkgProtocol && (
                            <span
                              className={cn(
                                "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium",
                                pkgProtocol === "grpc-web" && "bg-green-500/20 text-green-600 dark:text-green-400",
                                pkgProtocol === "grpc" && "bg-blue-500/20 text-blue-600 dark:text-blue-400",
                                pkgProtocol === "sdk" && "bg-purple-500/20 text-purple-600 dark:text-purple-400"
                              )}
                            >
                              {PROTOCOL_LABELS[pkgProtocol] ?? pkgProtocol}
                            </span>
                          )}
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                            {pkg.latest_version}
                          </span>
                        </button>
                        {isSelected && (
                          <div className="border-t border-border/50 bg-muted/30">
                            {versionsLoading ? (
                              <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] text-muted-foreground">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Loading versions… / 拉取版本中…
                              </div>
                            ) : versionsError ? (
                              <div className="px-3 py-1.5 text-[10px] text-amber-600 dark:text-amber-400">
                                {versionsError}
                              </div>
                            ) : versionsInfo ? (
                              <div className="max-h-48 overflow-y-auto">
                                {Object.keys(versionsInfo.tags).filter((t) => t !== "latest").length > 0 && (
                                  <>
                                    <div className="px-3 pb-0.5 pt-1.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/60">
                                      Project tags / 项目标签
                                    </div>
                                    {Object.entries(versionsInfo.tags)
                                      .filter(([t]) => t !== "latest")
                                      .sort(([a], [b]) => a.localeCompare(b))
                                      .map(([tag, resolved]) => {
                                        const isPicked = spec === `${pkg.name}@${tag}`;
                                        return (
                                          <button
                                            key={tag}
                                            type="button"
                                            onClick={() => pickVersion(pkg.name, tag)}
                                            disabled={isInstalling}
                                            className={cn(
                                              "flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-accent/60",
                                              isPicked && "bg-primary/10"
                                            )}
                                          >
                                            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-amber-600 dark:text-amber-400">
                                              @{tag}
                                            </span>
                                            <span className="shrink-0 font-mono text-[9px] text-muted-foreground/70">
                                              → {resolved}
                                            </span>
                                          </button>
                                        );
                                      })}
                                    <div className="px-3 pb-0.5 pt-1.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground/60">
                                      Versions / 版本
                                    </div>
                                  </>
                                )}
                                {versionsInfo.versions.map((v) => {
                                  const stamp = stampFromVersion(v);
                                  const isLatest = v === versionsInfo.latest;
                                  const isInstalled = installed?.version === v;
                                  const isPicked = spec === `${pkg.name}@${v}`;
                                  return (
                                    <button
                                      key={v}
                                      type="button"
                                      onClick={() => pickVersion(pkg.name, v)}
                                      disabled={isInstalling}
                                      className={cn(
                                        "flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-accent/60",
                                        isPicked && "bg-primary/10"
                                      )}
                                    >
                                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                                        {v}
                                      </span>
                                      {isLatest && (
                                        <span className="shrink-0 rounded bg-green-500/15 px-1 py-0.5 text-[9px] text-green-500">
                                          latest
                                        </span>
                                      )}
                                      {isInstalled && (
                                        <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 text-[9px] text-primary">
                                          installed
                                        </span>
                                      )}
                                      {stamp && (
                                        <span className="shrink-0 font-mono text-[9px] text-muted-foreground/70">
                                          {fmtStamp(stamp)}
                                        </span>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Package spec / 包规格
            </label>
            <div className="flex gap-2">
              <Input
                value={spec}
                onChange={(e) => setSpec(normalizePackageSpec(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (installDone) { onClose(); return; }
                    if (isValid && !isInstalling) handleInstall();
                  }
                }}
                placeholder={PLACEHOLDERS[protocolTab] ?? PLACEHOLDERS["grpc-web"]}
                className="font-mono text-sm"
                disabled={isInstalling}
              />
              {detectedProtocol && (
                <span
                  className={cn(
                    "flex shrink-0 items-center self-center rounded px-2 py-0.5 text-[10px] font-medium",
                    detectedProtocol === "grpc-web" && "bg-green-500/20 text-green-600 dark:text-green-400",
                    detectedProtocol === "grpc" && "bg-blue-500/20 text-blue-600 dark:text-blue-400",
                    detectedProtocol === "sdk" && "bg-purple-500/20 text-purple-600 dark:text-purple-400"
                  )}
                >
                  {PROTOCOL_LABELS[detectedProtocol] ?? detectedProtocol}
                </span>
              )}
            </div>
            {comparison ? (
              <div className="mt-2 rounded-md border border-border bg-muted/30 p-2 text-[11px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Already installed / 已安装</span>
                  <div className="text-right font-mono">
                    <span className="text-foreground">{comparison.installed.version}</span>
                    {comparison.installedStamp && (
                      <span className="ml-2 text-muted-foreground/70">{fmtStamp(comparison.installedStamp)}</span>
                    )}
                  </div>
                </div>
                {comparison.relation === "same" ? (
                  <div className="mt-1.5 border-t border-border/50 pt-1.5 text-[10px] text-amber-500">
                    Same version already installed / 已安装相同版本
                  </div>
                ) : comparison.version ? (
                  <div className="mt-1.5 flex items-center justify-between gap-3 border-t border-border/50 pt-1.5">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      Installing / 本次
                      {comparison.relation === "newer" && (
                        <span className="rounded bg-green-500/15 px-1 py-0.5 text-[9px] text-green-500">newer ↑</span>
                      )}
                      {comparison.relation === "older" && (
                        <span className="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] text-amber-500">older ↓</span>
                      )}
                    </span>
                    <div className="text-right font-mono">
                      <span className="text-primary">{comparison.version}</span>
                      {comparison.newStamp && (
                        <span className="ml-2 text-muted-foreground/70">{fmtStamp(comparison.newStamp)}</span>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {(installLog.length > 0 || isInstalling) && (() => {
            const last = installLog[installLog.length - 1] ?? "";
            const isSuccess = last === "Installation complete!" || last === "Package removed!";
            const isFailed = last.startsWith("Installation failed") || last.startsWith("Removal failed") || last.startsWith("Error:");
            const isDone = isSuccess || isFailed;
            const logLines = isDone ? installLog.slice(0, -1) : installLog;

            const formatTime = (s: number) => {
              const m = Math.floor(s / 60);
              const sec = s % 60;
              return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
            };

            return (
              <div className="space-y-2">
                {logLines.length > 0 && (
                  <div className="rounded-md border border-border bg-muted/50 p-2 max-h-24 overflow-y-auto">
                    <div className="space-y-0.5 font-mono text-[10px] text-muted-foreground">
                      {logLines.map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                    </div>
                  </div>
                )}
                {isInstalling && !isDone && (
                  <div className="flex items-center gap-2.5 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2.5">
                    <Loader2 className="h-5 w-5 shrink-0 text-blue-500 animate-spin" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-blue-600 dark:text-blue-400">
                        Downloading dependencies...
                      </p>
                      <p className="text-[10px] text-blue-600/70 dark:text-blue-400/70">
                        This may take a while for large packages / 大型包可能需要较长时间
                      </p>
                    </div>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-blue-600 dark:text-blue-400">
                      {formatTime(elapsed)}
                    </span>
                  </div>
                )}
                {isSuccess && (
                  <div className="flex items-center gap-2.5 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2.5 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" />
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-green-600 dark:text-green-400">
                        {last === "Package removed!" ? "Removed successfully!" : "Installed successfully!"}
                      </p>
                      <p className="text-[10px] text-green-600/70 dark:text-green-400/70">
                        {last === "Package removed!"
                          ? "Package has been removed / 包已成功移除"
                          : `Package is ready to use (${formatTime(elapsed)}) / 安装成功`}
                      </p>
                    </div>
                    <kbd className="shrink-0 rounded border border-green-500/30 bg-green-500/10 px-1.5 py-0.5 text-[9px] font-mono text-green-600 dark:text-green-400">
                      Enter ↵
                    </kbd>
                  </div>
                )}
                {isFailed && (
                  <div className="flex items-center gap-2.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <XCircle className="h-5 w-5 shrink-0 text-red-500" />
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-red-600 dark:text-red-400">
                        Installation failed
                      </p>
                      <p className="text-[10px] text-red-600/70 dark:text-red-400/70">
                        {last}
                      </p>
                    </div>
                    <kbd className="shrink-0 rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[9px] font-mono text-red-600 dark:text-red-400">
                      Enter ↵
                    </kbd>
                  </div>
                )}
              </div>
            );
          })()}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={isInstalling}>
              Cancel / 取消
            </Button>
            <Button
              onClick={handleInstall}
              disabled={!spec.trim() || !isValid || isInstalling}
              className={cn(
                isValid && !isInstalling &&
                  "animate-pulse shadow-[0_0_14px_2px_oklch(0.7_0.15_250/0.5)]"
              )}
            >
              <Download className="mr-1.5 h-4 w-4" />
              {isInstalling ? "Installing... / 安装中..." : "Install / 安装"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
