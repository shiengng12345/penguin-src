export type PersistedProtocol = "grpc-web" | "grpc" | "sdk" | "rest";

export const APP_VALUE_KEYS = {
  theme: "penguin-theme",
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
  // Auto-update preference — user opts IN (default false). When false, the
  // scheduler skips its startup + interval + focus checks. The Settings
  // "Check for Updates" button still works manually regardless.
  autoCheckForUpdates: "penguin-auto-check-for-updates",
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
  // In-app Browser module — pinned shortcuts list. Cookies / sessions
  // persist independently via Tauri's WKWebSiteDataStore; this key
  // just holds the user's curated URL set.
  browserShortcuts: "penguin-browser-shortcuts",
  // Per-shortcut "click Sign in after prefill" opt-in. Stored as a
  // Record<shortcutId, true>. Off by default — auto-submit can burn a
  // failed-login attempt and trip lockout policies.
  browserAutoSubmit: "penguin-browser-auto-submit",
  // Master kill-switch for auto-submit. Even when a shortcut has the
  // per-shortcut ⚡ enabled, prefill scripts will NOT click submit if
  // this is "false". On by default; users flip off when they're about
  // to debug a sign-in flow or want manual control session-wide.
  browserAutoSubmitGlobal: "penguin-browser-auto-submit-global",
  // Survives Penguin main-webview reloads — e.g. user right-clicks the
  // page and picks "Reload" from the OS context menu. Without this
  // the active module resets to "client" because every module-open
  // flag is just a `useState(false)`.
  activeModule: "penguin-active-module",
  // Last time the user opened the error-log dialog. Used to count
  // "unread" entries (errors with timestamp > this value) for the
  // StatusBar badge.
  errorLogLastSeenAt: "penguin-error-log-last-seen-at",
  // Currently-selected Browser top-bar tab ("vault" | "argocd" | "jenkins").
  // Persists across reloads so the user lands on the same view they
  // left.
  browserActiveTab: "penguin-browser-active-tab",
  // Jenkins tab's independent CRUD store. JSON shape:
  //   { accounts: JenkinsAccount[], links: JenkinsLink[] }
  // Lives outside Vault on purpose — Jenkins bookmarks + account creds
  // don't fit Vault's project/env model and the user wanted to manage
  // them in-place inside the Jenkins tab.
  jenkinsData: "penguin-jenkins-data",
  // Browser sidebar "pinned-expanded" preference. When true the sidebar
  // stays at full width even without hover; when false it auto-collapses.
  browserSidebarPinned: "penguin-browser-sidebar-pinned",
  // Browser embedded-page zoom. Native child webviews default to full
  // page scale, which makes dense admin tools feel oversized inside
  // Penguin's narrower shell.
  browserZoomScale: "penguin-browser-zoom-scale",
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
