export type PersistedProtocol = "grpc-web" | "grpc" | "sdk" | "rest";

// Runtime Manager — Prevent Sleep policy (Task 13). Stores a JSON-encoded
// PreventSleepPolicy ({ mode, auto_conditions }) so the saved choice can be
// re-applied on the next launch, not just held in memory for the session.
export const RUNTIME_PREVENT_SLEEP_KEY = "runtime.preventSleep";

export const APP_VALUE_KEYS = {
  theme: "penguin-theme",
  themeDefaultOnboarded: "penguin-theme-default-onboarded",
  tutorialSeen: "penguin-tutorial-seen",
  userName: "penguin-username",
  tabs: "penguin-tabs",
  activeTab: "penguin-active-tab",
  history: "penguin-history",
  maxHistory: "penguin-max-history",
  savedRequests: "penguin-saved-requests",
  defaultHeaders: "penguin-default-headers",
  remoteConfigCache: "penguin-remote-config-cache",
  remoteConfigLastPulledAt: "penguin-remote-config-last-pulled-at",
  remoteConfigSource: "penguin-remote-config-source",
  updateLastCheckedAt: "penguin-update-last-checked-at",
  updateDismissedVersion: "penguin-update-dismissed-version",
  releaseWelcomeSeenVersion: "penguin-release-welcome-seen-version",
  // Auto-update preference — user opts IN (default false). When false, the
  // scheduler skips its startup + interval + focus checks. The Settings
  // "Check for Updates" button still works manually regardless.
  autoCheckForUpdates: "penguin-auto-check-for-updates",
  // Installer registry auto-refresh toggle (admin/super-admin only). Persisted
  // so the green toggle survives closing/reopening the installer, and so the
  // app-level poller keeps the registry cache warm in the background while the
  // installer is closed. Strictly gated to a valid dev token at run time.
  installerAutoRefresh: "penguin-installer-auto-refresh",
  // Wiki's "Indexed repositories" auto-refresh toggle (superadmin only, same
  // gating as installerAutoRefresh). Persisted so the toggle — and the
  // interval it drives — survives a webview reload instead of silently
  // reverting to off, matching the installer's precedent above.
  wikiAutoRefresh: "penguin-wiki-auto-refresh",
  // Wiki search-page preferences — SQLite-backed like the rest so product
  // code never touches window.localStorage directly (see product-shell guard).
  wikiPinnedSavedQueries: "penguin-wiki-pinned-saved-queries",
  wikiPreviewLines: "penguin-wiki-preview-lines",
  wikiRecentQueries: "penguin-wiki-recent-queries",
  devModeEnabled: "penguin-dev-mode-enabled",
  devModeToken: "penguin-dev-mode-token",
  devModeAdminToken: "penguin-dev-mode-admin-token",
  devModeSuperAdminToken: "penguin-dev-mode-super-admin-token",
  vaultData: "penguin-vault-data",
  vaultLarkUrl: "penguin-vault-lark-url",
  vaultLastSyncedAt: "penguin-vault-last-synced-at",
  vaultLarkUrlLocked: "penguin-vault-lark-url-locked",
  vaultLastSyncedHash: "penguin-vault-last-synced-hash",
  vaultLastSyncedContentHash: "penguin-vault-last-synced-content-hash",
  vaultSchemaVersion: "penguin-vault-schema-version",
  docsLarkUrl: "penguin-docs-lark-url",
  docsKnowledgeBase: "penguin-docs-knowledge-base",
  docsLastSyncedAt: "penguin-docs-last-synced-at",
  docsLastSyncedHash: "penguin-docs-last-synced-hash",
  // Survives Penguin main-webview reloads — e.g. user right-clicks the
  // page and picks "Reload" from the OS context menu. Without this
  // the active module resets to "client" because every module-open
  // flag is just a `useState(false)`.
  activeModule: "penguin-active-module",
  // Last time the user opened the error-log dialog. Used to count
  // "unread" entries (errors with timestamp > this value) for the
  // StatusBar badge.
  errorLogLastSeenAt: "penguin-error-log-last-seen-at",
  // Live Wallpaper submodule (Extras) — whether the macOS wallpaper window is
  // enabled. Persisted so it re-applies on next launch. Value: "true"/"false".
  wallpaperEnabled: "penguin-wallpaper-enabled",
} as const;

export const ENVIRONMENT_VALUE_KEYS: Record<PersistedProtocol, string> = {
  "grpc-web": "penguin-grpc-web-environments",
  grpc: "penguin-grpc-environments",
  sdk: "penguin-sdk-environments",
  rest: "penguin-rest-environments",
};

export const ACTIVE_ENV_VALUE_KEYS: Record<PersistedProtocol, string> = {
  "grpc-web": "penguin-grpc-web-active-env",
  grpc: "penguin-grpc-active-env",
  sdk: "penguin-sdk-active-env",
  rest: "penguin-rest-active-env",
};

export const LEGACY_BROWSER_STORAGE_KEYS = [
  ...Object.values(APP_VALUE_KEYS),
  ...Object.values(ENVIRONMENT_VALUE_KEYS),
  ...Object.values(ACTIVE_ENV_VALUE_KEYS),
];
