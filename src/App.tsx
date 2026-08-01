import { useEffect, useCallback, useState, lazy, Suspense } from "react";
import { protocolFromSnsoftPackageSpec } from "@penguin/core";
import { useAppStore, useActiveTab, getDefaultHeadersForProtocol, visibleProtocolForTab, type ProtocolTab } from "@/lib/store";
import { usePackages } from "@/hooks/usePackages";
import { useEnvironments } from "@/hooks/useEnvironments";
import { useAppUpdateScheduler } from "@/hooks/useAppUpdateScheduler";
import { useRegistryAutoRefresh } from "@/hooks/useRegistryAutoRefresh";
import { interpolate } from "@/lib/environment-store";
import { hideAllInlineWebviews } from "@/lib/inline-webview";
import { Header } from "@/components/layout/Header";
import { UpdateNotification } from "@/components/layout/UpdateNotification";
import { TabBar } from "@/components/layout/TabBar";
import { Sidebar } from "@/components/layout/Sidebar";
import { UrlBar } from "@/components/layout/UrlBar";
import { VaultPage } from "@/components/vault/VaultPage";
import { BrowserPage } from "@/components/browser/BrowserPage";
import { ApiDocsPage } from "@/components/docs/ApiDocsPage";
import { RestPage } from "@/components/rest/RestPage";
import { DatabasePage } from "@/components/database/DatabasePage";
import { WikiPage } from "@/components/wiki/WikiPage";
import { MainSidebar, type MainModule } from "@/components/layout/MainSidebar";
import { getPersistedValue, setPersistedValue } from "@/lib/app-persistence";
import { APP_VALUE_KEYS } from "@/lib/persistence-keys";
import { fetchRegistryPackages } from "@/lib/registry-search";

// Restore activeModule across main-webview reloads. The OS context
// menu "Reload" entry refreshes Penguin itself — every module's
// useState(false) flag resets, and the user lands on Client even if
// they were in Browser. Persisting + restoring fixes that.
const VALID_MODULES: ReadonlySet<MainModule> = new Set([
  "client",
  "vault",
  "rest",
  "docs",
  "browser",
  "database",
  "wiki",
]);
function loadInitialActiveModule(): MainModule | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = getPersistedValue(APP_VALUE_KEYS.activeModule);
    if (raw === null) return null;
    if (raw === "redis") return "database";
    if (VALID_MODULES.has(raw as MainModule)) return raw as MainModule;
  } catch {
    /* fall through to null */
  }
  return null;
}
import { useDeveloperMode } from "@/hooks/useDeveloperMode";
import { PENGUIN_OPEN_SETTINGS_EVENT, PENGUIN_GO_HOME_EVENT } from "@/components/vault/VaultEmptyGate";
import {
  REST_NEW_REQUEST_EVENT,
  REST_CLOSE_TAB_EVENT,
  REST_SEND_REQUEST_EVENT,
  REST_SAVE_REQUEST_EVENT,
  REST_FOCUS_SEARCH_EVENT,
  REST_FOCUS_URL_EVENT,
  REST_OPEN_CURL_IMPORT_EVENT,
  REST_OPEN_HISTORY_EVENT,
} from "@/lib/rest-events";
import { initializeDevModeOnAppStart } from "@/lib/dev-mode-store";
import { RequestPanel } from "@/components/request/RequestPanel";
import { ResponsePanel } from "@/components/request/ResponsePanel";
import { SnowLayer } from "@/components/theme/SnowLayer";
import { ResizablePanels } from "@/components/ui/resizable-panels";

const PackageInstaller = lazy(() => import("@/components/packages/PackageInstaller").then(m => ({ default: m.PackageInstaller })));
const EnvManager = lazy(() => import("@/components/environment/EnvManager").then(m => ({ default: m.EnvManager })));
const SettingsDialog = lazy(() => import("@/components/settings/SettingsDialog").then(m => ({ default: m.SettingsDialog })));
const CommandSearch = lazy(() => import("@/components/search/CommandSearch").then(m => ({ default: m.CommandSearch })));
const HistoryPanel = lazy(() => import("@/components/history/HistoryPanel").then(m => ({ default: m.HistoryPanel })));
const SavedRequestsPanel = lazy(() => import("@/components/saved/SavedRequestsPanel").then(m => ({ default: m.SavedRequestsPanel })));
const NewRequestDialog = lazy(() => import("@/components/request/NewRequestDialog").then(m => ({ default: m.NewRequestDialog })));
const RequestDocDialog = lazy(() => import("@/components/request/RequestDocDialog").then(m => ({ default: m.RequestDocDialog })));
const ShortcutCheatSheet = lazy(() => import("@/components/shortcuts/ShortcutCheatSheet").then(m => ({ default: m.ShortcutCheatSheet })));
const NetworkCheck = lazy(() => import("@/components/network/NetworkCheck").then(m => ({ default: m.NetworkCheck })));
const CurlImport = lazy(() => import("@/components/environment/CurlImport").then(m => ({ default: m.CurlImport })));
const ProtoViewer = lazy(() => import("@/components/request/ProtoViewer").then(m => ({ default: m.ProtoViewer })));
const InteractiveTutorial = lazy(() => import("@/components/onboarding/InteractiveTutorial").then(m => ({ default: m.InteractiveTutorial })));
const Welcome = lazy(() => import("@/components/onboarding/Welcome").then(m => ({ default: m.Welcome })));
const DeveloperModeModal = lazy(() => import("@/components/settings/DeveloperModeModal").then(m => ({ default: m.DeveloperModeModal })));

import { StatusBar } from "@/components/layout/StatusBar";
import { Toaster } from "@/components/ui/toast";

export default function App() {
  const {
    activeTabId,
    removeTab,
    resetPackageTabs,
    sanitizeHiddenRestTabs,
    updateActiveTab,
    isInstallerOpen,
    setInstallerOpen,
    addInstallLog,
    clearInstallLog,
    theme,
  } = useAppStore();

  // 启动即预热包列表：后台拉一次 registry（顺带握好 TCP 连接、灌热内存缓存），
  // 用户点开安装弹窗时即开即最新。registry 未配置/网络失败静默忽略。
  useEffect(() => {
    void fetchRegistryPackages().catch(() => {});
  }, []);

  const { packages, refresh, uninstall } = usePackages();
  const { activeEnv } = useEnvironments();
  const activeTab = useActiveTab();

  const [searchOpen, setSearchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [docOpen, setDocOpen] = useState(false);
  const [envManagerOpen, setEnvManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newRequestOpen, setNewRequestOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [curlImportOpen, setCurlImportOpen] = useState(false);
  const [protoViewerOpen, setProtoViewerOpen] = useState(false);
  // Hidden Developer Mode form — opened only by holding Cmd+G for 3s.
  // No on-screen hint while holding, by design, so the gesture leaves no
  // trace for onlookers.
  const [devModalOpen, setDevModalOpen] = useState(false);
  // Seed the module flags from the persisted activeModule (if any),
  // so a Penguin main-webview reload restores the user's last module.
  const initialModule = loadInitialActiveModule();
  const [vaultOpen, setVaultOpen] = useState(initialModule === "vault");
  const [docsOpen, setDocsOpen] = useState(initialModule === "docs");
  const [restOpen, setRestOpen] = useState(initialModule === "rest");
  const [browserOpen, setBrowserOpen] = useState(initialModule === "browser");
  const [databaseOpen, setDatabaseOpen] = useState(initialModule === "database");
  const [wikiOpen, setWikiOpen] = useState(initialModule === "wiki");
  const openSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);
  const closeVault = useCallback(() => setVaultOpen(false), []);
  const closeBrowser = useCallback(() => setBrowserOpen(false), []);
  const closeDatabase = useCallback(() => setDatabaseOpen(false), []);
  const closeWiki = useCallback(() => setWikiOpen(false), []);
  // Vault → Browser deeplink dispatcher. Vault cards call this when
  // the user clicks the "Open in Browser" button; we push the deeplink
  // into the store (so BrowserPage's mount-effect consumes it) and
  // switch the active module — single source of truth without prop
  // drilling state ownership.
  const requestBrowserDeeplink = useAppStore((s) => s.requestBrowserDeeplink);
  const handleOpenInBrowser = useCallback(
    (deeplink: { url: string; label: string; prefillToken?: string; baseKind?: string; projectId?: string; envId?: string }) => {
      requestBrowserDeeplink(deeplink);
      setBrowserOpen(true);
      setVaultOpen(false);
      setDocsOpen(false);
      setRestOpen(false);
      setDatabaseOpen(false);
      setWikiOpen(false);
    },
    [requestBrowserDeeplink],
  );
  // Returns to the API Client — the default module now that the Home hub
  // is gone. Used by the rail's fallback, the "go home" event, and the
  // back/close buttons in Docs / REST.
  const selectApiClient = useCallback(() => {
    setVaultOpen(false);
    setDocsOpen(false);
    setRestOpen(false);
    setBrowserOpen(false);
    setDatabaseOpen(false);
    setWikiOpen(false);
  }, []);
  const selectVaultFromHome = useCallback(() => {
    setDocsOpen(false);
    setRestOpen(false);
    setBrowserOpen(false);
    setDatabaseOpen(false);
    setWikiOpen(false);
    setVaultOpen(true);
  }, []);
  const selectDocsFromHome = useCallback(() => {
    setVaultOpen(false);
    setRestOpen(false);
    setBrowserOpen(false);
    setDatabaseOpen(false);
    setWikiOpen(false);
    setDocsOpen(true);
  }, []);
  // Sprint 10 — REST module entry. Mirrors vault/docs pattern + new in 10A.
  const selectRest = useCallback(() => {
    setVaultOpen(false);
    setDocsOpen(false);
    setBrowserOpen(false);
    setDatabaseOpen(false);
    setWikiOpen(false);
    setRestOpen(true);
  }, []);
  const selectBrowser = useCallback(() => {
    setVaultOpen(false);
    setDocsOpen(false);
    setRestOpen(false);
    setDatabaseOpen(false);
    setWikiOpen(false);
    setBrowserOpen(true);
  }, []);
  const selectDatabase = useCallback(() => {
    setVaultOpen(false);
    setDocsOpen(false);
    setRestOpen(false);
    setBrowserOpen(false);
    setWikiOpen(false);
    setDatabaseOpen(true);
  }, []);
  const selectWiki = useCallback(() => {
    setVaultOpen(false);
    setDocsOpen(false);
    setRestOpen(false);
    setBrowserOpen(false);
    setDatabaseOpen(false);
    setWikiOpen(true);
  }, []);
  // Sidebar derives a single "active module" enum from the boolean page
  // flags. Clicking a rail item dispatches to the matching selector.
  const activeModule: MainModule = vaultOpen
    ? "vault"
    : docsOpen
    ? "docs"
    : restOpen
    ? "rest"
    : browserOpen
    ? "browser"
    : databaseOpen
    ? "database"
    : wikiOpen
    ? "wiki"
    : "client";
  // Three-tier gating (Sprint 8.5):
  //   - Vault requires any valid dev token (enabled && hasValidToken)
  //   - Docs / KB requires super-admin token (enabled && isSuperAdmin)
  // Super-admin implies hasValidToken, so super users see everything.
  const { enabled: devModeEnabled, hasValidToken, isSuperAdmin } = useDeveloperMode();
  // Dev-mode token loads asynchronously at boot. Until it lands,
  // `hasValidToken` / `isSuperAdmin` are still `false` even when the
  // user IS authorized — so any effect that uses them to revoke access
  // or persist state must wait for hydration. See [[persist-active-module]].
  const devModeHydrated = useAppStore((s) => s.devModeHydrated);
  const canAccessVault = devModeEnabled && hasValidToken;
  const canAccessDocs = devModeEnabled && isSuperAdmin;
  // REST is now open to all users — no token required.
  const canAccessRest = true;
  // If user loses their token mid-session, fall back to the API Client so
  // they're not stuck on a "please validate token" gate. Each module checks
  // its own gate so revoking super-admin but keeping dev token leaves the
  // user inside Vault but kicks them out of Docs.
  // Browser is super-admin-only (matches the MainSidebar `super-admin`
  // gate) — normal admins (dev token but not super) can't access it.
  // Only Vault stays at the token tier.
  const canAccessBrowser = devModeEnabled && isSuperAdmin;
  const canAccessDatabase = devModeEnabled && isSuperAdmin;
  const canAccessWiki = devModeEnabled && isSuperAdmin;
  useEffect(() => {
    // Wait for the dev-mode token to finish loading before deciding to
    // revoke access. Pre-hydration, hasValidToken / isSuperAdmin are
    // both false even for authorized users, so running this gate early
    // boots the user back to Client on every main-webview reload.
    if (!devModeHydrated) return;
    if (vaultOpen && !canAccessVault) setVaultOpen(false);
    if (docsOpen && !canAccessDocs) setDocsOpen(false);
    if (restOpen && !canAccessRest) setRestOpen(false);
    if (browserOpen && !canAccessBrowser) setBrowserOpen(false);
    if (databaseOpen && !canAccessDatabase) setDatabaseOpen(false);
    if (wikiOpen && !canAccessWiki) setWikiOpen(false);
  }, [devModeHydrated, canAccessVault, canAccessDocs, canAccessRest, canAccessBrowser, canAccessDatabase, canAccessWiki, vaultOpen, docsOpen, restOpen, browserOpen, databaseOpen, wikiOpen]);
  const handleModuleSelect = useCallback(
    (m: MainModule) => {
      if (m === "client") selectApiClient();
      else if (m === "vault") selectVaultFromHome();
      else if (m === "docs") selectDocsFromHome();
      else if (m === "rest") selectRest();
      else if (m === "browser") selectBrowser();
      else if (m === "database") selectDatabase();
      else if (m === "wiki") selectWiki();
      else selectApiClient();
    },
    [selectApiClient, selectVaultFromHome, selectDocsFromHome, selectRest, selectBrowser, selectDatabase, selectWiki],
  );
  const appUpdate = useAppUpdateScheduler(openSettings);
  // Background registry refresh for admins/super-admins — keeps the cache warm
  // while the installer is closed (strictly gated inside the hook).
  useRegistryAutoRefresh();
  const handlePackagesCleared = useCallback(async () => {
    resetPackageTabs();
    await refresh();
  }, [refresh, resetPackageTabs]);

  useEffect(() => {
    sanitizeHiddenRestTabs();
  }, [sanitizeHiddenRestTabs]);

  // Restore Dev Mode token at boot so once-on stays on across sessions —
  // Dev Mode boolean is hydrated synchronously by the store; the token has
  // to be pulled off disk asynchronously here.
  useEffect(() => {
    void initializeDevModeOnAppStart();
  }, []);

  // Hydrate vault data into the store at App mount, not only when the
  // user opens the Vault module. The In-App Browser module's "From
  // Vault" picker + paste-URL auto-match both read `vaultProjects` —
  // they'd see an empty array if VaultPage was never visited this
  // session. Lifting the load to App-level fixes that. Idempotent if
  // VaultPage's own mount-effect also runs.
  useEffect(() => {
    void (async () => {
      try {
        const mod = await import("@/components/vault/vault-storage");
        await mod.loadVaultFromDisk();
      } catch {
        // best-effort — Vault module's own mount will retry if needed
      }
    })();
  }, []);

  // Registry 包列表预热：启动即后台爬一轮 + 每 5 分钟静默刷新——用户按
  // Cmd+S 打开安装器时永远是热缓存（秒开），新 publish 的包名最多 5 分钟
  // 进列表；版本/tag 层始终点开实时拉，不受此间隔影响。registry 未配置时
  // fetch 静默失败，无副作用。
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    void import("@/lib/registry-search").then((m) => {
      const warm = () => void m.fetchRegistryPackages().catch(() => {});
      warm();
      interval = setInterval(warm, 5 * 60_000);
    });
    return () => {
      if (interval) clearInterval(interval);
    };
  }, []);

  // One-time cleanup of a residual full Lark doc URL persisted by an earlier
  // build — the passphrase flow ("PENGUIN") is the intended path now.
  useEffect(() => {
    void (async () => {
      try {
        const mod = await import("@/components/vault/vault-lark");
        await mod.cleanupResidualLarkUrl();
      } catch {
        // best-effort — non-fatal if cleanup can't run
      }
    })();
  }, []);

  const resolvedUrl = activeEnv
    ? interpolate(activeTab?.targetUrl ?? "", activeEnv)
    : null;

  const handleCycleProtocol = useCallback(() => {
    if (!activeTabId || !activeTab) return;

    const order = ["grpc-web", "grpc", "sdk"] as const;
    const idx = order.indexOf(visibleProtocolForTab(activeTab.protocolTab));
    const nextProtocol = order[(idx +1) % order.length];

    const allPkgs =
      nextProtocol === "grpc-web"
        ? useAppStore.getState().grpcWebPackages
        : nextProtocol === "grpc"
          ? useAppStore.getState().grpcPackages
          : useAppStore.getState().sdkPackages;

    const methodName = activeTab.selectedMethod?.name;
    let matchedMethod: typeof activeTab.selectedMethod = null;
    let matchedPkg: string | null = null;
    let matchedSvc: string | null = null;

    if (methodName) {
      for (const pkg of allPkgs) {
        for (const svc of pkg.services) {
          const m = svc.methods.find(
            (mm) => mm.name.toLowerCase() === methodName.toLowerCase()
          );
          if (m) {
            matchedMethod = m;
            matchedPkg = pkg.name;
            matchedSvc = svc.fullName;
            break;
          }
        }
        if (matchedMethod) break;
      }
    }

    const newMetadata = getDefaultHeadersForProtocol(nextProtocol);
    if (matchedMethod) {
      updateActiveTab({
        protocolTab: nextProtocol,
        selectedPackage: matchedPkg,
        selectedService: matchedSvc,
        selectedMethod: matchedMethod,
        metadata: newMetadata,
      });
    } else {
      updateActiveTab({
        protocolTab: nextProtocol,
        metadata: newMetadata,
      });
    }
  }, [activeTabId, activeTab, updateActiveTab]);

  const handleInstall = useCallback(
    async (spec: string, overrideProtocol?: ProtocolTab): Promise<boolean> => {
      const protocol = overrideProtocol ?? protocolFromSnsoftPackageSpec(spec);
      if (!protocol || protocol === "rest") return false;

      clearInstallLog();
      addInstallLog(`Installing ${spec}...`);

      const { installPackage } = await import("@/lib/package-manager");
      const ok = await installPackage(
        protocol,
        spec,
        addInstallLog
      );

      if (ok) {
        await refresh();
      }
      return ok;
    },
    [addInstallLog, clearInstallLog, refresh]
  );

  useEffect(() => {
    // Module-aware shortcut dispatcher. Every Cmd/Ctrl shortcut checks the
    // currently active module (client / rest / vault / docs / home) and
    // either runs the client-shaped action, dispatches a `penguin:rest-*`
    // event the REST module listens for, or no-ops with preventDefault. This
    // replaces the previous "always-on global" handler where Cmd+N would open
    // the gRPC NewRequestDialog even when the user was inside the REST page.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const isClient = activeModule === "client";
      const isRest = activeModule === "rest";

      switch (e.key.toLowerCase()) {
        // Universal — always available; module-aware target.
        case "/":
          e.preventDefault();
          setShortcutsOpen((o) => !o);
          break;
        case "i":
          e.preventDefault();
          if (e.shiftKey) {
            // cURL import is REST-shaped — when REST module is active, open
            // the REST-aware import dialog instead of the gRPC-shaped one.
            if (isRest) document.dispatchEvent(new CustomEvent(REST_OPEN_CURL_IMPORT_EVENT));
            else setCurlImportOpen((o) => !o);
          } else {
            setNetworkOpen((o) => !o);
          }
          break;

        // Find — client opens CommandSearch; REST focuses sidebar search.
        case "f":
          e.preventDefault();
          if (isClient) setSearchOpen((o) => !o);
          else if (isRest) document.dispatchEvent(new CustomEvent(REST_FOCUS_SEARCH_EVENT));
          break;

        // New (Cmd+N) — module-aware. Cmd+T is a REST alias.
        case "n":
          e.preventDefault();
          if (isClient) setNewRequestOpen(true);
          else if (isRest) document.dispatchEvent(new CustomEvent(REST_NEW_REQUEST_EVENT));
          break;
        case "t":
          if (isRest) {
            e.preventDefault();
            document.dispatchEvent(new CustomEvent(REST_NEW_REQUEST_EVENT));
          }
          break;

        // Close active tab — module-aware.
        case "w":
          e.preventDefault();
          if (isClient && activeTabId) removeTab(activeTabId);
          else if (isRest) document.dispatchEvent(new CustomEvent(REST_CLOSE_TAB_EVENT));
          break;

        // Reset tab — client-only; noop elsewhere (REST records auto-persist).
        case "r":
          if (!isClient) {
            e.preventDefault();
            break;
          }
          e.preventDefault();
          if (activeTab) {
            updateActiveTab({
              requestBody: "{}",
              response: undefined,
              selectedMethod: null,
              selectedService: null,
              selectedPackage: null,
              metadata: getDefaultHeadersForProtocol(activeTab.protocolTab),
            });
          }
          refresh();
          document.dispatchEvent(new CustomEvent("penguin:collapse-sidebar"));
          break;

        // Save — client Cmd+S = installer, Cmd+Shift+S = save gRPC request.
        // REST always saves the active request (Postman convention).
        case "s":
          e.preventDefault();
          if (isRest) {
            document.dispatchEvent(new CustomEvent(REST_SAVE_REQUEST_EVENT));
          } else if (isClient) {
            if (e.shiftKey) document.dispatchEvent(new CustomEvent("penguin:save-request"));
            else setInstallerOpen(true);
          }
          break;

        // Cycle protocol — gRPC-only concept.
        case "e":
          if (isClient) {
            e.preventDefault();
            handleCycleProtocol();
          }
          break;

        // History / saved / docs / proto — gRPC-only.
        case "h":
          if (isClient) {
            e.preventDefault();
            setHistoryOpen((o) => !o);
          } else if (isRest) {
            e.preventDefault();
            document.dispatchEvent(new CustomEvent(REST_OPEN_HISTORY_EVENT));
          }
          break;
        case "o":
          if (isClient) {
            e.preventDefault();
            setSavedOpen((o) => !o);
          }
          break;
        case "d":
          if (isClient) {
            e.preventDefault();
            setDocOpen((o) => !o);
          }
          break;
        case "p":
          if (isClient) {
            e.preventDefault();
            setProtoViewerOpen((o) => !o);
          }
          break;

        // Send active request — module-aware target event.
        case "enter":
          e.preventDefault();
          if (isClient) document.dispatchEvent(new CustomEvent("penguin:send-request"));
          else if (isRest) document.dispatchEvent(new CustomEvent(REST_SEND_REQUEST_EVENT));
          break;

        // Focus URL bar — REST-only (Postman convention).
        case "l":
          if (isRest) {
            e.preventDefault();
            document.dispatchEvent(new CustomEvent(REST_FOCUS_URL_EVENT));
          }
          break;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    activeModule,
    activeTabId,
    activeTab,
    removeTab,
    refresh,
    setInstallerOpen,
    handleCycleProtocol,
    updateActiveTab,
  ]);

  useEffect(() => {
    const openDoc = () => setDocOpen(true);
    const openProto = () => setProtoViewerOpen(true);
    document.addEventListener("penguin:open-doc", openDoc);
    document.addEventListener("penguin:open-proto", openProto);
    return () => {
      document.removeEventListener("penguin:open-doc", openDoc);
      document.removeEventListener("penguin:open-proto", openProto);
    };
  }, []);

  // Defense-in-depth guard against inline webviews bleeding into other
  // modules. macOS WKWebView's close timing can race the next module's
  // first paint — earlier the user reported seeing the Vault sign-in
  // page painted over the gRPC-Web view after switching.
  //
  // We HIDE rather than CLOSE: closing would destroy the WKWebView and
  // force a URL reload (white-screen flash) every time the user comes
  // back to the Browser. Hidden webviews don't paint anything, so the
  // bleed-prevention still holds, and session + cookies + scroll
  // position all survive the trip.
  useEffect(() => {
    if (activeModule === "vault" || activeModule === "browser") return;
    hideAllInlineWebviews().catch(() => {
      // best-effort — the next module is what matters, not the IPC log
    });
  }, [activeModule]);

  // Persist the active module on every change so an OS-level reload
  // (right-click → Reload, Cmd+R, etc.) re-enters the same module
  // instead of dumping the user back on Client. Gated on
  // `devModeHydrated`: until the token finishes loading, the gate
  // effect may have transiently kicked the user back to Client based
  // on stale `hasValidToken=false` — persisting that would corrupt the
  // restore value for the next reload.
  useEffect(() => {
    if (!devModeHydrated) return;
    try {
      setPersistedValue(APP_VALUE_KEYS.activeModule, activeModule);
    } catch {
      /* best-effort — losing this just means the next reload resets */
    }
  }, [devModeHydrated, activeModule]);

  useEffect(() => {
    const closeAll = () => {
      setInstallerOpen(false);
      setSearchOpen(false);
      setHistoryOpen(false);
      setSavedOpen(false);
      setDocOpen(false);
      setEnvManagerOpen(false);
      setSettingsOpen(false);
      setNewRequestOpen(false);
      setShortcutsOpen(false);
      setNetworkOpen(false);
      setCurlImportOpen(false);
      setProtoViewerOpen(false);
    };
    document.addEventListener("penguin:close-all-dialogs", closeAll);
    return () => document.removeEventListener("penguin:close-all-dialogs", closeAll);
  }, [setInstallerOpen]);

  // Listens for VaultEmptyGate's request to open Settings — see DEC #57 / #59.
  useEffect(() => {
    const handleOpenSettings = () => setSettingsOpen(true);
    document.addEventListener(PENGUIN_OPEN_SETTINGS_EVENT, handleOpenSettings);
    return () => document.removeEventListener(PENGUIN_OPEN_SETTINGS_EVENT, handleOpenSettings);
  }, []);

  // Listens for a "go home" request from inside any module (e.g. the Lark
  // setup card's close button). The Home hub is gone, so this now returns
  // to the API Client — the default module.
  useEffect(() => {
    const handleGoHome = (): void => {
      setVaultOpen(false);
      setDocsOpen(false);
      setRestOpen(false);
      setBrowserOpen(false);
      setDatabaseOpen(false);
    };
    document.addEventListener(PENGUIN_GO_HOME_EVENT, handleGoHome);
    return () => document.removeEventListener(PENGUIN_GO_HOME_EVENT, handleGoHome);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute(
      "data-theme",
      useAppStore.getState().theme
    );
  }, []);

  // Hidden Developer Mode gesture: hold Cmd(⌘) + G for 3s. macOS swallows
  // keyup for letter keys while ⌘ is held, so we gate the hold on the
  // (reliably-delivered) ⌘ keyup + window blur — effectively "press ⌘+G
  // and keep ⌘ down for 3s." preventDefault stops ⌘+G's default while arming.
  useEffect(() => {
    const down = new Set<string>();
    let holdTimer: number | null = null;
    const cancel = () => {
      if (holdTimer !== null) {
        window.clearTimeout(holdTimer);
        holdTimer = null;
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "g") down.add("g");
      else if (k !== "meta") return;
      if (e.metaKey && down.has("g")) {
        e.preventDefault();
        if (holdTimer === null) {
          holdTimer = window.setTimeout(() => {
            holdTimer = null;
            down.clear();
            setDevModalOpen(true);
          }, 3000);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "g") down.delete("g");
      else if (k === "meta") down.clear();
      if (!(e.metaKey && down.has("g"))) cancel();
    };
    const onBlur = () => {
      down.clear();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      if (holdTimer !== null) window.clearTimeout(holdTimer);
    };
  }, []);

  return (
    <div className="penguin-app-shell relative h-screen w-screen overflow-hidden bg-background text-foreground">
      <SnowLayer active={theme === "antarctic-snow"} />
      <div className="relative z-10 flex h-full flex-col">
        <Header
          onOpenSettings={openSettings}
          appUpdate={appUpdate}
          showClientControls={activeModule === "client"}
        />
        <UpdateNotification
          open={appUpdate.shouldShowToast}
          updateVersion={appUpdate.updateVersion}
          isWorking={appUpdate.status === "downloading"}
          downloadProgress={appUpdate.downloadProgress}
          onLater={appUpdate.dismiss}
          onUpdate={appUpdate.downloadInstallAndRestart}
        />
        <Toaster />
        <div className="flex flex-1 min-h-0">
          <MainSidebar
            active={activeModule}
            onSelect={handleModuleSelect}
            hasValidToken={canAccessVault}
            isSuperAdmin={canAccessDocs || canAccessDatabase || canAccessBrowser}
          />
          <div className="flex flex-1 flex-col min-w-0">
            {vaultOpen ? (
              <VaultPage onClose={closeVault} onOpenInBrowser={handleOpenInBrowser} />
            ) : docsOpen ? (
              <ApiDocsPage onClose={selectApiClient} />
            ) : restOpen ? (
              <RestPage onClose={selectApiClient} />
            ) : browserOpen ? (
              <BrowserPage onClose={closeBrowser} />
            ) : databaseOpen ? (
              <DatabasePage onClose={closeDatabase} />
            ) : wikiOpen ? (
              <WikiPage onClose={closeWiki} />
            ) : (
              <>
                <TabBar
                  onCycleProtocol={handleCycleProtocol}
                  onNewRequest={() => setNewRequestOpen(true)}
                />
                <div className="flex flex-1 min-h-0">
                  <Sidebar
                    packages={packages}
                    onInstallClick={() => setInstallerOpen(true)}
                    onUninstall={(name) => {
                      uninstall(name);
                    }}
                    onUpdate={async (spec) => {
                      const ok = await handleInstall(spec);
                      return ok;
                    }}
                  />

                  <div className="flex flex-1 flex-col min-w-0">
                    <UrlBar resolvedUrl={resolvedUrl} />
                    <ResizablePanels
                      left={<RequestPanel />}
                      right={<ResponsePanel />}
                      defaultRatio={0.45}
                      minRatio={0.25}
                      maxRatio={0.75}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Persistent bottom status bar — same row across every module
            (Home / Client / Vault / REST / Docs). Lives at the root of
            the flex column so it stays pinned regardless of which
            module is mounted. */}
        <StatusBar
          onOpenSettings={openSettings}
          onOpenShortcuts={() => setShortcutsOpen(true)}
        />

        <Suspense fallback={null}>
          {isInstallerOpen && (
            <PackageInstaller
              onInstall={handleInstall}
              onClose={() => setInstallerOpen(false)}
              packages={packages}
            />
          )}
          {settingsOpen && (
            <SettingsDialog
              onClose={() => setSettingsOpen(false)}
              onOpenEnvManager={() => setEnvManagerOpen(true)}
              appUpdate={appUpdate}
              onPackagesCleared={handlePackagesCleared}
            />
          )}
          {envManagerOpen && (
            <EnvManager onClose={() => setEnvManagerOpen(false)} />
          )}
          {searchOpen && <CommandSearch open={searchOpen} onClose={() => setSearchOpen(false)} />}
          {historyOpen && <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />}
          {savedOpen && <SavedRequestsPanel open={savedOpen} onClose={() => setSavedOpen(false)} />}
          {newRequestOpen && <NewRequestDialog open={newRequestOpen} onClose={() => setNewRequestOpen(false)} />}
          {docOpen && <RequestDocDialog open={docOpen} onClose={() => setDocOpen(false)} />}
          {shortcutsOpen && <ShortcutCheatSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} activeModule={activeModule} />}
          {networkOpen && <NetworkCheck open={networkOpen} onClose={() => setNetworkOpen(false)} />}
          {curlImportOpen && <CurlImport open={curlImportOpen} onClose={() => setCurlImportOpen(false)} />}
          {protoViewerOpen && <ProtoViewer open={protoViewerOpen} onClose={() => setProtoViewerOpen(false)} />}
          {devModalOpen && <DeveloperModeModal onClose={() => setDevModalOpen(false)} />}
          <Welcome />
          <InteractiveTutorial />
        </Suspense>
      </div>
    </div>
  );
}
