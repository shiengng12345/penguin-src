import {
  deletePersistedValue,
  getPersistedValue,
  setPersistedValue,
} from "./app-persistence";
import { APP_VALUE_KEYS } from "./persistence-keys";
import { isAppTheme, type AppTheme } from "./theme";
import type {
  HistoryEntry,
  MetadataEntry,
  ProtocolTab,
  RequestTab,
  SavedRequest,
  WebTransport,
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
export const DEFAULT_WEB_TRANSPORT_KEY = APP_VALUE_KEYS.defaultWebTransport;

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

export function loadDefaultWebTransport(): WebTransport {
  return getPersistedValue(DEFAULT_WEB_TRANSPORT_KEY) === "connect" ? "connect" : "grpc-web";
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
