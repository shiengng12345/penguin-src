import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { logger } from "@/lib/logger";
import { useAppStore, type ProtocolTab, type VisibleProtocolTab, type MetadataEntry } from "@/lib/store";
import type { AppUpdateController } from "@/hooks/useAppUpdateScheduler";
import { setPersistedValue } from "@/lib/app-persistence";
import { persistEnvironmentSnapshot } from "@/lib/environment-persistence";
import { APP_VALUE_KEYS } from "@/lib/persistence-keys";
import { persistSavedRequests } from "@/lib/penguin-db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RegistryAuthSection } from "@/components/settings/RegistryAuthSection";
import {
  X,
  Trash2,
  Loader2,
  CheckCircle,
  Plus,
  Copy,
  ClipboardPaste,
  Download,
  Upload,
  Globe,
  Server,
  Box,
  User,
  Pencil,
  RefreshCw,
  ArrowDownToLine,
  RotateCcw,
  Plug,
  Sparkles,
  Settings2,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { writeClipboard } from "@/lib/clipboard";

const PROTOCOL_TABS: { id: VisibleProtocolTab; label: string; icon: typeof Globe }[] = [
  { id: "grpc-web", label: "gRPC-Web", icon: Globe },
  { id: "grpc", label: "gRPC", icon: Server },
  { id: "sdk", label: "JS-SDK", icon: Box },
];

function envsForProtocol(protocol: ProtocolTab, s: ReturnType<typeof useAppStore.getState>) {
  return protocol === "grpc-web"
    ? s.grpcWebEnvironments
    : protocol === "grpc"
      ? s.grpcEnvironments
      : protocol === "sdk"
        ? s.sdkEnvironments
        : s.restEnvironments;
}

function activeEnvForProtocol(protocol: ProtocolTab, s: ReturnType<typeof useAppStore.getState>) {
  return protocol === "grpc-web"
    ? s.grpcWebActiveEnvId
    : protocol === "grpc"
      ? s.grpcActiveEnvId
      : protocol === "sdk"
        ? s.sdkActiveEnvId
        : s.restActiveEnvId;
}

const HISTORY_SIZES = [100, 200, 500, 1000];

interface SettingsDialogProps {
  onClose: () => void;
  onOpenEnvManager: () => void;
  appUpdate: AppUpdateController;
  onPackagesCleared: () => Promise<void>;
}

export function SettingsDialog({
  onClose,
  onOpenEnvManager,
  appUpdate,
  onPackagesCleared,
}: SettingsDialogProps) {
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [exportMode, setExportMode] = useState<"idle" | "export" | "import">("idle");
  const [importText, setImportText] = useState("");
  const [importStatus, setImportStatus] = useState<"idle" | "success" | "error">("idle");
  const [copied, setCopied] = useState(false);
  const [headerProtocol, setHeaderProtocol] = useState<VisibleProtocolTab>("grpc-web");
  const [editingName, setEditingName] = useState(false);
  const exportRef = useRef<HTMLTextAreaElement>(null);

  const userName = useAppStore((s) => s.userName);
  const setUserName = useAppStore((s) => s.setUserName);
  const [draftName, setDraftName] = useState(userName);
  const maxHistorySize = useAppStore((s) => s.maxHistorySize);
  const setMaxHistorySize = useAppStore((s) => s.setMaxHistorySize);
  const defaultHeaders = useAppStore((s) => s.defaultHeaders);
  const setDefaultHeaders = useAppStore((s) => s.setDefaultHeaders);
  const historyCount = useAppStore((s) => s.historyTotal);

  const [appVersion, setAppVersion] = useState<string>("");

  // MCP integration. `mcpStatus` is fetched lazily when the user opens
  // Settings; the one-click setup refreshes it after writing the local client config.
  interface McpStatusShape {
    server_name: string;
    bundled_server_path: string | null;
    node_path: string | null;
    server_healthy: boolean;
    server_health_error: string | null;
    claude_desktop_config_path: string | null;
    claude_desktop_configured: boolean;
    claude_code_config_path: string | null;
    claude_code_configured: boolean;
    codex_config_path: string | null;
    codex_configured: boolean;
  }
  const [mcpStatus, setMcpStatus] = useState<McpStatusShape | null>(null);
  const [mcpInstallState, setMcpInstallState] = useState<
    "idle" | "installing" | "success" | "error"
  >("idle");
  const [mcpInstallMsg, setMcpInstallMsg] = useState<string>("");
  const [mcpConfigCopied, setMcpConfigCopied] = useState(false);
  const [mcpCliCopied, setMcpCliCopied] = useState(false);
  const [mcpCodexCliCopied, setMcpCodexCliCopied] = useState(false);

  const refreshMcpStatus = useCallback(async () => {
    try {
      const s = await invoke<McpStatusShape>("mcp_status");
      setMcpStatus(s);
    } catch (err) {
      logger.warn("Settings", "mcp_status failed", { error: String(err) });
    }
  }, []);

  const handleMcpInstall = async () => {
    setMcpInstallState("installing");
    setMcpInstallMsg("");
    try {
      const msg = await invoke<string>("mcp_install_to_local_clients");
      setMcpInstallMsg(msg);
      setMcpInstallState("success");
      await refreshMcpStatus();
    } catch (err) {
      await refreshMcpStatus();
      setMcpInstallMsg(String(err));
      setMcpInstallState("error");
    }
  };

  const mcpNodePath = mcpStatus?.node_path ?? "<node>";
  const mcpServerPath = mcpStatus?.bundled_server_path ?? "<path>";
  const canCopyMcpSetup = Boolean(mcpStatus?.bundled_server_path && mcpStatus?.node_path);
  const mcpJsonSnippet = JSON.stringify(
    {
      mcpServers: {
        penguin: {
          command: mcpNodePath,
          args: [mcpServerPath],
        },
      },
    },
    null,
    2,
  );
  const mcpClaudeCliCommand = `claude mcp add --scope user penguin ${mcpNodePath} ${mcpServerPath}`;
  const mcpCodexCliCommand = `codex mcp add penguin -- ${mcpNodePath} ${mcpServerPath}`;
  const mcpClaudeConfigured = Boolean(mcpStatus?.claude_desktop_configured);
  const mcpClaudeCodeConfigured = Boolean(mcpStatus?.claude_code_configured);
  const mcpCodexConfigured = Boolean(mcpStatus?.codex_configured);
  const mcpServerHealthy = Boolean(mcpStatus?.server_healthy);
  const mcpAllConfigured = mcpClaudeConfigured && mcpClaudeCodeConfigured && mcpCodexConfigured;
  const mcpReady = mcpAllConfigured && mcpServerHealthy;
  const mcpServerCheckFailed = mcpStatus !== null && !mcpServerHealthy;
  const mcpPartiallyConfigured =
    !mcpAllConfigured && (mcpClaudeConfigured || mcpClaudeCodeConfigured || mcpCodexConfigured);
  const mcpStatusLabel = mcpReady
    ? "MCP Ready"
    : mcpServerCheckFailed
      ? "Server Check Failed"
      : mcpPartiallyConfigured
      ? "Partial Setup"
      : "Manual Setup";

  const copyMcpSetup = async (
    text: string,
    setCopiedState: (copied: boolean) => void,
  ) => {
    if (!canCopyMcpSetup) return;
    await writeClipboard(text);
    setCopiedState(true);
    setTimeout(() => setCopiedState(false), 2000);
  };
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion("unknown"));
    refreshMcpStatus();
  }, [refreshMcpStatus]);

  const currentHeaders = defaultHeaders[headerProtocol];

  const handleClearCache = async () => {
    setClearing(true);
    setCleared(false);
    try {
      await invoke<string>("clear_all_packages");
      await onPackagesCleared();
      setCleared(true);
      setClearing(false);
    } catch (err) {
      logger.error("SettingsDialog", "clear_all_packages failed", err);
      setClearing(false);
    }
  };

  const updateHeader = (index: number, patch: Partial<MetadataEntry>) => {
    const next = [...currentHeaders];
    next[index] = { ...next[index], ...patch };
    setDefaultHeaders(headerProtocol, next);
  };

  const addHeader = () => {
    setDefaultHeaders(headerProtocol, [
      ...currentHeaders,
      { key: "", value: "", enabled: true },
    ]);
  };

  const removeHeader = (index: number) => {
    setDefaultHeaders(
      headerProtocol,
      currentHeaders.filter((_, i) => i !== index),
    );
  };

  const buildExportData = () => {
    const s = useAppStore.getState();
    // intentionally excludes savedRequests + history — those bloat the export
    // (history embeds full ProtoMethod schema per entry) and aren't "config"
    return JSON.stringify(
      {
        version: 1,
        environments: {
          "grpc-web": s.grpcWebEnvironments,
          grpc: s.grpcEnvironments,
          sdk: s.sdkEnvironments,
          rest: s.restEnvironments,
        },
        activeEnvIds: {
          "grpc-web": s.grpcWebActiveEnvId,
          grpc: s.grpcActiveEnvId,
          sdk: s.sdkActiveEnvId,
          rest: s.restActiveEnvId,
        },
        defaultHeaders: s.defaultHeaders,
        maxHistorySize: s.maxHistorySize,
        theme: s.theme,
        userName: s.userName,
      },
      null,
      2,
    );
  };

  const handleImport = () => {
    try {
      const data = JSON.parse(importText.trim());
      const s = useAppStore.getState();

      if (data.environments) {
        if (data.environments["grpc-web"]) s.setGrpcWebEnvironments(data.environments["grpc-web"]);
        if (data.environments.grpc) s.setGrpcEnvironments(data.environments.grpc);
        if (data.environments.sdk) s.setSdkEnvironments(data.environments.sdk);
        if (data.environments.rest) s.setRestEnvironments(data.environments.rest);
      }
      if (data.activeEnvIds) {
        if (data.activeEnvIds["grpc-web"] !== undefined) s.setGrpcWebActiveEnvId(data.activeEnvIds["grpc-web"]);
        if (data.activeEnvIds.grpc !== undefined) s.setGrpcActiveEnvId(data.activeEnvIds.grpc);
        if (data.activeEnvIds.sdk !== undefined) s.setSdkActiveEnvId(data.activeEnvIds.sdk);
        if (data.activeEnvIds.rest !== undefined) s.setRestActiveEnvId(data.activeEnvIds.rest);
      }
      for (const p of ["grpc-web", "grpc", "sdk", "rest"] as ProtocolTab[]) {
        if (data.environments?.[p] || data.activeEnvIds?.[p] !== undefined) {
          persistEnvironmentSnapshot(p, envsForProtocol(p, useAppStore.getState()), activeEnvForProtocol(p, useAppStore.getState()));
        }
      }
      if (Array.isArray(data.savedRequests)) {
        useAppStore.setState({ savedRequests: data.savedRequests });
        void persistSavedRequests(data.savedRequests);
      }
      if (Array.isArray(data.history)) {
        useAppStore.setState({ history: data.history });
        setPersistedValue(APP_VALUE_KEYS.history, JSON.stringify(data.history));
      }
      if (data.defaultHeaders) {
        for (const p of ["grpc-web", "grpc", "sdk", "rest"] as ProtocolTab[]) {
          if (data.defaultHeaders[p]) s.setDefaultHeaders(p, data.defaultHeaders[p]);
        }
      }
      if (typeof data.maxHistorySize === "number") s.setMaxHistorySize(data.maxHistorySize);
      if (data.theme) s.setTheme(data.theme);
      if (data.userName) s.setUserName(data.userName);

      setImportStatus("success");
      setTimeout(() => setImportStatus("idle"), 2000);
    } catch {
      setImportStatus("error");
      setTimeout(() => setImportStatus("idle"), 2000);
    }
  };

  const handleCopyExport = () => {
    exportRef.current?.select();
    writeClipboard(exportRef.current?.value ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        className="relative z-50 w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-lg border border-border bg-popover shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border p-4 shrink-0">
          <h2 className="text-lg font-semibold text-foreground">
            Settings / 设置
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 grid grid-cols-1 md:grid-cols-2 gap-4 [&>*]:h-full">
          {/* Display Name */}
          <div className="rounded-lg border border-border bg-muted/20 p-4">
            <h3 className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <User className="h-3.5 w-3.5" />
              Display Name / 显示名称
            </h3>
            {editingName ? (
              <form
                className="mt-3 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draftName.trim()) {
                    setUserName(draftName.trim());
                    setEditingName(false);
                  }
                }}
              >
                <Input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="Enter your name"
                  autoFocus
                  className="h-8 flex-1 text-sm"
                  autoCorrect="off"
                  autoCapitalize="words"
                  spellCheck={false}
                />
                <Button type="submit" size="sm" className="h-8" disabled={!draftName.trim()}>
                  Save
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8"
                  onClick={() => {
                    setDraftName(userName);
                    setEditingName(false);
                  }}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <div className="mt-2 flex items-center justify-between">
                <span className="text-sm text-foreground">{userName}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground"
                  onClick={() => {
                    setDraftName(userName);
                    setEditingName(true);
                  }}
                >
                  <Pencil className="mr-1 h-3 w-3" />
                  Edit
                </Button>
              </div>
            )}
          </div>

          {/* App Updates */}
          <div className="rounded-lg border border-border bg-muted/20 p-4">
            <h3 className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <ArrowDownToLine className="h-3.5 w-3.5" />
              App Updates / 应用更新
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Current version: <span className="font-mono">{appVersion || "..."}</span>
            </p>

            <div className="mt-3">
              {appUpdate.status === "idle" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={appUpdate.checkNow}
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  Check for Updates
                </Button>
              )}

              {appUpdate.status === "checking" && (
                <Button variant="outline" size="sm" className="w-full" disabled>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Checking...
                </Button>
              )}

              {appUpdate.status === "up-to-date" && (
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs text-green-500">
                    <CheckCircle className="h-3.5 w-3.5" />
                    You're up to date!
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-muted-foreground"
                    onClick={appUpdate.checkNow}
                  >
                    Check again
                  </Button>
                </div>
              )}

              {appUpdate.status === "available" && appUpdate.updateVersion && (
                <div className="space-y-2">
                  <p className="text-xs text-foreground">
                    New version <span className="font-mono font-semibold">{appUpdate.updateVersion}</span> is available.
                  </p>
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={appUpdate.downloadAndInstall}
                  >
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    Download & Install
                  </Button>
                </div>
              )}

              {appUpdate.status === "downloading" && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                    <span className="text-xs text-foreground">
                      Downloading... {appUpdate.downloadProgress}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-300"
                      style={{ width: `${appUpdate.downloadProgress}%` }}
                    />
                  </div>
                </div>
              )}

              {appUpdate.status === "ready" && (
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-xs text-green-500">
                    <CheckCircle className="h-3.5 w-3.5" />
                    Update installed! Restart to apply.
                  </p>
                  <Button size="sm" className="w-full" onClick={appUpdate.restart}>
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                    Restart Now
                  </Button>
                </div>
              )}

              {appUpdate.status === "error" && (
                <div className="space-y-2">
                  <p className="text-xs text-destructive">
                    Update check failed: {appUpdate.updateError}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={appUpdate.checkNow}
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    Try Again
                  </Button>
                </div>
              )}
            </div>

            {/* Auto-check toggle — default OFF. User opts in to background
                update polling. Manual "Check for Updates" above still works. */}
            <label className="mt-3 flex cursor-pointer items-start gap-2 rounded border border-border/60 bg-background/40 p-2 text-xs hover:bg-accent/30">
              <input
                type="checkbox"
                className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary"
                checked={appUpdate.autoCheckEnabled}
                onChange={(e) => appUpdate.setAutoCheckEnabled(e.target.checked)}
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-foreground">
                  Auto-check for updates / 自动检查更新
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  Polls on startup, hourly, and when the window regains focus.
                  Off by default — flip on if you want background checks.
                </p>
              </div>
            </label>
          </div>

          <RegistryAuthSection />

          {/* MCP Integration */}
          <div className="rounded-lg border border-border bg-muted/20 p-4 md:col-span-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-foreground flex items-center gap-1.5">
                  <Plug className="h-3.5 w-3.5" />
                  MCP Integration / MCP 集成
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Let AI tools call your installed packages. 让 AI 直接调用已装的方法。
                </p>
              </div>
              <span
                className={cn(
                  "shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                  mcpReady
                    ? "bg-emerald-500/15 text-emerald-500"
                    : mcpServerCheckFailed
                      ? "bg-red-500/15 text-red-500"
                    : mcpPartiallyConfigured
                      ? "bg-amber-500/15 text-amber-500"
                    : "bg-muted text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    mcpReady
                      ? "bg-emerald-500"
                      : mcpServerCheckFailed
                        ? "bg-red-500"
                      : mcpPartiallyConfigured
                        ? "bg-amber-500"
                        : "bg-muted-foreground/40",
                  )}
                />
                {mcpStatusLabel}
              </span>
            </div>

            {((!mcpStatus?.bundled_server_path && mcpStatus !== null) ||
              (!mcpStatus?.node_path && mcpStatus !== null) ||
              (mcpServerCheckFailed && mcpStatus?.server_health_error)) && (
              <p className="mt-2 text-[11px] text-amber-500">
                {!mcpStatus?.node_path
                  ? "Node.js not detected — install from nodejs.org first."
                  : !mcpStatus?.bundled_server_path
                    ? "Bundled MCP server missing — rebuild the app."
                    : `MCP server check failed — ${mcpStatus.server_health_error}`}
              </p>
            )}

            <Button
              variant="outline"
              size="sm"
              className="mt-3 w-full"
              onClick={handleMcpInstall}
              disabled={
                mcpInstallState === "installing" ||
                !mcpStatus?.bundled_server_path ||
                !mcpStatus?.node_path
              }
            >
              {mcpInstallState === "installing" ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : mcpAllConfigured ? (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              ) : (
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              )}
              {mcpAllConfigured ? "Reconfigure MCP Clients" : "Configure MCP Clients"}
            </Button>

            {mcpInstallState === "success" && (
              <p className={cn(
                "mt-2 text-[11px]",
                mcpServerHealthy ? "text-emerald-500" : "text-amber-500",
              )}>
                {mcpServerHealthy
                  ? "✓ Configured Claude Desktop, Claude Code and Codex CLI. Penguin MCP server checked. Restart the clients to load it."
                  : `Configured clients, but MCP server check failed: ${mcpStatus?.server_health_error ?? "unknown error"}`}
              </p>
            )}
            {mcpInstallState === "error" && mcpInstallMsg && (
              <p className="mt-2 text-[11px] text-red-500 truncate" title={mcpInstallMsg}>
                {mcpInstallMsg}
              </p>
            )}

            {/* Always-visible config snippets for common MCP clients. The
                one-click button covers the desktop auto-config path, while these
                snippets make it clear Codex and other clients work too.
                Columns are flex-col so the
                <pre> blocks stretch to equal heights regardless of line count. */}
            <div className="mt-3 border-t border-border/60 pt-3">
              <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Client Setup / 客户端配置
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Use the same Penguin MCP server in Claude, Cursor, Codex, or any JSON MCP client.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3 [&>div]:flex [&>div]:min-w-0 [&>div]:flex-col [&>div_pre]:min-h-24 [&>div_pre]:flex-1">
                <div className="rounded-md border border-border/60 bg-background/40 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="min-w-0">
                      <span className="block text-[10px] font-medium text-foreground">
                        JSON clients
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        Claude Desktop / Cursor
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyMcpSetup(mcpJsonSnippet, setMcpConfigCopied)}
                      disabled={!canCopyMcpSetup}
                      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                    >
                      {mcpConfigCopied ? (
                        <>
                          <CheckCircle className="h-3 w-3 text-emerald-500" />
                          <span className="text-emerald-500">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          Copy
                        </>
                      )}
                    </button>
                  </div>
                  <pre className="font-mono text-[10px] text-muted-foreground rounded bg-muted/40 p-2 max-w-full overflow-x-auto whitespace-pre leading-relaxed">
                    {mcpJsonSnippet}
                  </pre>
                </div>

                <div className="rounded-md border border-border/60 bg-background/40 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="min-w-0">
                      <span className="block text-[10px] font-medium text-foreground">
                        Claude Code
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        CLI command
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyMcpSetup(mcpClaudeCliCommand, setMcpCliCopied)}
                      disabled={!canCopyMcpSetup}
                      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                    >
                      {mcpCliCopied ? (
                        <>
                          <CheckCircle className="h-3 w-3 text-emerald-500" />
                          <span className="text-emerald-500">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          Copy
                        </>
                      )}
                    </button>
                  </div>
                  <pre className="font-mono text-[10px] text-muted-foreground rounded bg-muted/40 p-2 max-w-full overflow-x-auto whitespace-pre leading-relaxed">
                    {mcpClaudeCliCommand.replace(` ${mcpNodePath} `, ` \\\n  ${mcpNodePath} \\\n  `)}
                  </pre>
                </div>

                <div className="rounded-md border border-border/60 bg-background/40 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="min-w-0">
                      <span className="block text-[10px] font-medium text-foreground">
                        Codex CLI
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        CLI command
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyMcpSetup(mcpCodexCliCommand, setMcpCodexCliCopied)}
                      disabled={!canCopyMcpSetup}
                      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                    >
                      {mcpCodexCliCopied ? (
                        <>
                          <CheckCircle className="h-3 w-3 text-emerald-500" />
                          <span className="text-emerald-500">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          Copy
                        </>
                      )}
                    </button>
                  </div>
                  <pre className="font-mono text-[10px] text-muted-foreground rounded bg-muted/40 p-2 max-w-full overflow-x-auto whitespace-pre leading-relaxed">
                    {mcpCodexCliCommand.replace(` -- ${mcpNodePath} `, ` -- \\\n  ${mcpNodePath} \\\n  `)}
                  </pre>
                </div>
              </div>
            </div>
          </div>

          {/* Max History Size */}
          <div className="rounded-lg border border-border bg-muted/20 p-4">
            <h3 className="text-sm font-medium text-foreground">
              Max History Size / 最大历史记录数
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Currently {historyCount} entries. Older entries are trimmed automatically.
            </p>
            <div className="mt-3 flex gap-1.5">
              {HISTORY_SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => setMaxHistorySize(size)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    maxHistorySize === size
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-accent"
                  )}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>

          {/* Export / Import */}
          <div className="rounded-lg border border-border bg-muted/20 p-4">
            <h3 className="text-sm font-medium text-foreground">
              Export / Import Config
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Transfer environments, default headers, and app settings (history &amp; saved requests are not included).
            </p>
            {exportMode === "idle" && (
              <div className="mt-3 flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => setExportMode("export")}
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  Export
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    setExportMode("import");
                    setImportText("");
                    setImportStatus("idle");
                  }}
                >
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  Import
                </Button>
              </div>
            )}
            {exportMode === "export" && (
              <div className="mt-3 space-y-2">
                <textarea
                  ref={exportRef}
                  readOnly
                  value={buildExportData()}
                  className="w-full h-40 rounded-md border border-border bg-background p-2 font-mono text-[10px] text-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                  onClick={(e) => (e.target as HTMLTextAreaElement).select()}
                />
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => setExportMode("idle")}
                  >
                    Back
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1"
                    onClick={handleCopyExport}
                  >
                    {copied ? (
                      <>
                        <CheckCircle className="mr-1.5 h-3.5 w-3.5" />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy className="mr-1.5 h-3.5 w-3.5" />
                        Copy Config
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
            {exportMode === "import" && (
              <div className="mt-3 space-y-2">
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder="Paste exported JSON here..."
                  className="w-full h-40 rounded-md border border-border bg-background p-2 font-mono text-[10px] text-foreground resize-none placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => setExportMode("idle")}
                  >
                    Back
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={!importText.trim()}
                    onClick={handleImport}
                  >
                    {importStatus === "success" ? (
                      <>
                        <CheckCircle className="mr-1.5 h-3.5 w-3.5" />
                        Imported!
                      </>
                    ) : importStatus === "error" ? (
                      <>
                        <X className="mr-1.5 h-3.5 w-3.5" />
                        Invalid JSON
                      </>
                    ) : (
                      <>
                        <ClipboardPaste className="mr-1.5 h-3.5 w-3.5" />
                        Apply Import
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Manage Environments */}
          <Button
            variant="outline"
            className="group h-auto w-full justify-between border-primary/30 bg-primary/5 p-4 text-left hover:border-primary/60 hover:bg-primary/10"
            onClick={() => {
              onClose();
              onOpenEnvManager();
            }}
            aria-label="Open environment manager"
          >
            <span className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary">
                <Settings2 className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground">
                  Manage Environments / 管理环境
                </span>
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  Edit URLs, tokens, and shared variables
                </span>
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
          </Button>

          {/* Clear Cache */}
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <h3 className="text-sm font-medium text-foreground">
              Clear Cache / 清除缓存
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Remove all installed packages. Environments and settings are preserved.
            </p>
            <Button
              variant="destructive"
              size="sm"
              className="mt-3 w-full"
              disabled={clearing}
              onClick={handleClearCache}
            >
              {clearing ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Clearing...
                </>
              ) : cleared ? (
                <>
                  <CheckCircle className="mr-1.5 h-3.5 w-3.5" />
                  Cache Cleared!
                </>
              ) : (
                <>
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Clear All Packages
                </>
              )}
            </Button>
          </div>

          {/* Default Headers per Protocol — full-width bottom row because the
              tabbed key/value editor benefits from horizontal breathing room. */}
          <div className="rounded-lg border border-border bg-muted/20 p-4 md:col-span-2">
            <h3 className="text-sm font-medium text-foreground">
              Default Headers / 默认请求头
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Auto-populate headers when creating new tabs.
            </p>
            <div className="mt-3 flex gap-1 mb-3">
              {PROTOCOL_TABS.map((pt) => {
                const Icon = pt.icon;
                return (
                  <button
                    key={pt.id}
                    type="button"
                    onClick={() => setHeaderProtocol(pt.id)}
                    className={cn(
                      "flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                      headerProtocol === pt.id
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent"
                    )}
                  >
                    <Icon className="h-3 w-3" />
                    {pt.label}
                  </button>
                );
              })}
            </div>
            <div className="space-y-2">
              {currentHeaders.map((h, i) => (
                <div key={i} className="flex gap-1.5">
                  <Input
                    value={h.key}
                    onChange={(e) => updateHeader(i, { key: e.target.value })}
                    placeholder="Key"
                    className="h-7 flex-1 font-mono text-xs"
                  />
                  <Input
                    value={h.value}
                    onChange={(e) => updateHeader(i, { value: e.target.value })}
                    placeholder="Value"
                    className="h-7 flex-1 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => removeHeader(i)}
                    className="h-7 w-7 shrink-0 rounded flex items-center justify-center hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-full text-xs"
                onClick={addHeader}
              >
                <Plus className="mr-1 h-3 w-3" />
                Add Header
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
