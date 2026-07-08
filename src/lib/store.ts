import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  clearHistoryInDatabase,
  countHistoryInDatabase,
  deleteSavedRequestFromDatabase,
  listHistoryFromDatabase,
  loadSavedRequestsFromDatabase,
  persistSavedRequest,
  persistSavedRequests,
  putHistoryEntryInDatabase,
  renameSavedRequestInDatabase,
} from "./penguin-db";
import {
  deletePersistedValue,
  getPersistedValue,
  hydratePersistedValues,
  setPersistedValue,
} from "./app-persistence";
import { APP_VALUE_KEYS } from "./persistence-keys";
import { THEMES, type AppTheme } from "./theme";
import {
  visibleProtocolForTab,
  type AppState,
  type BrowserDeeplinkRequest,
  type BrowserShortcut,
  type MetadataEntry,
  type ProtocolTab,
  type RequestTab,
  type TabOrigin,
} from "./store-types";
import {
  DEFAULT_HEADERS_KEY,
  HISTORY_KEY,
  MAX_HISTORY_KEY,
  SAVED_REQUESTS_KEY,
  THEME_KEY,
  TUTORIAL_KEY,
  USERNAME_KEY,
  loadBrowserAutoSubmit,
  loadBrowserAutoSubmitGlobal,
  loadBrowserShortcuts,
  loadDefaultHeaders,
  loadJenkinsData,
  loadLegacyHistoryBlob,
  loadMaxHistorySize,
  loadSavedRequests,
  loadShowTutorial,
  loadTabs,
  loadTheme,
  loadUserName,
  persistJenkinsData,
  persistBrowserAutoSubmit,
  persistBrowserAutoSubmitGlobal,
  persistBrowserShortcuts,
  saveTabs,
} from "./store-persistence-helpers";

// Types and the AppState interface live in ./store-types; persistence load/save
// helpers live in ./store-persistence-helpers. Both are re-exported here so
// existing call sites (`import { ResponseState } from "./store"`) keep working
// unchanged.
export * from "./store-types";
export { THEMES, type AppTheme };

// --- Helpers ---

// loadDefaultHeaders runs at module load time, before the store exists, so
// createTab can fall back to this snapshot when useAppStore isn't ready yet.
const _defaultHeaders = loadDefaultHeaders();

function createTab(origin: TabOrigin = null, protocol: ProtocolTab = "grpc-web"): RequestTab {
  const visibleProtocol = visibleProtocolForTab(protocol);
  let headers: MetadataEntry[];
  try {
    headers = useAppStore.getState().defaultHeaders[visibleProtocol];
  } catch {
    headers = _defaultHeaders[visibleProtocol];
  }
  return {
    id: `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    protocolTab: visibleProtocol,
    targetUrl: "{{URL}}",
    pathOverride: null,
    restMethod: "POST",
    restBodyMode: "json",
    requestBody: "{}",
    metadata: headers.map((h) => ({ ...h })),
    selectedPackage: null,
    selectedService: null,
    selectedMethod: null,
    response: null,
    isLoading: false,
    origin,
  };
}

export function getDefaultHeadersForProtocol(protocol: ProtocolTab): MetadataEntry[] {
  try {
    return useAppStore.getState().defaultHeaders[protocol].map((h) => ({ ...h }));
  } catch {
    return _defaultHeaders[protocol].map((h) => ({ ...h }));
  }
}

// Returns the headers that should actually be sent for a tab: tab.metadata
// takes precedence (including when an entry is present-but-disabled — the user
// has explicitly opted out), and any default header whose key the tab hasn't
// touched is appended. Header keys compare case-insensitively per HTTP semantics.
export function mergeWithDefaultHeaders(
  tabMetadata: MetadataEntry[],
  protocol: ProtocolTab,
): MetadataEntry[] {
  const tabKeys = new Set(
    tabMetadata
      .map((entry) => entry.key.trim().toLowerCase())
      .filter((key) => key.length > 0),
  );
  const inherited = getDefaultHeadersForProtocol(protocol).filter((entry) => {
    const key = entry.key.trim().toLowerCase();
    return key.length > 0 && !tabKeys.has(key);
  });
  return [...tabMetadata, ...inherited];
}

export { createTab };

export const HISTORY_PAGE_SIZE = 50;

// Initial shape for a fresh RestResponseSlot. Centralized so the four
// slot writers (setRestResponseResult / setRestSending /
// setRestResponseSubTab / setRestResponseShowFullBody) can all spread
// defaults under any partial they're given without duplicating fields.
function defaultRestSlot(): import("./store-types").RestResponseSlot {
  return {
    response: null,
    sendError: null,
    sending: false,
    sendVersion: 0,
    subTab: "body",
    showFullBody: false,
  };
}

export const useAppStore = create<AppState>((set, get) => {
  const initialTheme = loadTheme();
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", initialTheme);
  }
  const restored = loadTabs();
  const initialTab = restored.tabs.length > 0 ? null : createTab();
  const startTabs = restored.tabs.length > 0 ? restored.tabs : [initialTab!];
  const startActiveId =
    restored.activeTabId && restored.tabs.some((tab) => tab.id === restored.activeTabId)
      ? restored.activeTabId
      : startTabs[0].id;
  return {
    tabs: startTabs,
    activeTabId: startActiveId,
    addTab: (protocol = "grpc-web") => {
      const tab = createTab(null, protocol);
      set((s) => {
        const next = { tabs: [...s.tabs, tab], activeTabId: tab.id };
        saveTabs(next.tabs, next.activeTabId);
        return next;
      });
      return tab;
    },
    removeTab: (id) => {
      set((s) => {
        const idx = s.tabs.findIndex((t) => t.id === id);
        const next = s.tabs.filter((t) => t.id !== id);
        if (next.length === 0) {
          const fresh = createTab();
          saveTabs([fresh], fresh.id);
          return { tabs: [fresh], activeTabId: fresh.id };
        }
        const nextActive =
          s.activeTabId === id
            ? (next[Math.min(idx, next.length - 1)]?.id ?? next[0]?.id ?? null)
            : s.activeTabId;
        saveTabs(next, nextActive);
        return { tabs: next, activeTabId: nextActive };
      });
    },
    resetActiveTab: () => {
      const tabs = get().tabs;
      const activeTabId = tabs[0]?.id ?? null;
      set({ activeTabId });
      saveTabs(tabs, activeTabId);
    },
    resetPackageTabs: () => {
      const fresh = createTab();
      set({ tabs: [fresh], activeTabId: fresh.id });
      saveTabs([fresh], fresh.id);
    },
    sanitizeHiddenRestTabs: () => {
      set((s) => {
        const nextTabs = s.tabs.filter((tab) => tab.protocolTab !== "rest");
        if (nextTabs.length === s.tabs.length) return {};
        const tabs = nextTabs.length > 0 ? nextTabs : [createTab()];
        const activeTabId =
          s.activeTabId && tabs.some((tab) => tab.id === s.activeTabId)
            ? s.activeTabId
            : tabs[0].id;
        saveTabs(tabs, activeTabId);
        return { tabs, activeTabId };
      });
    },
    setActiveTab: (id) => {
      set({ activeTabId: id });
      saveTabs(get().tabs, id);
    },
    updateActiveTab: (patch) => {
      const { activeTabId, tabs } = get();
      if (!activeTabId) return;
      const nextTabs = tabs.map((t) =>
        t.id === activeTabId ? { ...t, ...patch } : t
      );
      set({ tabs: nextTabs });
      saveTabs(nextTabs, activeTabId);
    },

    grpcWebPackages: [],
    grpcPackages: [],
    sdkPackages: [],
    setGrpcWebPackages: (pkgs) => set({ grpcWebPackages: pkgs }),
    setGrpcPackages: (pkgs) => set({ grpcPackages: pkgs }),
    setSdkPackages: (pkgs) => set({ sdkPackages: pkgs }),
    addGrpcWebPackage: (pkg) =>
      set((s) => ({
        grpcWebPackages: [...s.grpcWebPackages, pkg],
      })),
    addGrpcPackage: (pkg) =>
      set((s) => ({
        grpcPackages: [...s.grpcPackages, pkg],
      })),
    addSdkPackage: (pkg) =>
      set((s) => ({
        sdkPackages: [...s.sdkPackages, pkg],
      })),
    removeGrpcWebPackage: (name) =>
      set((s) => ({
        grpcWebPackages: s.grpcWebPackages.filter((p) => p.name !== name),
      })),
    removeGrpcPackage: (name) =>
      set((s) => ({
        grpcPackages: s.grpcPackages.filter((p) => p.name !== name),
      })),
    removeSdkPackage: (name) =>
      set((s) => ({
        sdkPackages: s.sdkPackages.filter((p) => p.name !== name),
      })),

    configSynced: false,
    grpcWebEnvironments: [],
    grpcEnvironments: [],
    sdkEnvironments: [],
    restEnvironments: [],
    grpcWebActiveEnvId: null,
    grpcActiveEnvId: null,
    sdkActiveEnvId: null,
    restActiveEnvId: null,
    setGrpcWebEnvironments: (envs) => set({ grpcWebEnvironments: envs }),
    setGrpcEnvironments: (envs) => set({ grpcEnvironments: envs }),
    setSdkEnvironments: (envs) => set({ sdkEnvironments: envs }),
    setRestEnvironments: (envs) => set({ restEnvironments: envs }),
    setGrpcWebActiveEnvId: (id) => set({ grpcWebActiveEnvId: id }),
    setGrpcActiveEnvId: (id) => set({ grpcActiveEnvId: id }),
    setSdkActiveEnvId: (id) => set({ sdkActiveEnvId: id }),
    setRestActiveEnvId: (id) => set({ restActiveEnvId: id }),
    addGrpcWebEnvironment: (env) =>
      set((s) => ({
        grpcWebEnvironments: [...s.grpcWebEnvironments, env],
      })),
    addGrpcEnvironment: (env) =>
      set((s) => ({
        grpcEnvironments: [...s.grpcEnvironments, env],
      })),
    addSdkEnvironment: (env) =>
      set((s) => ({
        sdkEnvironments: [...s.sdkEnvironments, env],
      })),
    addRestEnvironment: (env) =>
      set((s) => ({
        restEnvironments: [...s.restEnvironments, env],
      })),
    updateGrpcWebEnvironment: (id, patch) =>
      set((s) => ({
        grpcWebEnvironments: s.grpcWebEnvironments.map((e) =>
          e.id === id ? { ...e, ...patch } : e
        ),
      })),
    updateGrpcEnvironment: (id, patch) =>
      set((s) => ({
        grpcEnvironments: s.grpcEnvironments.map((e) =>
          e.id === id ? { ...e, ...patch } : e
        ),
      })),
    updateSdkEnvironment: (id, patch) =>
      set((s) => ({
        sdkEnvironments: s.sdkEnvironments.map((e) =>
          e.id === id ? { ...e, ...patch } : e
        ),
      })),
    updateRestEnvironment: (id, patch) =>
      set((s) => ({
        restEnvironments: s.restEnvironments.map((e) =>
          e.id === id ? { ...e, ...patch } : e
        ),
      })),
    deleteGrpcWebEnvironment: (id) =>
      set((s) => ({
        grpcWebEnvironments: s.grpcWebEnvironments.filter((e) => e.id !== id),
        grpcWebActiveEnvId:
          s.grpcWebActiveEnvId === id ? null : s.grpcWebActiveEnvId,
      })),
    deleteGrpcEnvironment: (id) =>
      set((s) => ({
        grpcEnvironments: s.grpcEnvironments.filter((e) => e.id !== id),
        grpcActiveEnvId: s.grpcActiveEnvId === id ? null : s.grpcActiveEnvId,
      })),
    deleteSdkEnvironment: (id) =>
      set((s) => ({
        sdkEnvironments: s.sdkEnvironments.filter((e) => e.id !== id),
        sdkActiveEnvId: s.sdkActiveEnvId === id ? null : s.sdkActiveEnvId,
      })),
    deleteRestEnvironment: (id) =>
      set((s) => ({
        restEnvironments: s.restEnvironments.filter((e) => e.id !== id),
        restActiveEnvId: s.restActiveEnvId === id ? null : s.restActiveEnvId,
      })),

    // -- Session-only REST per-request response slice --
    // NOT persisted to app_kv (responses can be 10-50 MB; SQLite would
    // bloat). Lives only for the lifetime of the app process. Survives
    // RestRequestEditor unmount on module switch — that's the entire
    // reason this exists. See store-types.ts for shape rationale.
    restResponses: {},
    setRestResponseResult: (id, version, response, error) =>
      set((s) => {
        const slot = s.restResponses[id];
        // Stale guard: a send started at version V can only write its
        // result if no newer send has bumped the version since. Catches
        // race where user clicks Send twice / cancels / switches module
        // mid-flight then sends again.
        if (slot && slot.sendVersion !== version) return s;
        return {
          restResponses: {
            ...s.restResponses,
            [id]: {
              ...defaultRestSlot(),
              ...(slot ?? {}),
              response,
              sendError: error,
              sending: false,
            },
          },
        };
      }),
    setRestSending: (id, sending) =>
      set((s) => ({
        restResponses: {
          ...s.restResponses,
          [id]: { ...defaultRestSlot(), ...(s.restResponses[id] ?? {}), sending },
        },
      })),
    bumpRestSendVersion: (id) => {
      let next = 1;
      set((s) => {
        const slot = s.restResponses[id] ?? defaultRestSlot();
        next = slot.sendVersion + 1;
        return {
          restResponses: {
            ...s.restResponses,
            [id]: { ...slot, sendVersion: next },
          },
        };
      });
      return next;
    },
    setRestResponseSubTab: (id, subTab) =>
      set((s) => ({
        restResponses: {
          ...s.restResponses,
          [id]: { ...defaultRestSlot(), ...(s.restResponses[id] ?? {}), subTab },
        },
      })),
    setRestResponseShowFullBody: (id, showFull) =>
      set((s) => ({
        restResponses: {
          ...s.restResponses,
          [id]: {
            ...defaultRestSlot(),
            ...(s.restResponses[id] ?? {}),
            showFullBody: showFull,
          },
        },
      })),
    clearRestResponse: (id) =>
      set((s) => {
        if (!(id in s.restResponses)) return s;
        const next = { ...s.restResponses };
        delete next[id];
        return { restResponses: next };
      }),

    // -- Session-only REST workspace UI state --
    // Lifted out of RestPage's local useState so it survives module
    // switch. See store-types.ts RestWorkspaceState comment.
    restWorkspace: {
      selectedProjectId: null,
      selectedEnvId: null,
      openTabIds: [],
      activeTabId: null,
      lastCollectionId: null,
    },
    setRestWorkspace: (patch) =>
      set((s) => ({ restWorkspace: { ...s.restWorkspace, ...patch } })),

    // -- In-app Browser module --
    // Pinned shortcuts hydrated from app_kv on startup; the rest of
    // the state (activeShortcutId, pendingDeeplink) is session-only.
    // See loadBrowserShortcuts below for the hydrate path.
    browser: {
      shortcuts: loadBrowserShortcuts(),
      activeShortcutId: null,
      pendingDeeplink: null,
      autoSubmitByShortcutId: loadBrowserAutoSubmit(),
      autoSubmitGlobalEnabled: loadBrowserAutoSubmitGlobal(),
    },
    addOrPromoteBrowserShortcut: (shortcut) => {
      // De-dupe by URL — if the user already has this URL pinned,
      // promote it (update label / token / baseKind) and return its
      // existing id. Avoids 4 "Vault QAT" pins after 4 deeplinks.
      const existing = get().browser.shortcuts.find((s) => s.url === shortcut.url);
      if (existing !== undefined) {
        const merged: BrowserShortcut = {
          ...existing,
          label: shortcut.label,
          prefillToken: shortcut.prefillToken ?? existing.prefillToken,
          prefillUsername: shortcut.prefillUsername ?? existing.prefillUsername,
          prefillPassword: shortcut.prefillPassword ?? existing.prefillPassword,
          baseKind: shortcut.baseKind ?? existing.baseKind,
          projectId: shortcut.projectId ?? existing.projectId,
          envId: shortcut.envId ?? existing.envId,
        };
        const next = get().browser.shortcuts.map((s) => (s.id === existing.id ? merged : s));
        set((s) => ({ browser: { ...s.browser, shortcuts: next, activeShortcutId: existing.id } }));
        persistBrowserShortcuts(next);
        return existing.id;
      }
      const newShortcut: BrowserShortcut = {
        id: `shortcut-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        label: shortcut.label,
        url: shortcut.url,
        prefillToken: shortcut.prefillToken,
        prefillUsername: shortcut.prefillUsername,
        prefillPassword: shortcut.prefillPassword,
        baseKind: shortcut.baseKind,
        projectId: shortcut.projectId,
        envId: shortcut.envId,
        parentId: shortcut.parentId,
        createdAt: Date.now(),
      };
      const next = [...get().browser.shortcuts, newShortcut];
      set((s) => ({ browser: { ...s.browser, shortcuts: next, activeShortcutId: newShortcut.id } }));
      persistBrowserShortcuts(next);
      return newShortcut.id;
    },
    duplicateBrowserShortcut: (source) => {
      // Resolve to the top-level ancestor — duplicating a duplicate
      // produces another sibling, not a grandchild (depth capped at 1
      // for visual clarity). For vault-derived sources (synthetic id
      // starting with "vault-"), use the synthetic id as parent so
      // refreshes that recreate the parent don't orphan the branch.
      const all = get().browser.shortcuts;
      let topLevelId = source.parentId;
      if (topLevelId === undefined) {
        topLevelId = source.id;
      }
      // Pick the next free suffix among existing siblings sharing this
      // parent. Existing labels like "QAT", "QAT (2)", "QAT (3)" →
      // next is "QAT (4)". The base name is the source's current
      // label minus any " (N)" tail.
      const baseLabel = source.label.replace(/ \(\d+\)$/, "");
      const siblings = all.filter((s) => s.parentId === topLevelId);
      let nextN = 2;
      while (
        siblings.some((s) => s.label === `${baseLabel} (${nextN})`) ||
        baseLabel === `${baseLabel} (${nextN})`
      ) {
        nextN += 1;
      }
      const newShortcut: BrowserShortcut = {
        id: `shortcut-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        label: `${baseLabel} (${nextN})`,
        url: source.url,
        prefillToken: source.prefillToken,
        prefillUsername: source.prefillUsername,
        prefillPassword: source.prefillPassword,
        baseKind: source.baseKind,
        projectId: source.projectId,
        envId: source.envId,
        parentId: topLevelId,
        createdAt: Date.now(),
      };
      const next = [...all, newShortcut];
      set((s) => ({
        browser: { ...s.browser, shortcuts: next, activeShortcutId: newShortcut.id },
      }));
      persistBrowserShortcuts(next);
      return newShortcut.id;
    },
    removeBrowserShortcut: (id) => {
      const next = get().browser.shortcuts.filter((s) => s.id !== id);
      const wasActive = get().browser.activeShortcutId === id;
      // Drop any autoSubmit opt-in for the removed id so stale entries
      // don't accumulate forever in app_kv.
      const prevMap = get().browser.autoSubmitByShortcutId;
      let nextMap = prevMap;
      if (prevMap[id] !== undefined) {
        nextMap = { ...prevMap };
        delete nextMap[id];
      }
      set((s) => ({
        browser: {
          ...s.browser,
          shortcuts: next,
          activeShortcutId: wasActive ? null : s.browser.activeShortcutId,
          autoSubmitByShortcutId: nextMap,
        },
      }));
      persistBrowserShortcuts(next);
      if (nextMap !== prevMap) persistBrowserAutoSubmit(nextMap);
      // Close the underlying webview and delete its on-disk data store
      // (cookies + IndexedDB + cache). The data dir is keyed by the
      // shortcut's own id (see BrowserPage dataKey resolution).
      void invoke("inline_webview_close", { label: `inline-browser-${id}` }).catch(() => {});
      void invoke("inline_webview_close", { label: `browser-${id}` }).catch(() => {});
      void invoke("inline_webview_delete_data_dir", { dataKey: id }).catch(() => {});
    },
    renameBrowserShortcut: (id, label) => {
      const trimmed = label.trim();
      if (trimmed.length === 0) return;
      const next = get().browser.shortcuts.map((s) =>
        s.id === id ? { ...s, label: trimmed } : s,
      );
      set((s) => ({ browser: { ...s.browser, shortcuts: next } }));
      persistBrowserShortcuts(next);
    },
    reorderBrowserShortcuts: (orderedIds) => {
      const byId = new Map(get().browser.shortcuts.map((s) => [s.id, s] as const));
      const reordered: BrowserShortcut[] = [];
      for (const id of orderedIds) {
        const s = byId.get(id);
        if (s !== undefined) {
          reordered.push(s);
          byId.delete(id);
        }
      }
      for (const leftover of byId.values()) reordered.push(leftover);
      set((s) => ({ browser: { ...s.browser, shortcuts: reordered } }));
      persistBrowserShortcuts(reordered);
    },
    setActiveBrowserShortcut: (id) =>
      set((s) => ({ browser: { ...s.browser, activeShortcutId: id } })),
    requestBrowserDeeplink: (request: BrowserDeeplinkRequest) =>
      set((s) => ({ browser: { ...s.browser, pendingDeeplink: request } })),
    consumeBrowserDeeplink: () => {
      const current = get().browser.pendingDeeplink;
      if (current === null) return null;
      set((s) => ({ browser: { ...s.browser, pendingDeeplink: null } }));
      return current;
    },
    setBrowserAutoSubmitGlobal: (enabled) => {
      if (get().browser.autoSubmitGlobalEnabled === enabled) return;
      set((s) => ({ browser: { ...s.browser, autoSubmitGlobalEnabled: enabled } }));
      persistBrowserAutoSubmitGlobal(enabled);
    },
    setBrowserShortcutAutoSubmit: (id, enabled) => {
      const prev = get().browser.autoSubmitByShortcutId;
      // BOTH true and false are stored explicitly. The map is now a
      // user-override layer over the new default (prefill-bearing
      // shortcuts default ON) — without persisting `false` an opt-out
      // would silently flip back to ON on next launch.
      if (prev[id] === enabled) return;
      const next: Record<string, boolean> = { ...prev, [id]: enabled };
      set((s) => ({ browser: { ...s.browser, autoSubmitByShortcutId: next } }));
      persistBrowserAutoSubmit(next);
    },

    // -- Jenkins tab CRUD --
    // Independent from Vault. The persistence layer collapses both
    // arrays into a single app_kv blob, so every action persists the
    // FULL current jenkins state.
    jenkins: loadJenkinsData(),
    addJenkinsAccount: (payload) => {
      const newAccount = {
        id: `jenkins-acc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        label: payload.label,
        username: payload.username,
        password: payload.password,
        totpSecret: payload.totpSecret,
        createdAt: Date.now(),
      };
      const next = { ...get().jenkins, accounts: [...get().jenkins.accounts, newAccount] };
      set({ jenkins: next });
      persistJenkinsData(next);
      return newAccount.id;
    },
    updateJenkinsAccount: (id, patch) => {
      const accounts = get().jenkins.accounts.map((a) =>
        a.id === id ? { ...a, ...patch } : a,
      );
      const next = { ...get().jenkins, accounts };
      set({ jenkins: next });
      persistJenkinsData(next);
    },
    removeJenkinsAccount: (id) => {
      const accounts = get().jenkins.accounts.filter((a) => a.id !== id);
      const orphanedLinks = get().jenkins.links.filter((l) => l.accountId === id);
      const links = get().jenkins.links.filter((l) => l.accountId !== id);
      for (const link of orphanedLinks) {
        void invoke("inline_webview_close", {
          label: `inline-browser-${link.id}`,
        }).catch(() => {});
      }
      void invoke("inline_webview_delete_data_dir", { dataKey: id }).catch(() => {});
      const next = { accounts, links };
      set({ jenkins: next });
      persistJenkinsData(next);
    },
    addJenkinsLink: (payload) => {
      const newLink = {
        id: `jenkins-link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        label: payload.label,
        url: payload.url,
        accountId: payload.accountId,
        createdAt: Date.now(),
      };
      const next = { ...get().jenkins, links: [...get().jenkins.links, newLink] };
      set({ jenkins: next });
      persistJenkinsData(next);
      return newLink.id;
    },
    updateJenkinsLink: (id, patch) => {
      const links = get().jenkins.links.map((l) =>
        l.id === id ? { ...l, ...patch } : l,
      );
      const next = { ...get().jenkins, links };
      set({ jenkins: next });
      persistJenkinsData(next);
    },
    removeJenkinsLink: (id) => {
      const links = get().jenkins.links.filter((l) => l.id !== id);
      const next = { ...get().jenkins, links };
      set({ jenkins: next });
      persistJenkinsData(next);
      void invoke("inline_webview_close", {
        label: `inline-browser-${id}`,
      }).catch(() => {});
    },

    theme: initialTheme,
    setTheme: (theme) => {
      if (typeof window !== "undefined") {
        setPersistedValue(THEME_KEY, theme);
        document.documentElement.setAttribute("data-theme", theme);
      }
      set({ theme });
    },

    isInstallerOpen: false,
    setInstallerOpen: (open) => set({ isInstallerOpen: open, installerPrefill: open ? get().installerPrefill : "" }),
    installerPrefill: "",
    setInstallerPrefill: (value) => set({ installerPrefill: value }),
    installerAutoRefresh: getPersistedValue(APP_VALUE_KEYS.installerAutoRefresh) === "true",
    setInstallerAutoRefresh: (value) => {
      setPersistedValue(APP_VALUE_KEYS.installerAutoRefresh, value ? "true" : "false");
      set({ installerAutoRefresh: value });
    },
    installLog: [],
    addInstallLog: (line) =>
      set((s) => ({ installLog: [...s.installLog, line] })),
    clearInstallLog: () => set({ installLog: [] }),

    searchPrefill: "",
    setSearchPrefill: (value) => set({ searchPrefill: value }),

    showTutorial: loadShowTutorial(),
    setShowTutorial: (show) => {
      setPersistedValue(TUTORIAL_KEY, show ? "false" : "true");
      set({ showTutorial: show });
    },

    userName: loadUserName(),
    setUserName: (name) => {
      setPersistedValue(USERNAME_KEY, name);
      set({ userName: name });
    },

    devModeEnabled: getPersistedValue(APP_VALUE_KEYS.devModeEnabled) === "true",
    setDevModeEnabled: (value) => {
      setPersistedValue(APP_VALUE_KEYS.devModeEnabled, value ? "true" : "false");
      set({ devModeEnabled: value });
    },
    hasValidToken: false,
    setHasValidToken: (value) => set({ hasValidToken: value }),
    isSuperAdmin: false,
    setIsSuperAdmin: (value) => set({ isSuperAdmin: value }),
    devModeHydrated: false,
    setDevModeHydrated: (value) => set({ devModeHydrated: value }),
    vaultProjects: [],
    setVaultProjects: (projects) => set({ vaultProjects: projects }),
    vaultLarkUrl: null,
    setVaultLarkUrl: (url) => set({ vaultLarkUrl: url }),
    vaultLastSyncedAt: null,
    setVaultLastSyncedAt: (timestamp) => set({ vaultLastSyncedAt: timestamp }),
    vaultIsDirty: false,
    setVaultIsDirty: (value) => set({ vaultIsDirty: value }),
    vaultSelectedProjectId: null,
    setVaultSelectedProjectId: (id) => set({ vaultSelectedProjectId: id }),
    vaultSelectedEnvId: "DEV",
    setVaultSelectedEnvId: (id) => set({ vaultSelectedEnvId: id }),
    history: [],
    historyTotal: 0,
    addHistory: (entry) => {
      set((s) => {
        void putHistoryEntryInDatabase(entry, s.maxHistorySize);
        return {
          history: [entry, ...s.history].slice(0, Math.max(s.maxHistorySize, HISTORY_PAGE_SIZE)),
          historyTotal: Math.min(s.historyTotal + 1, s.maxHistorySize),
        };
      });
    },
    attachHistoryResponse: (id, response) => {
      set((s) => {
        const target = s.history.find((h) => h.id === id);
        if (!target) return {};
        const updated = { ...target, response };
        void putHistoryEntryInDatabase(updated, s.maxHistorySize);
        return { history: s.history.map((h) => (h.id === id ? updated : h)) };
      });
    },
    loadMoreHistory: async () => {
      const { history } = useAppStore.getState();
      const [more, total] = await Promise.all([
        listHistoryFromDatabase(HISTORY_PAGE_SIZE, history.length),
        countHistoryInDatabase(),
      ]);
      set((s) => {
        const seen = new Set(s.history.map((h) => h.id));
        return {
          history: [...s.history, ...more.filter((h) => !seen.has(h.id))],
          historyTotal: total,
        };
      });
    },
    clearHistory: () => {
      void clearHistoryInDatabase();
      set({ history: [], historyTotal: 0 });
    },

    savedRequests: [],
    saveRequest: (entry) => {
      void persistSavedRequest(entry);
      set((s) => {
        const next = [entry, ...s.savedRequests];
        return { savedRequests: next };
      });
    },
    deleteSavedRequest: (id) => {
      void deleteSavedRequestFromDatabase(id);
      set((s) => {
        const next = s.savedRequests.filter((r) => r.id !== id);
        return { savedRequests: next };
      });
    },
    renameSavedRequest: (id, name) => {
      void renameSavedRequestInDatabase(id, name);
      set((s) => {
        const next = s.savedRequests.map((r) =>
          r.id === id ? { ...r, name } : r
        );
        return { savedRequests: next };
      });
    },

    maxHistorySize: loadMaxHistorySize(),
    setMaxHistorySize: (size) => {
      setPersistedValue(MAX_HISTORY_KEY, String(size));
      // DB rows beyond the new cap are trimmed on the next insert.
      set((s) => ({
        maxHistorySize: size,
        history: s.history.slice(0, size),
        historyTotal: Math.min(s.historyTotal, size),
      }));
    },

    defaultHeaders: loadDefaultHeaders(),
    setDefaultHeaders: (protocol, headers) => {
      set((s) => {
        const next = { ...s.defaultHeaders, [protocol]: headers };
        setPersistedValue(DEFAULT_HEADERS_KEY, JSON.stringify(next));
        return { defaultHeaders: next };
      });
    },
  };
});

// Defer loading heavy data until after initial render
if (typeof window !== "undefined") {
  requestAnimationFrame(() => {
    void hydratePersistedValues().then(async () => {
      const theme = loadTheme();
      document.documentElement.setAttribute("data-theme", theme);

      const restored = loadTabs();
      // Re-read devModeEnabled from the now-populated cache. The store's
      // initial value at line 340 reads at module-eval time and CAN
      // race ahead of hydrate when something static-imports App (the
      // race that vanishes the super-admin token after every full
      // reload). Reading again here is defense-in-depth — even if a
      // future refactor re-introduces an eager import, the flag self-
      // heals once hydration lands.
      const update: Partial<AppState> = {
        defaultHeaders: loadDefaultHeaders(),
        maxHistorySize: loadMaxHistorySize(),
        showTutorial: loadShowTutorial(),
        theme,
        userName: loadUserName(),
        devModeEnabled: getPersistedValue(APP_VALUE_KEYS.devModeEnabled) === "true",
      };

      if (restored.tabs.length > 0) {
        update.tabs = restored.tabs;
        update.activeTabId =
          restored.activeTabId &&
          restored.tabs.some((tab) => tab.id === restored.activeTabId)
            ? restored.activeTabId
            : restored.tabs[0].id;
      }

      const legacySavedRequests = loadSavedRequests();
      if (legacySavedRequests.length > 0) {
        await persistSavedRequests(legacySavedRequests);
        deletePersistedValue(SAVED_REQUESTS_KEY);
        update.savedRequests = legacySavedRequests;
      }

      useAppStore.setState(update);

      // If devModeEnabled just flipped on via the rehydrate above,
      // App.tsx's mount effect already fired with the stale `false` and
      // won't re-run initializeDevModeOnAppStart. Kick loadToken()
      // ourselves so hasValidToken / isSuperAdmin reflect the on-disk
      // token without forcing the user to retype it. Dynamic import
      // breaks the dev-mode-store → store circular dependency.
      if (update.devModeEnabled) {
        void import("./dev-mode-store").then((m) => m.loadToken());
      }

      const databaseSavedRequests = await loadSavedRequestsFromDatabase();
      if (databaseSavedRequests.length > 0) {
        useAppStore.setState({ savedRequests: databaseSavedRequests });
      }

      // One-shot migration: pre-v1.9 history blob → request_history rows.
      const legacyHistory = loadLegacyHistoryBlob();
      if (legacyHistory.length > 0) {
        const maxSize = useAppStore.getState().maxHistorySize;
        // Oldest first so the trim-on-insert keeps the newest entries.
        for (const entry of [...legacyHistory].reverse()) {
          await putHistoryEntryInDatabase(entry, maxSize);
        }
        deletePersistedValue(HISTORY_KEY);
      }

      const [firstPage, historyTotal] = await Promise.all([
        listHistoryFromDatabase(HISTORY_PAGE_SIZE, 0),
        countHistoryInDatabase(),
      ]);
      useAppStore.setState({ history: firstPage, historyTotal });
    });
  });
}

export function useActiveTab(): RequestTab | null {
  const activeTabId = useAppStore((s) => s.activeTabId);
  const tabs = useAppStore((s) => s.tabs);
  return tabs.find((t) => t.id === activeTabId) ?? null;
}
