import type { VaultProject } from "@/components/vault/types";
import type {
  ProtoService as CoreProtoService,
  ProtoMethod as CoreProtoMethod,
  FieldInfo as CoreFieldInfo,
  MetadataEntry as CoreMetadataEntry,
  ResponseState as CoreResponseState,
} from "@penguin/core";
import type { AppTheme } from "./theme";
import type { RestBodyMode, RestMethod } from "./rest";
import type { RestResponse } from "@/components/rest/rest-types";

// --- Types ---

// Re-export protocol-agnostic types from @penguin/core. Kept as named exports
// here (and re-exported from ./store) so existing call sites
// (`import { ResponseState } from "./store"`) keep working unchanged after the
// core extraction.
export type ProtoService = CoreProtoService;
export type ProtoMethod = CoreProtoMethod;
export type FieldInfo = CoreFieldInfo;
export type MetadataEntry = CoreMetadataEntry;
export type ResponseState = CoreResponseState;

export interface RestWorkspaceState {
  selectedProjectId: string | null;
  selectedEnvId: string | null;
  openTabIds: string[];
  activeTabId: string | null;
  // The collection the user last opened a request under or clicked in
  // the sidebar — used as the New Request dialog's default picker.
  lastCollectionId: string | null;
}

// One entry in the Browser module's left rail. Persists across restart
// (URL + label + optional baseKind icon + optional prefillToken for
// auto-fill). The actual auth cookies persist independently via Tauri's
// WKWebSiteDataStore — this slice just holds the user's pinned set.
export interface BrowserShortcut {
  id: string;
  label: string;
  url: string;
  // For Vault baseKind: token-string used by the prefill-injection
  // script the first time a shortcut is opened. Re-injection on reload
  // also uses this. Stored alongside other secrets — the user's vault
  // is already on local disk, so this isn't a new exposure surface.
  prefillToken?: string;
  // For Argo baseKind: username + password parsed from the paired
  // "login" credential's value (`username||password` delimited or
  // a JSON object). Same locality + sensitivity story as prefillToken.
  prefillUsername?: string;
  prefillPassword?: string;
  // Optional icon hint — mirrors VaultBuiltinKindId so the rail can
  // show the vault / argocd / web brand icon. "web" or undefined gets
  // the generic globe.
  baseKind?: string;
  // Origin context — Vault deeplinks carry the project + env they
  // came from so the Browser sidebar can group shortcuts by
  // {project, env}. Both undefined for shortcuts the user paste-added
  // manually (rendered under an "Unscoped" group).
  projectId?: string;
  envId?: string;
  // Set when this shortcut is a duplicate ("branch") of another. The
  // parent id is always a top-level shortcut id (duplicates of
  // duplicates collapse to the same parent — depth is capped at 1).
  // Branches inherit the parent's URL + baseKind + prefill data at
  // creation time but get their OWN unique WKWebView with an isolated
  // data directory so cookies / storage don't bleed between them.
  parentId?: string;
  // Persistent data-store key override. Defaults to parentId ?? id at
  // render time. Jenkins virtual shortcuts override this to
  // "jenkins-acc-<id>" so all links bound to the same account share login.
  dataKey?: string;
  createdAt: number;
}

// One-shot deeplink set by the Vault module (or anywhere else),
// consumed by BrowserPage on its next render. After consumption the
// requester is cleared. Session-only.
export interface BrowserDeeplinkRequest {
  url: string;
  label: string;
  prefillToken?: string;
  prefillUsername?: string;
  prefillPassword?: string;
  baseKind?: string;
  projectId?: string;
  envId?: string;
}

export interface BrowserState {
  shortcuts: BrowserShortcut[];
  activeShortcutId: string | null;
  pendingDeeplink: BrowserDeeplinkRequest | null;
  // Per-shortcut opt-in: after a successful prefill, also click the
  // Sign in / Login button. Keyed by shortcut id (synthetic for
  // vault-derived virtual shortcuts, real for manually pasted /
  // promoted ones). Persisted under APP_VALUE_KEYS.browserAutoSubmit.
  autoSubmitByShortcutId: Record<string, boolean>;
  // Master switch — when false, no shortcut auto-submits regardless of
  // its per-shortcut flag. Default true; persisted under
  // APP_VALUE_KEYS.browserAutoSubmitGlobal.
  autoSubmitGlobalEnabled: boolean;
}

// --- Jenkins tab (independent from Vault) ---
//
// The Jenkins tab manages its own accounts + link bookmarks rather than
// mirroring Vault credentials. Each link binds to exactly one account;
// opening a link prefills the account's username + password (and uses
// its TOTP secret for 2FA via the existing auto-submit flow).

export interface JenkinsAccount {
  id: string;
  label: string;             // user-typed nickname, e.g. "shieng-prod"
  username: string;
  password: string;
  // Base32 TOTP secret for the account's 2FA. Optional — accounts
  // without 2FA leave this blank. When set, the Authenticator popover
  // surfaces it AND the sign-in auto-submit injects the current code
  // into the OTP field before clicking the submit button.
  totpSecret?: string;
  createdAt: number;
}

export interface JenkinsLink {
  id: string;
  label: string;
  url: string;
  accountId: string;
  createdAt: number;
}

export interface JenkinsState {
  accounts: JenkinsAccount[];
  links: JenkinsLink[];
}

export type RestResponseSubTab = "body" | "headers" | "cookies" | "tests";

export interface RestResponseSlot {
  response: RestResponse | null;
  sendError: string | null;
  sending: boolean;
  // Monotonic per-request version — handleSend captures this at start,
  // and the result setter only writes if its captured version still
  // matches. Lets a Cancel / new Send / module-switch-then-resend
  // discard the stale result that arrives later.
  sendVersion: number;
  subTab: RestResponseSubTab;
  showFullBody: boolean;
}

export interface EnvVariable {
  key: string;
  value: string;
}

export interface Environment {
  id: string;
  name: string;
  color: string;
  variables: EnvVariable[];
}

export const ENV_COLORS = [
  { id: "green", label: "Green", hex: "#22c55e" },
  { id: "blue", label: "Blue", hex: "#3b82f6" },
  { id: "amber", label: "Amber", hex: "#f59e0b" },
  { id: "red", label: "Red", hex: "#ef4444" },
  { id: "purple", label: "Purple", hex: "#a855f7" },
  { id: "cyan", label: "Cyan", hex: "#06b6d4" },
  { id: "pink", label: "Pink", hex: "#ec4899" },
  { id: "orange", label: "Orange", hex: "#f97316" },
] as const;

export interface InstalledPackage {
  name: string;
  version: string;
  protoFiles: string[];
  services: ProtoService[];
}

export interface HistoryEntry {
  id: string;
  timestamp: number;
  protocol: ProtocolTab;
  methodFullName: string;
  serviceName: string;
  packageName: string;
  url: string;
  metadata: MetadataEntry[];
  requestBody: string;
  restMethod?: RestMethod;
  restBodyMode?: RestBodyMode;
  selectedMethod?: ProtoMethod | null;
  // Full response archived after the request completes (v1.9+); older
  // migrated entries have no response.
  response?: ResponseState | null;
}

export interface SavedRequest {
  id: string;
  name: string;
  savedAt: number;
  protocol: ProtocolTab;
  methodFullName: string;
  serviceName: string;
  packageName: string;
  url: string;
  metadata: MetadataEntry[];
  requestBody: string;
  restMethod?: RestMethod;
  restBodyMode?: RestBodyMode;
  response: ResponseState | null;
  selectedMethod: ProtoMethod | null;
}

export type ProtocolTab = "grpc-web" | "grpc" | "sdk" | "rest";
export type VisibleProtocolTab = Exclude<ProtocolTab, "rest">;

export function visibleProtocolForTab(
  protocol: ProtocolTab | null | undefined,
): VisibleProtocolTab {
  return protocol === "grpc-web" || protocol === "grpc" || protocol === "sdk"
    ? protocol
    : "sdk";
}

export type TabOrigin = "history" | "saved" | null;

export interface RequestTab {
  id: string;
  protocolTab: ProtocolTab;
  targetUrl: string;
  pathOverride: string | null;
  restMethod: RestMethod;
  restBodyMode: RestBodyMode;
  requestBody: string;
  metadata: MetadataEntry[];
  selectedPackage: string | null;
  selectedService: string | null;
  selectedMethod: ProtoMethod | null;
  response: ResponseState | null;
  isLoading: boolean;
  origin: TabOrigin;
}

// --- App State ---

export interface AppState {
  tabs: RequestTab[];
  activeTabId: string | null;
  addTab: (protocol?: ProtocolTab) => RequestTab;
  removeTab: (id: string) => void;
  resetActiveTab: () => void;
  resetPackageTabs: () => void;
  sanitizeHiddenRestTabs: () => void;
  setActiveTab: (id: string | null) => void;
  updateActiveTab: (patch: Partial<RequestTab>) => void;

  grpcWebPackages: InstalledPackage[];
  grpcPackages: InstalledPackage[];
  sdkPackages: InstalledPackage[];
  setGrpcWebPackages: (pkgs: InstalledPackage[]) => void;
  setGrpcPackages: (pkgs: InstalledPackage[]) => void;
  setSdkPackages: (pkgs: InstalledPackage[]) => void;
  addGrpcWebPackage: (pkg: InstalledPackage) => void;
  addGrpcPackage: (pkg: InstalledPackage) => void;
  addSdkPackage: (pkg: InstalledPackage) => void;
  removeGrpcWebPackage: (name: string) => void;
  removeGrpcPackage: (name: string) => void;
  removeSdkPackage: (name: string) => void;

  // Set to true once syncAllProtocolEnvs() finishes its first run.
  // Used to guard the Send button so users can't fire a request before
  // {{URL}} and other config variables have landed in the store.
  configSynced: boolean;

  grpcWebEnvironments: Environment[];
  grpcEnvironments: Environment[];
  sdkEnvironments: Environment[];
  restEnvironments: Environment[];
  grpcWebActiveEnvId: string | null;
  grpcActiveEnvId: string | null;
  sdkActiveEnvId: string | null;
  restActiveEnvId: string | null;
  setGrpcWebEnvironments: (envs: Environment[]) => void;
  setGrpcEnvironments: (envs: Environment[]) => void;
  setSdkEnvironments: (envs: Environment[]) => void;
  setRestEnvironments: (envs: Environment[]) => void;
  setGrpcWebActiveEnvId: (id: string | null) => void;
  setGrpcActiveEnvId: (id: string | null) => void;
  setSdkActiveEnvId: (id: string | null) => void;
  setRestActiveEnvId: (id: string | null) => void;
  addGrpcWebEnvironment: (env: Environment) => void;
  addGrpcEnvironment: (env: Environment) => void;
  addSdkEnvironment: (env: Environment) => void;
  addRestEnvironment: (env: Environment) => void;
  updateGrpcWebEnvironment: (id: string, patch: Partial<Environment>) => void;
  updateGrpcEnvironment: (id: string, patch: Partial<Environment>) => void;
  updateSdkEnvironment: (id: string, patch: Partial<Environment>) => void;
  updateRestEnvironment: (id: string, patch: Partial<Environment>) => void;
  deleteGrpcWebEnvironment: (id: string) => void;
  deleteGrpcEnvironment: (id: string) => void;
  deleteSdkEnvironment: (id: string) => void;
  deleteRestEnvironment: (id: string) => void;

  // Session-only REST per-request response state.
  //
  // Why session-only (not persisted to app_kv): response bodies can be
  // 10-50 MB; persisting them would balloon ~/.penguin/penguin.sqlite3
  // and slow hydrate. The cookie / history records (small) are still
  // SQLite-backed; this slice is just the in-memory mirror that
  // survives RestRequestEditor unmount on module switch.
  //
  // Keyed by RestRequestRecord.id. sendVersion is the cancel token
  // (bumped per send so stale invoke results get discarded).
  restResponses: Record<string, RestResponseSlot>;
  setRestResponseResult: (id: string, version: number, response: RestResponse | null, error: string | null) => void;
  setRestSending: (id: string, sending: boolean) => void;
  bumpRestSendVersion: (id: string) => number;
  setRestResponseSubTab: (id: string, subTab: RestResponseSubTab) => void;
  setRestResponseShowFullBody: (id: string, showFull: boolean) => void;
  clearRestResponse: (id: string) => void;

  // Session-only REST workspace UI state. Lifted out of RestPage's
  // useState so it survives RestPage unmount on module switch — the
  // user's open tabs, active tab, sidebar project/env selection, and
  // last-collection-used (for the New Request dialog default) all
  // come back when they re-enter the REST module.
  //
  // NOT persisted to app_kv — they're per-session UI state. Restart =
  // fresh workspace. Could be promoted to persistence later if users
  // ask, but the immediate complaint was just module-switch loss.
  restWorkspace: RestWorkspaceState;
  setRestWorkspace: (patch: Partial<RestWorkspaceState>) => void;

  // In-app Browser module. Pinned shortcuts live here; the active
  // shortcut + any cross-module deeplink request also live here so the
  // BrowserPage can survive its own remount on module switch.
  // - `shortcuts` IS persisted to app_kv (cookies for those URLs already
  //   persist via Tauri's WKWebSiteDataStore; persisting the URL list
  //   itself keeps the user's pinned set across restart).
  // - `activeShortcutId` + `deeplinkRequest` are session-only.
  browser: BrowserState;
  addOrPromoteBrowserShortcut: (shortcut: Omit<BrowserShortcut, "id" | "createdAt">) => string;
  // Always-creates clone of an existing shortcut. The branch gets a
  // new id, parentId set to the source's top-level ancestor, and an
  // auto-suffixed label (e.g. "QAT" → "QAT (2)"). Returns the new id;
  // returns null if `source` is null (caller passes the resolved
  // shortcut to keep this action ignorant of vault-derived lookup).
  duplicateBrowserShortcut: (source: BrowserShortcut) => string;
  removeBrowserShortcut: (id: string) => void;
  renameBrowserShortcut: (id: string, label: string) => void;
  reorderBrowserShortcuts: (orderedIds: string[]) => void;
  setActiveBrowserShortcut: (id: string | null) => void;
  requestBrowserDeeplink: (request: BrowserDeeplinkRequest) => void;
  consumeBrowserDeeplink: () => BrowserDeeplinkRequest | null;
  setBrowserShortcutAutoSubmit: (id: string, enabled: boolean) => void;
  setBrowserAutoSubmitGlobal: (enabled: boolean) => void;

  // -- Jenkins tab CRUD (independent store) --
  jenkins: JenkinsState;
  addJenkinsAccount: (payload: Omit<JenkinsAccount, "id" | "createdAt">) => string;
  updateJenkinsAccount: (id: string, patch: Partial<Omit<JenkinsAccount, "id" | "createdAt">>) => void;
  removeJenkinsAccount: (id: string) => void;
  addJenkinsLink: (payload: Omit<JenkinsLink, "id" | "createdAt">) => string;
  updateJenkinsLink: (id: string, patch: Partial<Omit<JenkinsLink, "id" | "createdAt">>) => void;
  removeJenkinsLink: (id: string) => void;

  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;

  isInstallerOpen: boolean;
  setInstallerOpen: (open: boolean) => void;
  installerPrefill: string;
  setInstallerPrefill: (value: string) => void;
  // Registry auto-refresh preference (admin/super-admin only). Shared between
  // the installer toggle and the app-level background poller.
  installerAutoRefresh: boolean;
  setInstallerAutoRefresh: (value: boolean) => void;
  installLog: string[];
  addInstallLog: (line: string) => void;
  clearInstallLog: () => void;

  searchPrefill: string;
  setSearchPrefill: (value: string) => void;

  showTutorial: boolean;
  setShowTutorial: (show: boolean) => void;

  userName: string;
  setUserName: (name: string) => void;

  // Developer Mode — see useDeveloperMode() contract
  devModeEnabled: boolean;
  setDevModeEnabled: (value: boolean) => void;
  hasValidToken: boolean;
  setHasValidToken: (value: boolean) => void;
  // Sprint 3 — superadmin tier. NOT persisted; always recomputed at boot via
  // initializeDevModeOnAppStart after the in-memory token is loaded.
  isSuperAdmin: boolean;
  setIsSuperAdmin: (value: boolean) => void;
  // Set to true once `initializeDevModeOnAppStart` finishes (token load
  // resolved OR dev mode was off). Consumers that gate UI on
  // hasValidToken / isSuperAdmin must wait for this — otherwise the
  // window between mount and token-load looks identical to "user has no
  // access", and kick-out effects fire on a still-loading state.
  devModeHydrated: boolean;
  setDevModeHydrated: (value: boolean) => void;

  // Vault — projects state owned here, loaded/persisted via vault-storage.ts
  vaultProjects: VaultProject[];
  setVaultProjects: (projects: VaultProject[]) => void;
  vaultLarkUrl: string | null;
  setVaultLarkUrl: (url: string | null) => void;
  vaultLastSyncedAt: number | null;
  setVaultLastSyncedAt: (timestamp: number | null) => void;
  // Sprint 3 — dirty flag for local CRUD edits. NOT persisted: every cold
  // boot starts clean because either Sync or Push must reconcile against Lark.
  vaultIsDirty: boolean;
  setVaultIsDirty: (value: boolean) => void;
  // Session-only UI selection — keeps the user's spot in the Vault
  // module across module switches (when VaultPage unmounts and remounts
  // its local useState would otherwise reset to the first project +
  // default env). Not persisted to disk; a fresh app boot resets.
  vaultSelectedProjectId: string | null;
  setVaultSelectedProjectId: (id: string | null) => void;
  vaultSelectedEnvId: string;
  setVaultSelectedEnvId: (id: string) => void;
  // Paginated window over the request_history table — NOT the full archive.
  history: HistoryEntry[];
  historyTotal: number;
  addHistory: (entry: HistoryEntry) => void;
  attachHistoryResponse: (id: string, response: ResponseState) => void;
  loadMoreHistory: () => Promise<void>;
  clearHistory: () => void;

  savedRequests: SavedRequest[];
  saveRequest: (entry: SavedRequest) => void;
  deleteSavedRequest: (id: string) => void;
  renameSavedRequest: (id: string, name: string) => void;

  maxHistorySize: number;
  setMaxHistorySize: (size: number) => void;

  defaultHeaders: Record<ProtocolTab, MetadataEntry[]>;
  setDefaultHeaders: (protocol: ProtocolTab, headers: MetadataEntry[]) => void;
}
