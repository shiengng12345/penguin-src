import {
  deletePersistedValue,
  getPersistedValue,
  setPersistedValue,
} from "./app-persistence";
import { APP_VALUE_KEYS } from "./persistence-keys";
import { isAppTheme, type AppTheme } from "./theme";
import type {
  BrowserShortcut,
  HistoryEntry,
  JenkinsAccount,
  JenkinsLink,
  JenkinsState,
  MetadataEntry,
  ProtocolTab,
  RequestTab,
  SavedRequest,
} from "./store-types";

// --- Persistence keys ---

export const THEME_KEY = APP_VALUE_KEYS.theme;
export const TUTORIAL_KEY = APP_VALUE_KEYS.tutorialSeen;
export const USERNAME_KEY = APP_VALUE_KEYS.userName;
export const TABS_KEY = APP_VALUE_KEYS.tabs;
export const ACTIVE_TAB_KEY = APP_VALUE_KEYS.activeTab;
export const HISTORY_KEY = APP_VALUE_KEYS.history;
export const MAX_HISTORY_KEY = APP_VALUE_KEYS.maxHistory;
export const DEFAULT_MAX_HISTORY = 500;
export const SAVED_REQUESTS_KEY = APP_VALUE_KEYS.savedRequests;
export const DEFAULT_HEADERS_KEY = APP_VALUE_KEYS.defaultHeaders;
export const BROWSER_SHORTCUTS_KEY = APP_VALUE_KEYS.browserShortcuts;
export const BROWSER_AUTO_SUBMIT_KEY = APP_VALUE_KEYS.browserAutoSubmit;
export const BROWSER_AUTO_SUBMIT_GLOBAL_KEY = APP_VALUE_KEYS.browserAutoSubmitGlobal;
export const JENKINS_DATA_KEY = APP_VALUE_KEYS.jenkinsData;

// --- Load/save helpers ---

// Backend routes all UAT/QAT traffic through one shared URL per group;
// x-env-tag is the routing signal. Value left empty so the user fills it in
// (literal "QAT"/"UAT" or a `{{VAR}}` template) — no implicit template default.
const X_ENV_TAG_DEFAULT: MetadataEntry = {
  key: "x-env-tag",
  value: "",
  enabled: true,
};

const PLATFORM_ID_DEFAULT: MetadataEntry = {
  key: "platform-id",
  value: "",
  enabled: true,
};

export function loadMaxHistorySize(): number {
  const raw = getPersistedValue(MAX_HISTORY_KEY);
  if (raw) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return DEFAULT_MAX_HISTORY;
}

export function loadDefaultHeaders(): Record<ProtocolTab, MetadataEntry[]> {
  const fallback: Record<ProtocolTab, MetadataEntry[]> = {
    "grpc-web": [
      { key: "Authorization", value: "Bearer ", enabled: true },
      { key: "eId", value: "", enabled: true },
      { ...X_ENV_TAG_DEFAULT },
      { ...PLATFORM_ID_DEFAULT },
    ],
    grpc: [
      { key: "Authorization", value: "Bearer ", enabled: true },
      { key: "eId", value: "", enabled: true },
      { ...X_ENV_TAG_DEFAULT },
      { ...PLATFORM_ID_DEFAULT },
    ],
    sdk: [
      { key: "Authorization", value: "Bearer ", enabled: true },
      { key: "eId", value: "", enabled: true },
      { ...X_ENV_TAG_DEFAULT },
      { ...PLATFORM_ID_DEFAULT },
    ],
    rest: [
      { key: "Authorization", value: "Bearer ", enabled: true },
      { key: "Content-Type", value: "application/json", enabled: true },
      { ...X_ENV_TAG_DEFAULT },
      { ...PLATFORM_ID_DEFAULT },
    ],
  };
  try {
    const raw = getPersistedValue(DEFAULT_HEADERS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<ProtocolTab, MetadataEntry[]>;
      const merged = { ...fallback, ...parsed };
      // One-time migration: existing users predate x-env-tag; if their stored
      // default headers don't include it, append it without disturbing other entries.
      const protocols: ProtocolTab[] = ["grpc-web", "grpc", "sdk", "rest"];
      let migrated = false;
      for (const protocol of protocols) {
        const current = merged[protocol] ?? [];
        const hasXEnvTag = current.some(
          (entry) => entry.key.trim().toLowerCase() === "x-env-tag",
        );
        if (!hasXEnvTag) {
          merged[protocol] = [...current, { ...X_ENV_TAG_DEFAULT }];
          migrated = true;
        }
        const hasPlatformId = merged[protocol].some(
          (entry) => entry.key.trim().toLowerCase() === "platform-id",
        );
        if (!hasPlatformId) {
          merged[protocol] = [...merged[protocol], { ...PLATFORM_ID_DEFAULT }];
          migrated = true;
        }
      }
      if (migrated) {
        setPersistedValue(DEFAULT_HEADERS_KEY, JSON.stringify(merged));
      }
      return merged;
    }
  } catch { /* corrupted */ }
  return fallback;
}

export function loadUserName(): string {
  return getPersistedValue(USERNAME_KEY) ?? "";
}

export function loadTabs(): { tabs: RequestTab[]; activeTabId: string | null } {
  try {
    const raw = getPersistedValue(TABS_KEY);
    if (raw) {
      const tabs: RequestTab[] = (JSON.parse(raw) as RequestTab[])
        .map((t: RequestTab) => ({
          ...t,
          restMethod: t.restMethod ?? "POST",
          restBodyMode: t.restBodyMode ?? "json",
          origin: t.origin ?? null,
        }))
        .filter((tab: RequestTab) => tab.protocolTab !== "rest");
      if (Array.isArray(tabs) && tabs.length > 0) {
        const activeTabId =
          getPersistedValue(ACTIVE_TAB_KEY) ?? tabs[0].id;
        return { tabs, activeTabId };
      }
    }
  } catch { /* corrupted data, start fresh */ }
  return { tabs: [], activeTabId: null };
}

let _saveTabsTimer: ReturnType<typeof setTimeout> | null = null;
export function saveTabs(tabs: RequestTab[], activeTabId: string | null) {
  if (_saveTabsTimer) clearTimeout(_saveTabsTimer);
  _saveTabsTimer = setTimeout(() => {
    setPersistedValue(TABS_KEY, JSON.stringify(tabs));
    if (activeTabId) {
      setPersistedValue(ACTIVE_TAB_KEY, activeTabId);
    } else {
      deletePersistedValue(ACTIVE_TAB_KEY);
    }
    _saveTabsTimer = null;
  }, 300);
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = getPersistedValue(HISTORY_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    }
  } catch { /* corrupted */ }
  return [];
}

// Pre-v1.9 versions kept the whole history as one JSON blob under HISTORY_KEY.
// Read it only for the one-shot migration into the request_history table.
export function loadLegacyHistoryBlob(): HistoryEntry[] {
  return loadHistory();
}

export function loadSavedRequests(): SavedRequest[] {
  try {
    const raw = getPersistedValue(SAVED_REQUESTS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    }
  } catch { /* corrupted */ }
  return [];
}

// One-shot default-theme switch shipped with v1.15.0: every user (new or
// upgrading) lands on the Penguin theme exactly once; any theme they pick
// afterwards is never overridden by later updates.
const THEME_ONBOARD_KEY = APP_VALUE_KEYS.themeDefaultOnboarded;
const THEME_ONBOARD_STAMP = "penguin-1.15.0";

export function loadTheme(): AppTheme {
  if (getPersistedValue(THEME_ONBOARD_KEY) !== THEME_ONBOARD_STAMP) {
    setPersistedValue(THEME_ONBOARD_KEY, THEME_ONBOARD_STAMP);
    setPersistedValue(THEME_KEY, "penguin");
    return "penguin";
  }
  const stored = getPersistedValue(THEME_KEY);
  if (stored && isAppTheme(stored)) return stored;
  return "penguin";
}

export function loadShowTutorial(): boolean {
  return getPersistedValue(TUTORIAL_KEY) !== "true";
}

// --- Browser module shortcuts ---
//
// Persist the pinned URL list to app_kv. Cookies / login state for
// each URL live in Tauri's WKWebSiteDataStore (the OS-level data
// folder), so this slice only needs to capture the user's curated set
// of bookmarks. Stored as JSON array.
export function loadBrowserShortcuts(): BrowserShortcut[] {
  try {
    const raw = getPersistedValue(BROWSER_SHORTCUTS_KEY);
    if (raw === null || raw === undefined || raw === "") return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Tolerate older / partial saves — keep entries with at least
    // id+label+url; drop the rest.
    return parsed.filter(
      (entry): entry is BrowserShortcut =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.id === "string" &&
        typeof entry.label === "string" &&
        typeof entry.url === "string",
    );
  } catch {
    return [];
  }
}

export function persistBrowserShortcuts(shortcuts: BrowserShortcut[]): void {
  try {
    setPersistedValue(BROWSER_SHORTCUTS_KEY, JSON.stringify(shortcuts));
  } catch {
    /* best effort — local fs / SQLite write; loss tolerated */
  }
}

// --- Browser auto-submit overrides ---
//
// Per-shortcut "click Sign in after prefill" override. The map carries
// BOTH true and false — absence means "use the default" (which is ON
// for any shortcut carrying prefill data). Persisting both lets an
// explicit opt-out survive a restart instead of bouncing back to the
// default ON.
export function loadBrowserAutoSubmit(): Record<string, boolean> {
  try {
    const raw = getPersistedValue(BROWSER_AUTO_SUBMIT_KEY);
    if (raw === null || raw === undefined || raw === "") return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === "string" && typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function persistBrowserAutoSubmit(map: Record<string, boolean>): void {
  try {
    setPersistedValue(BROWSER_AUTO_SUBMIT_KEY, JSON.stringify(map));
  } catch {
    /* best effort — local fs / SQLite write; loss tolerated */
  }
}

// --- Browser auto-submit master switch ---
//
// Defaults to ON when unset — per-shortcut ⚡ flags already serve as
// the explicit opt-in, so users don't have to flip TWO switches to
// enable auto-submit on a new shortcut. The global switch exists for
// quick "disable everything" without having to clear each ⚡.
export function loadBrowserAutoSubmitGlobal(): boolean {
  const raw = getPersistedValue(BROWSER_AUTO_SUBMIT_GLOBAL_KEY);
  if (raw === null || raw === undefined || raw === "") return true;
  return raw !== "false";
}

export function persistBrowserAutoSubmitGlobal(enabled: boolean): void {
  try {
    setPersistedValue(BROWSER_AUTO_SUBMIT_GLOBAL_KEY, enabled ? "true" : "false");
  } catch {
    /* best effort — local fs / SQLite write; loss tolerated */
  }
}

// --- Jenkins tab data ---

function isJenkinsAccount(value: unknown): value is JenkinsAccount {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    typeof v.username === "string" &&
    typeof v.password === "string" &&
    typeof v.createdAt === "number"
  );
}

function isJenkinsLink(value: unknown): value is JenkinsLink {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    typeof v.url === "string" &&
    typeof v.accountId === "string" &&
    typeof v.createdAt === "number"
  );
}

export function loadJenkinsData(): JenkinsState {
  try {
    const raw = getPersistedValue(JENKINS_DATA_KEY);
    if (raw === null || raw === undefined || raw === "") return { accounts: [], links: [] };
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { accounts: [], links: [] };
    const rawAccounts = Array.isArray((parsed as { accounts?: unknown }).accounts)
      ? ((parsed as { accounts: unknown[] }).accounts as unknown[])
      : [];
    const rawLinks = Array.isArray((parsed as { links?: unknown }).links)
      ? ((parsed as { links: unknown[] }).links as unknown[])
      : [];
    return {
      accounts: rawAccounts.filter(isJenkinsAccount),
      links: rawLinks.filter(isJenkinsLink),
    };
  } catch {
    return { accounts: [], links: [] };
  }
}

export function persistJenkinsData(state: JenkinsState): void {
  try {
    setPersistedValue(JENKINS_DATA_KEY, JSON.stringify(state));
  } catch {
    /* best effort — local fs / SQLite write; loss tolerated */
  }
}
