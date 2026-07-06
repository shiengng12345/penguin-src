// Sprint 10 Phase 10A — REST module source-assertion tests (T10A.6).
//
// Validates that the module structure agreed in DEC #193-204 actually exists
// in the codebase. Catches regressions if anyone deletes files or removes the
// 3-column layout / 5 Tauri commands / 4-table schema / sidebar icon.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function loadSource(relPath) {
  return readFile(new URL(relPath, import.meta.url), "utf8");
}

test("REST backend module — 3 Rust files exist with expected exports", async () => {
  const modRs = await loadSource("../src-tauri/src/rest/mod.rs");
  // Types declared in mod.rs.
  assert.match(modRs, /pub struct RestRequest\b/);
  assert.match(modRs, /pub struct RestResponse\b/);
  assert.match(modRs, /pub struct SecretRef\b/);
  assert.match(modRs, /pub struct SecretHandle\b/);
  assert.match(modRs, /pub struct RestCookie\b/);
  assert.match(modRs, /pub enum RestBody\b/);
  // Submodules declared.
  assert.match(modRs, /pub mod commands;/);
  assert.match(modRs, /pub mod keychain;/);

  const commandsRs = await loadSource("../src-tauri/src/rest/commands.rs");
  assert.match(commandsRs, /pub async fn rest_send_request\(/);
  assert.match(commandsRs, /pub async fn rest_save_secret\(/);
  assert.match(commandsRs, /pub async fn rest_resolve_secret_masked\(/);
  assert.match(commandsRs, /pub async fn rest_get_cookies\(/);
  assert.match(commandsRs, /pub async fn rest_clear_cookies\(/);

  const keychainRs = await loadSource("../src-tauri/src/rest/keychain.rs");
  assert.match(keychainRs, /pub trait KeychainAdapter\b/);
  assert.match(keychainRs, /pub struct MockKeychain\b/);
  assert.match(keychainRs, /pub fn active_adapter\(\)/);
});

test("REST backend — Tauri commands registered in lib.rs", async () => {
  const lib = await loadSource("../src-tauri/src/lib.rs");
  assert.match(lib, /mod rest;/);
  assert.match(lib, /rest::commands::rest_send_request/);
  assert.match(lib, /rest::commands::rest_save_secret/);
  assert.match(lib, /rest::commands::rest_resolve_secret_masked/);
  assert.match(lib, /rest::commands::rest_get_cookies/);
  assert.match(lib, /rest::commands::rest_clear_cookies/);
});

test("REST backend — 4 SQLite tables in db.rs migrations (DEC #196)", async () => {
  const db = await loadSource("../src-tauri/src/db.rs");
  assert.match(db, /CREATE TABLE IF NOT EXISTS rest_collections/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS rest_requests/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS rest_env_vars/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS rest_cookies/);
  // parent_id nullable for future folder nesting (DEC #196).
  assert.match(db, /rest_collections[\s\S]*?parent_id TEXT,/);
});

test("REST FE module — files exist with expected exports", async () => {
  const types = await loadSource("../src/components/rest/rest-types.ts");
  assert.match(types, /export interface RestRequest\b/);
  assert.match(types, /export interface RestResponse\b/);
  assert.match(types, /export interface SecretRef\b/);
  assert.match(types, /export interface SecretHandle\b/);
  assert.match(types, /export interface RestCollection\b/);
  assert.match(types, /export interface RestRequestRecord\b/);

  const storage = await loadSource("../src/components/rest/rest-storage.ts");
  assert.match(storage, /export function loadProjects\(/);
  assert.match(storage, /export function createCollection\(/);
  assert.match(storage, /export function upsertRequest\(/);
  assert.match(storage, /export function getMigrationVersion\(/);

  const keychain = await loadSource("../src/components/rest/rest-keychain.ts");
  assert.match(keychain, /export async function saveSecret\(/);
  assert.match(keychain, /export async function resolveSecretMasked\(/);
  // DEC #195 was relaxed per user request: the Authorization tab now
  // resolves plaintext for inline display + editing. Keychain still
  // owns canonical storage; IPC is process-local so plaintext doesn't
  // leave the machine. See rest_resolve_secret_plain on the Rust side.
  assert.match(keychain, /export async function resolveSecretPlain\(/);
  assert.match(keychain, /export async function getCookies\(/);

  const page = await loadSource("../src/components/rest/RestPage.tsx");
  assert.match(page, /export function RestPage\(/);
  // Simplified layout: RestSidebar + RestRequestEditor (no multi-tab workspace).
  assert.match(page, /RestSidebar/);
  assert.doesNotMatch(page, /RestWorkspaceTabs/);
  assert.match(page, /RestRequestEditor/);

  await loadSource("../src/components/rest/RestSidebar.tsx");
  await loadSource("../src/components/rest/RestCollectionsTree.tsx");
  await loadSource("../src/components/rest/RestWorkspaceTabs.tsx");
  await loadSource("../src/components/rest/RestRequestEditor.tsx");

  // Sidebar must have inline CRUD for projects + envs (DEC #185 + user feedback 10A.8).
  const sidebar = await loadSource("../src/components/rest/RestSidebar.tsx");
  assert.match(sidebar, /onNewProject/);
  assert.match(sidebar, /onRenameProject/);
  assert.match(sidebar, /onDeleteProject/);
  assert.match(sidebar, /onNewEnvironment/);
  assert.match(sidebar, /onRenameEnvironment/);
  assert.match(sidebar, /onDeleteEnvironment/);
});

test("RestRequestEditor uses client-module-style section layout (Headers + Body)", async () => {
  // Simplified layout — matching gRPC client RequestPanel.
  // Sections: Headers (compact table) + Body (JsonEditor, JSON only).
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  assert.match(editor, /Headers/);
  assert.match(editor, /handleAddHeader/);
  assert.match(editor, /handleRemoveHeader/);
  assert.match(editor, /Body/);
  assert.match(editor, /handleFormatBody/);
  assert.match(editor, /JsonEditor/);
  // No tab strip, no toggle buttons.
  assert.doesNotMatch(editor, /REQUEST_TABS/);
  assert.doesNotMatch(editor, /BODY_MODES/);
  assert.doesNotMatch(editor, /handleBodyMode/);
  assert.doesNotMatch(editor, /bodyMode/);
  assert.match(editor, /METHOD_OPTIONS/);
  assert.match(editor, /Send/);
  assert.match(editor, /ResponseEmptyState/);
});

test("RestRequestEditor — request/response split is fixed 50/50, NOT draggable", async () => {
  // Per user direction: requestBody and responseBody can't change
  // ratio/size. The old ResizablePanels (with drag handle + app_kv
  // persistence) is gone in this layout; both panes use w-1/2 instead.
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  assert.doesNotMatch(editor, /ResizablePanels/);
  assert.doesNotMatch(editor, /penguin-rest-editor-split-ratio/);
  // Both panes hardcoded to half-width. Token-set check tolerates
  // class reorder; an additional marker (border-r for left, bg-card
  // for right) distinguishes the two panes from each other.
  const classes = [...editor.matchAll(/className="([^"]+)"/g)].map((m) => m[1]);
  const leftPane = classes.find((cn) => {
    const toks = cn.split(/\s+/);
    return ["flex", "w-1/2", "min-h-0", "min-w-0", "flex-col"].every((t) => toks.includes(t))
      && toks.includes("border-r");
  });
  const rightPane = classes.find((cn) => {
    const toks = cn.split(/\s+/);
    return ["flex", "w-1/2", "min-h-0", "min-w-0", "flex-col"].every((t) => toks.includes(t))
      && /bg-card\/10/.test(cn);
  });
  assert.ok(leftPane, "left pane (w-1/2 + border-r) not found");
  assert.ok(rightPane, "right pane (w-1/2 + bg-card/10) not found");
});

test("RestWorkspaceTabs supports multi-tab open/close", async () => {
  const tabs = await loadSource("../src/components/rest/RestWorkspaceTabs.tsx");
  assert.match(tabs, /export function RestWorkspaceTabs/);
  // Prop signature — locks the callback shapes and active-id type so a
  // refactor that drops the id arg (or makes active a different
  // identifier) fails this test.
  assert.match(tabs, /onClose:\s*\(id:\s*string\)\s*=>\s*void/);
  assert.match(tabs, /onSelect:\s*\(id:\s*string\)\s*=>\s*void/);
  assert.match(tabs, /activeTabId:\s*string\s*\|\s*null/);
  // Wiring — onSelect fires from the tab body click, onClose fires
  // from a separate inner element (with stopPropagation so it doesn't
  // also trigger select). Catches accidental removal of the X.
  assert.match(tabs, /onClick=\{\(\) => onSelect\(tab\.id\)\}/);
  assert.match(tabs, /e\.stopPropagation\(\)/);
  assert.match(tabs, /onClose\(tab\.id\)/);
  assert.match(tabs, /title="Close tab"/);
});

test("REST FE — RestRequestEditor wires Send button to Tauri command", async () => {
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  assert.match(editor, /invoke<RestResponse>\("rest_send_request"/);
  // Send button + sending state.
  assert.match(editor, /onClick=\{handleSend\}/);
  assert.match(editor, /Sending/);
});

test("MainSidebar — REST open to all users (requires: \"none\")", async () => {
  const sidebar = await loadSource("../src/components/layout/MainSidebar.tsx");
  // MainModule type union still includes "rest".
  assert.match(sidebar, /"client"\s*\|\s*"rest"\s*\|\s*"vault"\s*\|\s*"docs"/);
  // Item entry: REST now requires: "none" (open to all).
  // source: { kind: "rest", ... requires: "none" }
  assert.match(sidebar, /kind:\s*"rest"[\s\S]*?requires:\s*"none"/);
  assert.match(sidebar, /import\s+{[^}]*\bGlobe\b[^}]*}\s+from\s+"lucide-react"/);
  // Anti-regression: REST's own requires field must NOT be token or super-admin.
  // Match the full REST entry without crossing to the next kind: line.
  assert.doesNotMatch(sidebar, /kind:\s*"rest",[^}]*?requires:\s*"token"/);
  assert.doesNotMatch(sidebar, /kind:\s*"rest",[^}]*?requires:\s*"super-admin"/);
});

test("App.tsx — REST module routed + open to all users (no token required)", async () => {
  const app = await loadSource("../src/App.tsx");
  // restOpen state.
  assert.match(app, /\[restOpen,\s*setRestOpen\]/);
  // canAccessRest is now always true — REST open to everyone.
  assert.match(app, /canAccessRest\s*=\s*true/);
  // Routed RestPage.
  assert.match(app, /restOpen\s*\?\s*\(\s*<RestPage/);
  // Active module enum includes "rest".
  assert.match(app, /restOpen[\s\S]*?\?\s*"rest"/);
});

test("MainSidebar props — REST open to all, Docs/Database/Browser still super-admin", async () => {
  // REST is now open to all (requires: "none"). isSuperAdmin still gates Docs/Database/Browser.
  const app = await loadSource("../src/App.tsx");
  assert.match(app, /hasValidToken=\{canAccessVault\}/);
  assert.match(app, /isSuperAdmin=\{canAccessDocs\s*\|\|\s*canAccessDatabase\s*\|\|\s*canAccessBrowser\}/);
});

test("REST module — context-aware keyboard shortcuts wired (shortcut audit fix)", async () => {
  // 1. Event-name constants file exists with the 6 shortcut events.
  const events = await loadSource("../src/lib/rest-events.ts");
  for (const name of [
    "REST_NEW_REQUEST_EVENT",
    "REST_CLOSE_TAB_EVENT",
    "REST_SEND_REQUEST_EVENT",
    "REST_SAVE_REQUEST_EVENT",
    "REST_FOCUS_SEARCH_EVENT",
    "REST_FOCUS_URL_EVENT",
  ]) {
    assert.match(events, new RegExp(`export const ${name}`));
  }

  // 2. App.tsx dispatcher is module-aware — gates Cmd+N / Cmd+W / Cmd+Enter /
  //    Cmd+S / Cmd+F on activeModule and dispatches REST_* events for rest.
  const app = await loadSource("../src/App.tsx");
  assert.match(app, /const isRest = activeModule === "rest"/);
  assert.match(app, /const isClient = activeModule === "client"/);
  assert.match(app, /REST_NEW_REQUEST_EVENT/);
  assert.match(app, /REST_CLOSE_TAB_EVENT/);
  assert.match(app, /REST_SEND_REQUEST_EVENT/);
  assert.match(app, /REST_SAVE_REQUEST_EVENT/);
  assert.match(app, /REST_FOCUS_SEARCH_EVENT/);
  assert.match(app, /REST_FOCUS_URL_EVENT/);
  // Cmd+T is the new REST alias of Cmd+N.
  assert.match(app, /case "t":[\s\S]*?REST_NEW_REQUEST_EVENT/);

  // 3. RestPage listens for new-request / close-tab / focus-search.
  const page = await loadSource("../src/components/rest/RestPage.tsx");
  assert.match(page, /addEventListener\(REST_NEW_REQUEST_EVENT/);
  assert.match(page, /addEventListener\(REST_CLOSE_TAB_EVENT/);
  assert.match(page, /addEventListener\(REST_FOCUS_SEARCH_EVENT/);

  // 4. RestRequestEditor listens for send / save / focus-url + has URL ref +
  //    Enter-in-URL-bar shortcut.
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  assert.match(editor, /addEventListener\(REST_SEND_REQUEST_EVENT/);
  assert.match(editor, /addEventListener\(REST_SAVE_REQUEST_EVENT/);
  assert.match(editor, /addEventListener\(REST_FOCUS_URL_EVENT/);
  assert.match(editor, /urlInputRef/);
  // Enter inside URL bar triggers send.
  assert.match(editor, /e\.key === "Enter"[\s\S]*?handleSend\(\)/);

  // 5. RestSidebar accepts a searchInputRef forwarded to the search Input.
  const sidebar = await loadSource("../src/components/rest/RestSidebar.tsx");
  assert.match(sidebar, /searchInputRef\?:/);
  assert.match(sidebar, /ref=\{props\.searchInputRef\}/);

  // 6. Cheat sheet is module-aware — REST users see REST shortcuts, not gRPC.
  const cheat = await loadSource("../src/components/shortcuts/ShortcutCheatSheet.tsx");
  assert.match(cheat, /REST_SHORTCUTS/);
  assert.match(cheat, /CLIENT_SHORTCUTS/);
  assert.match(cheat, /activeModule\?: MainModule/);
});

test("REST storage — keys mirror Pengvi persistence-keys naming convention", async () => {
  const storage = await loadSource("../src/components/rest/rest-storage.ts");
  // Keys use "penguin-rest-*" namespace.
  assert.match(storage, /"penguin-rest-projects"/);
  assert.match(storage, /"penguin-rest-environments"/);
  assert.match(storage, /"penguin-rest-collections"/);
  assert.match(storage, /"penguin-rest-requests"/);
  assert.match(storage, /"penguin-rest-env-vars"/);
  // Migration version key (DEC #198).
  assert.match(storage, /"penguin-rest-migration-version"/);
});

test("rest-events.ts — exact event string constants (silent-break guard)", async () => {
  // Existing assertions only verify the constant names are exported. If the
  // string value drifts, dispatcher (App.tsx) and listeners (RestPage,
  // RestRequestEditor) silently desync and shortcuts break with no error.
  const events = await loadSource("../src/lib/rest-events.ts");
  assert.match(events, /export const REST_NEW_REQUEST_EVENT\s*=\s*"penguin:rest-new-request"/);
  assert.match(events, /export const REST_CLOSE_TAB_EVENT\s*=\s*"penguin:rest-close-tab"/);
  assert.match(events, /export const REST_SEND_REQUEST_EVENT\s*=\s*"penguin:rest-send-request"/);
  assert.match(events, /export const REST_SAVE_REQUEST_EVENT\s*=\s*"penguin:rest-save-request"/);
  assert.match(events, /export const REST_FOCUS_SEARCH_EVENT\s*=\s*"penguin:rest-focus-search"/);
  assert.match(events, /export const REST_FOCUS_URL_EVENT\s*=\s*"penguin:rest-focus-url"/);
});

test("App.tsx — shortcut cases branch by module (isClient vs isRest)", async () => {
  // Locks the per-case module branching so removing a guard surfaces in CI
  // instead of as a silent UX regression (e.g. Cmd+F opening gRPC search in
  // REST mode, Cmd+R reloading the webview, Cmd+S installing a gRPC pkg).
  const app = await loadSource("../src/App.tsx");
  // Cmd+F: gRPC opens CommandSearch; REST dispatches focus-search event.
  assert.match(
    app,
    /case "f":[\s\S]{0,400}?if \(isClient\)[\s\S]{0,200}?setSearchOpen[\s\S]{0,200}?else if \(isRest\)[\s\S]{0,200}?REST_FOCUS_SEARCH_EVENT/,
  );
  // Cmd+N: gRPC opens NewRequestDialog; REST dispatches new-request event.
  assert.match(
    app,
    /case "n":[\s\S]{0,400}?if \(isClient\)[\s\S]{0,200}?setNewRequestOpen\(true\)[\s\S]{0,200}?else if \(isRest\)[\s\S]{0,200}?REST_NEW_REQUEST_EVENT/,
  );
  // Cmd+W: REST dispatches close-tab event inside the isRest branch.
  assert.match(
    app,
    /case "w":[\s\S]{0,500}?else if \(isRest\)[\s\S]{0,200}?REST_CLOSE_TAB_EVENT/,
  );
  // Cmd+R: REST/Vault/Docs all guard with !isClient + preventDefault to stop
  // the Tauri webview from reloading and destroying unsaved state.
  assert.match(
    app,
    /case "r":[\s\S]{0,300}?if \(!isClient\)[\s\S]{0,200}?e\.preventDefault\(\)[\s\S]{0,100}?break;/,
  );
  // Cmd+S: REST dispatches save-request rather than opening gRPC pkg install.
  assert.match(
    app,
    /case "s":[\s\S]{0,400}?if \(isRest\)[\s\S]{0,200}?REST_SAVE_REQUEST_EVENT/,
  );
  // Cmd+Enter: REST dispatches send-request specifically inside isRest branch.
  assert.match(
    app,
    /case "enter":[\s\S]{0,500}?else if \(isRest\)[\s\S]{0,200}?REST_SEND_REQUEST_EVENT/,
  );
  // Cmd+L: REST-only shortcut, dispatches focus-url inside isRest branch.
  assert.match(
    app,
    /case "l":[\s\S]{0,300}?if \(isRest\)[\s\S]{0,200}?REST_FOCUS_URL_EVENT/,
  );
  // Cmd+T: REST-only alias of Cmd+N, guarded by isRest.
  assert.match(
    app,
    /case "t":[\s\S]{0,300}?if \(isRest\)[\s\S]{0,200}?REST_NEW_REQUEST_EVENT/,
  );
});

test("App.tsx — gRPC-only shortcuts are gated by isClient", async () => {
  // Cmd+E/H/O/D/P all open gRPC client UI and must not fire in REST/Vault/Docs.
  const app = await loadSource("../src/App.tsx");
  assert.match(app, /case "e":[\s\S]{0,200}?if \(isClient\)/);
  assert.match(app, /case "h":[\s\S]{0,200}?if \(isClient\)/);
  assert.match(app, /case "o":[\s\S]{0,200}?if \(isClient\)/);
  assert.match(app, /case "d":[\s\S]{0,200}?if \(isClient\)/);
  assert.match(app, /case "p":[\s\S]{0,200}?if \(isClient\)/);
});

test("App.tsx — keydown useEffect deps include activeModule", async () => {
  // If activeModule is missing from deps, isRest/isClient never re-evaluate
  // after module switching and shortcuts fire for the wrong module.
  // Asserts each dep INDIVIDUALLY — React treats dep arrays as an
  // unordered set, so locking the exact order is brittle.
  const app = await loadSource("../src/App.tsx");
  const depsMatch = app.match(/\},\s*\[([^\]]+)\]\);\s*\/\/[^\n]*keydown|\},\s*\[([^\]]*activeModule[^\]]*)\]\);/);
  assert.ok(depsMatch, "keydown useEffect dep array must include activeModule");
  const deps = (depsMatch[1] ?? depsMatch[2]) || "";
  assert.match(deps, /\bactiveModule\b/);
  assert.match(deps, /\bactiveTab\b/);
  assert.match(deps, /\bupdateActiveTab\b/);
});

test("App.tsx — renders ShortcutCheatSheet with activeModule prop", async () => {
  // Without this prop, the cheat sheet falls back to CLIENT_SHORTCUTS and REST
  // users never see REST-specific shortcut documentation.
  const app = await loadSource("../src/App.tsx");
  assert.match(app, /<ShortcutCheatSheet[\s\S]{0,300}?activeModule=\{activeModule\}/);
});

test("RestPage — ref + listener wiring for Cmd+F focus-search", async () => {
  const page = await loadSource("../src/components/rest/RestPage.tsx");
  // useRef declaration for the sidebar search input.
  assert.match(page, /const searchInputRef = useRef<HTMLInputElement \| null>\(null\)/);
  // Forwarded to RestSidebar so Cmd+F can focus it.
  assert.match(page, /searchInputRef=\{searchInputRef\}/);
});

test("RestRequestEditor — refs (url, request) + Save UX flash feedback", async () => {
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  // urlInputRef must be a real useRef hook so REST_FOCUS_URL_EVENT can focus it.
  assert.match(editor, /const urlInputRef = useRef<HTMLInputElement \| null>\(null\)/);
  // Ref must be bound to the Input element.
  assert.match(editor, /ref=\{urlInputRef\}/);
  // requestRef avoids stale closure inside document-level keydown listener.
  assert.match(editor, /const requestRef = useRef\(request\)/);
  // handleSend must read from the ref, not closure `request`.
  assert.match(editor, /const req = requestRef\.current/);
  // Save button visually toggles to "Saved" for 1200ms after Cmd+S.
  assert.match(editor, /savedFlash \? "Saved" : "Save"/);
  assert.match(editor, /setTimeout\([^,]+,\s*1200\)/);
});

test("RestSidebar — inline edit replaces window.prompt (Tauri webview blocks it)", async () => {
  const sidebar = await loadSource("../src/components/rest/RestSidebar.tsx");
  // Tauri 2 webview blocks window.prompt — using it makes + New * hang silently.
  // Strip line comments first so the doc comment explaining "we removed
  // window.prompt" doesn't trigger a false positive.
  const code = sidebar.replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /window\.prompt/);
  // InlineEditRow is the replacement pattern.
  assert.match(sidebar, /function InlineEditRow\(/);
});

test("RestSidebar — handler prop signatures take name string (locks inline-edit shape)", async () => {
  // Existing tests only assert the prop names exist. These lock the new
  // signatures so reverting to window.prompt-based () => void handlers fails.
  const sidebar = await loadSource("../src/components/rest/RestSidebar.tsx");
  assert.match(sidebar, /onNewProject:\s*\(name:\s*string\)\s*=>/);
  assert.match(sidebar, /onRenameProject:\s*\(id:\s*string,\s*name:\s*string\)\s*=>/);
  assert.match(sidebar, /onNewEnvironment:\s*\(name:\s*string\)\s*=>/);
  assert.match(sidebar, /onRenameEnvironment:\s*\(id:\s*string,\s*name:\s*string\)\s*=>/);
  assert.match(sidebar, /onNewCollection:\s*\(name:\s*string\)\s*=>/);
});

test("RestSidebar — InlineEditRow trims + truthy-checks before committing new name", async () => {
  // Without trim() leading/trailing whitespace persists; without the truthy
  // check, blank names create empty rows in the sidebar.
  const sidebar = await loadSource("../src/components/rest/RestSidebar.tsx");
  assert.match(sidebar, /if \(name\.trim\(\)\)\s*props\.onNewProject\(name\.trim\(\)\)/);
});

test("ShortcutCheatSheet — module-aware sections (UNIVERSAL + REST + CLIENT)", async () => {
  const cheat = await loadSource("../src/components/shortcuts/ShortcutCheatSheet.tsx");
  // MainModule type import locks the activeModule prop contract.
  assert.match(cheat, /import type \{[^}]*MainModule[^}]*\}/);
  // Three typed arrays must exist so the cheat sheet can compose its sections.
  assert.match(cheat, /const UNIVERSAL:\s*ShortcutCategory\[\]/);
  assert.match(cheat, /const REST_SHORTCUTS:\s*ShortcutCategory\[\]/);
  assert.match(cheat, /const CLIENT_SHORTCUTS:\s*ShortcutCategory\[\]/);
  // moduleSections switch routes "rest" → REST_SHORTCUTS (otherwise REST falls
  // through to gRPC defaults).
  assert.match(cheat, /case "rest":[\s\S]{0,200}?return REST_SHORTCUTS/);
  // Visible chip identifies which module's shortcuts are shown.
  assert.match(cheat, /activeModule &&/);
});

test("ShortcutCheatSheet — REST shortcut entries document Cmd+N cascade / Cmd+T alias / Cmd+L", async () => {
  // Locks human-readable copy so accidental edits to the help text are caught.
  const cheat = await loadSource("../src/components/shortcuts/ShortcutCheatSheet.tsx");
  assert.match(cheat, /New request \(cascade: project/);
  assert.match(cheat, /New request \(alias of/);
  assert.match(cheat, /Focus URL bar/);
});

test("RestPage — new-* handlers accept name string from inline edit", async () => {
  // Sidebar's InlineEditRow passes the trimmed name as an argument. Handler
  // signatures here must match or the inline-edit flow breaks at the call site.
  const page = await loadSource("../src/components/rest/RestPage.tsx");
  assert.match(page, /handleNewProject\s*=?\s*(?:async\s*)?\(name:\s*string\)/);
  assert.match(page, /handleNewEnvironment\s*=?\s*(?:async\s*)?\(name:\s*string\)/);
  assert.match(page, /handleNewCollection\s*=?\s*(?:async\s*)?\(name:\s*string\)/);
});

test("RestPage — no window.prompt usage (Tauri 2 webview blocks it)", async () => {
  // If the empty-state CTAs or any handler reintroduces window.prompt, the
  // Tauri webview swallows the call and the user sees no dialog.
  const page = await loadSource("../src/components/rest/RestPage.tsx");
  assert.doesNotMatch(page, /window\.prompt/);
});

test("RestNewRequestDialog — inline project create (no sidebar trip required)", async () => {
  // User feedback: "I cannot direct create here??" — dialog used to dead-end
  // when hasProject=false. It now exposes an inline project-create form that
  // cascades into collection-create after creation.
  const dialog = await loadSource("../src/components/rest/RestNewRequestDialog.tsx");
  assert.match(dialog, /onCreateProject:\s*\(name:\s*string\)\s*=>\s*void/);
  assert.match(dialog, /commitProject\s*=/);
  // The dead-end "Select or create a project in the sidebar first." text is
  // gone; replaced by the inline "Project name" input + Create button.
  assert.doesNotMatch(dialog, /Select or create a project in the sidebar first/);
  assert.match(dialog, /You don&apos;t have any projects yet/);

  // RestPage must supply the callback that flips selectedProjectId so the
  // dialog can re-render with hasProject=true and cascade into collection-create.
  const page = await loadSource("../src/components/rest/RestPage.tsx");
  assert.match(page, /handleCreateProjectFromDialog/);
  assert.match(page, /onCreateProject=\{handleCreateProjectFromDialog\}/);
  assert.match(page, /handleCreateProjectFromDialog[\s\S]{0,300}?setSelectedProjectId\(p\.id\)/);
});

test("RestNewRequestDialog — 7-verb method grid, prop contract, and capture-phase Esc handling", async () => {
  // The dialog is what ⌘N / ⌘T / header "+ New" open in REST mode now.
  // User chose the "Method 快速选择面板" UX: 7-button grid that creates the
  // tab on click, plus a collection picker with inline "+ New collection...".
  const dialog = await loadSource("../src/components/rest/RestNewRequestDialog.tsx");
  assert.match(dialog, /export function RestNewRequestDialog\(/);

  // 1. All 7 HTTP verbs the user listed must be present as METHODS entries.
  for (const verb of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    assert.match(dialog, new RegExp(`value:\\s*"${verb}"`));
  }

  // 2. Required prop contract — hasProject + collections + handlers.
  assert.match(dialog, /open:\s*boolean/);
  assert.match(dialog, /collections:\s*RestCollection\[\]/);
  assert.match(dialog, /hasProject:\s*boolean/);
  assert.match(dialog, /onCreate:\s*\(params:\s*\{\s*method:\s*RestMethod;\s*collectionId:\s*string\s*\}\)\s*=>\s*void/);
  assert.match(dialog, /onCreateCollection:\s*\(name:\s*string\)\s*=>\s*string/);

  // 3. Inline "+ New collection..." entry — sentinel value in the picker.
  assert.match(dialog, /CREATE_SENTINEL\s*=\s*"__create__"/);
  assert.match(dialog, /\+ New collection\.\.\./);

  // 4. Empty-project state now offers inline project-create instead of a
  //    dead-end hint (per user feedback "I cannot direct create here??").
  assert.match(dialog, /You don&apos;t have any projects yet/);

  // 5. Escape handler uses capture-phase + stopPropagation so it doesn't bubble
  //    up to RestPage's outer Escape (which would close the whole REST module).
  assert.match(dialog, /e\.key === "Escape"[\s\S]{0,200}?stopPropagation/);
  assert.match(dialog, /addEventListener\("keydown"[\s\S]{0,80}?,\s*true\s*\)/);
});

test("RestNewRequestDialog — method buttons gated on collection selection", async () => {
  // Without a collectionId, clicking a method must noop (we can't create an
  // orphan request — Pengvi requires collectionId). The disabled prop and
  // pickMethod's early return are both load-bearing.
  const dialog = await loadSource("../src/components/rest/RestNewRequestDialog.tsx");
  assert.match(dialog, /const methodsEnabled = props\.hasProject && !!collectionId/);
  assert.match(dialog, /if \(!collectionId\) return;/);
  assert.match(dialog, /disabled=\{!methodsEnabled\}/);
});

test("RestPage — ⌘N opens RestNewRequestDialog (no more silent auto-GET create)", async () => {
  // Previously handleNewFromHeader auto-created a "New Request" with default
  // GET method — user couldn't pick POST/PUT/etc. Now it opens the dialog.
  const page = await loadSource("../src/components/rest/RestPage.tsx");

  // Dialog is imported + rendered.
  assert.match(page, /import \{ RestNewRequestDialog \} from "\.\/RestNewRequestDialog"/);
  assert.match(page, /<RestNewRequestDialog/);

  // State + handlers wired.
  assert.match(page, /\[newRequestDialogOpen,\s*setNewRequestDialogOpen\]/);
  assert.match(page, /handleCreateFromDialog/);
  assert.match(page, /handleCreateCollectionFromDialog/);

  // handleNewFromHeader now opens dialog instead of cascading create.
  assert.match(page, /handleNewFromHeader[\s\S]{0,150}?setNewRequestDialogOpen\(true\)/);

  // Method chosen in dialog is applied via upsertRequest (createRequest
  // defaults to GET, so the patch step is what makes POST/PUT/etc. stick).
  assert.match(page, /handleCreateFromDialog[\s\S]{0,400}?upsertRequest\(/);
});

test("RestPage — dialog gets RestMethod type import from rest-types", async () => {
  // The handler signature references RestMethod; the import must exist or
  // the page won't compile. Tolerant of additional types being imported
  // alongside (RestBody / RestHeader for the cURL import dialog, etc.).
  const page = await loadSource("../src/components/rest/RestPage.tsx");
  assert.match(page, /import type \{[^}]*\bRestMethod\b[^}]*\} from "\.\/rest-types"/);
});

test("RestAuthorizationPanel — 4 auth modes wired with secret-handle storage (Phase 10B)", async () => {
  const panel = await loadSource("../src/components/rest/RestAuthorizationPanel.tsx");
  assert.match(panel, /export function RestAuthorizationPanel\(/);

  // All 4 auth modes listed in the picker.
  for (const mode of ["none", "bearer", "basic", "api-key"]) {
    assert.match(panel, new RegExp(`value:\\s*"${mode}"`));
  }

  // Mode-specific subforms exist.
  assert.match(panel, /function BearerForm\(/);
  assert.match(panel, /function BasicForm\(/);
  assert.match(panel, /function ApiKeyForm\(/);

  // Plaintext is rebuilt with the proper prefix at save time so the keychain
  // holds the ready-to-inject header value.
  assert.match(panel, /`Bearer \$\{input\}`/);
  assert.match(panel, /`Basic \$\{b64\(`\$\{username\}:\$\{input\}`\)\}`/);

  // The Authorization tab now does inline editing — plaintext resolves
  // from the keychain via resolveSecretPlain (DEC #195 relaxed per user
  // request: "display 不需要 encrypted 的 / 也不需要那个 change"). The
  // Change button + masked-display pattern is gone; secrets save with
  // a 500ms debounce + on blur.
  assert.match(panel, /saveSecret\(\{[\s\S]{0,200}?plaintext:/);
  assert.match(panel, /resolveSecretPlain\(/);
  assert.doesNotMatch(panel, /resolveSecretMasked/);
  // Inline editor — no longer a masked pill behind a Change button.
  assert.doesNotMatch(panel, /Change<\/Button>/);
  // Bearer / Basic strip the on-disk prefix when reading back so users
  // edit the bare token, not "Bearer <token>".
  assert.match(panel, /stripDisplayPrefix=\{\(stored\) => stored\.replace\(\/\^Bearer/);
});

test("rest-keychain — authToSecretRefs builds correct path per auth mode", async () => {
  const kc = await loadSource("../src/components/rest/rest-keychain.ts");
  assert.match(kc, /export function authToSecretRefs\(auth: RestAuth \| undefined\): SecretRef\[\]/);

  // Bearer + Basic both inject at headers.Authorization.
  assert.match(kc, /auth\.kind === "bearer"[\s\S]{0,200}?path:\s*"headers\.Authorization"/);
  assert.match(kc, /auth\.kind === "basic"[\s\S]{0,200}?path:\s*"headers\.Authorization"/);

  // API key respects `in` — header vs query bucket.
  assert.match(kc, /auth\.in === "query"[\s\S]{0,80}?"query"[\s\S]{0,80}?"headers"/);
  assert.match(kc, /\$\{bucket\}\.\$\{auth\.name\.trim\(\)\}/);

  // Missing handle / empty name → empty array (no leaky secretRef sent).
  assert.match(kc, /if \(!auth\.tokenHandleId\) return \[\];/);
  assert.match(kc, /if \(!auth\.passwordHandleId\) return \[\];/);
  assert.match(kc, /if \(!auth\.valueHandleId \|\| !auth\.name\.trim\(\)\) return \[\];/);
});

test("RestRequestEditor — Send passes auth-derived secretRefs (no more empty array)", async () => {
  // Pre-10B handleSend passed `secretRefs: []` — auth was a no-op even when
  // the user filled the Authorization tab. The fix wires authToSecretRefs.
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  assert.match(editor, /authToSecretRefs\(req\.auth\)/);
  // RestAuthorizationPanel is rendered again (collapsible section): the
  // simplify refactor had orphaned it, leaving saved credentials silently
  // injected on every send with no way to view/rotate/remove them.
  assert.match(editor, /import \{ RestAuthorizationPanel \} from "\.\/RestAuthorizationPanel"/);
  assert.match(editor, /<RestAuthorizationPanel request=\{request\} onChange=\{onChange\} \/>/);
});

test("cookie_store — Phase 10B SQLite persistence replaces empty stubs", async () => {
  // Pre-10B rest_get_cookies returned `Vec::new()` and rest_clear_cookies
  // was a no-op. Phase 10B routes both through the new cookie_store module
  // which speaks to the rest_cookies SQLite table.
  const store = await loadSource("../src-tauri/src/rest/cookie_store.rs");
  assert.match(store, /pub fn list_cookies\(collection_id: &str\)/);
  assert.match(store, /pub fn upsert_cookie\(collection_id: &str, cookie: &RestCookie\)/);
  assert.match(store, /pub fn clear_cookies\(collection_id: &str\)/);

  // Real SQL (not stubs).
  assert.match(store, /SELECT[\s\S]{0,300}?FROM rest_cookies/);
  assert.match(store, /INSERT INTO rest_cookies[\s\S]{0,400}?ON CONFLICT\(id\) DO UPDATE SET/);
  assert.match(store, /DELETE FROM rest_cookies WHERE collection_id = \?/);

  // Expired cookies must be filtered from list_cookies — pre-10B FE would
  // need to filter manually, post-10B the storage layer does it.
  assert.match(store, /if exp < now_u64/);

  // commands.rs no longer returns Vec::new() — must call the store.
  const cmds = await loadSource("../src-tauri/src/rest/commands.rs");
  assert.doesNotMatch(cmds, /async fn rest_get_cookies[\s\S]{0,400}?Ok\(Vec::new\(\)\)/);
  // 600-char window accommodates the new doc comment block above each call.
  assert.match(cmds, /async fn rest_get_cookies[\s\S]{0,600}?cookie_store::list_cookies/);
  assert.match(cmds, /async fn rest_clear_cookies[\s\S]{0,400}?cookie_store::clear_cookies/);

  // mod.rs registers cookie_store as a sibling module.
  const mod_ = await loadSource("../src-tauri/src/rest/mod.rs");
  assert.match(mod_, /pub mod cookie_store;/);

  // db.rs exposes a shared connection opener so cookie_store can reuse the
  // existing migration plumbing (single source of truth for the schema).
  const db = await loadSource("../src-tauri/src/db.rs");
  assert.match(db, /pub\(crate\) fn open_product_db_shared/);
});

test("rest-curl-builder — shell-quote + disabled-skip + secret-inline (post-DEC-#195 relax)", async () => {
  // Source-assertion style (node:test can't import .ts directly).
  // History: DEC #195 used to mandate redaction of plaintext on
  // clipboard. After switching to local-file secret storage and
  // showing plaintext inline in the Authorization tab, the redaction
  // became inconsistent — Copy curl emitted `<token>` placeholders
  // while the same token was visible one tab over. buildCurl is now
  // async and resolves the handles to plaintext via
  // resolveSecretPlain so the emitted curl is paste-ready.
  const src = await loadSource("../src/components/rest/rest-curl-builder.ts");

  // 1. Disabled headers / query params are filtered out — no leaked
  //    intent-to-skip rows in the clipboard output.
  assert.match(src, /if \(!h\.enabled \|\| !h\.key\.trim\(\)\) continue/);
  assert.match(src, /q\.enabled && q\.key\.trim\(\)/);

  // 2. buildCurl is async + resolves each auth handle via
  //    resolveSecretPlain to inline the real credential.
  assert.match(src, /export async function buildCurl\(/);
  assert.match(src, /import \{ resolveSecretPlain \}/);
  assert.match(src, /req\.auth\.tokenHandleId/);
  assert.match(src, /req\.auth\.passwordHandleId/);
  assert.match(src, /req\.auth\.valueHandleId/);

  // 3. Old redaction patterns must NOT come back — would silently
  //    revert to placeholder mode if a future refactor copy-pastes.
  assert.doesNotMatch(src, /<redacted — fill in manually>/);
  assert.doesNotMatch(src, /SENSITIVE_HEADER_NAMES/);

  // 4. POSIX single-quote escaping: `'` → `'\''` so payloads with
  //    quotes don't break the resulting shell command.
  assert.match(src, /input\.replace\(\/'\/g,\s*"'\\\\''"\)/);

  // 5. JSON body emits a Content-Type so the curl is self-describing.
  assert.match(src, /-H 'Content-Type: application\/json'/);
});

test("RestRequestEditor — Cancel button + Esc abort + Copy curl wiring", async () => {
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");

  // Cancel: version-bump pattern so a stale invoke() result is ignored
  // when it eventually resolves (Tauri invoke has no abort signal).
  // Post module-switch refactor: the per-request send version lives in
  // the Zustand store (keyed by request.id), not in a component ref —
  // that way switching modules during a send still discards stale
  // results once the response lands.
  assert.match(editor, /bumpRestSendVersion\(req\.id\)/);
  assert.match(editor, /setRestResponseResult\(req\.id, myVersion/);
  assert.match(editor, /handleCancel = \(\) =>/);
  assert.match(editor, /bumpRestSendVersion\(request\.id\)/);

  // Cancel button replaces Send while in-flight.
  assert.match(editor, /sending \?[\s\S]{0,500}?onClick=\{handleCancel\}[\s\S]{0,200}?Cancel/);

  // Esc when sending → cancel (capture-phase + stopPropagation so
  // RestPage's outer Esc — which closes the whole module — doesn't
  // fire mid-send). sendingRef still tracks the latest store-derived
  // sending flag, populated by an effect that mirrors slot.sending.
  assert.match(editor, /e\.key === "Escape" && sendingRef\.current/);
  assert.match(editor, /addEventListener\("keydown", onEscape, true\)/);

  // Copy curl: routes through the Tauri clipboard plugin via the
  // writeClipboard helper (the navigator.clipboard path loses its
  // user-gesture token across our async buildCurl chain). Flashes
  // "Copied" on success.
  assert.match(editor, /handleCopyCurl/);
  assert.match(editor, /writeClipboard\(/);
  assert.match(editor, /Copy curl/);
});

test("RestRequestEditor — URL bar has no onBlur query-param extraction (simplified layout)", async () => {
  // Simplified layout: URL bar is plain input — query params are appended
  // by Rust backend from the stored queryParams array. No extraction on blur.
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  assert.doesNotMatch(editor, /onBlur/);
  assert.doesNotMatch(editor, /decodeURIComponent/);
  assert.doesNotMatch(editor, /queryString.*split/);
});

test("RestPage — workspace UI (selectedProject/Env, openTabIds, activeTabId, lastCollectionId) lives in Zustand", async () => {
  // Bug history: switching from REST → another module and back also
  // wiped the sidebar selection (collection no longer highlighted) and
  // closed every tab. Cause: RestPage held this state in local useState,
  // discarded on unmount. Lifted to a session-only Zustand slice so
  // workspace UI survives module switch.
  const page = await loadSource("../src/components/rest/RestPage.tsx");
  const store = await loadSource("../src/lib/store.ts");
  const storeTypes = await loadSource("../src/lib/store-types.ts");
  const keys = await loadSource("../src/lib/persistence-keys.ts");

  // Store declares the shape + the single patch-style setter.
  assert.match(storeTypes, /export interface RestWorkspaceState/);
  for (const field of [
    "selectedProjectId",
    "selectedEnvId",
    "openTabIds",
    "activeTabId",
    "lastCollectionId",
  ]) {
    assert.match(storeTypes, new RegExp(`\\b${field}\\b`));
  }
  assert.match(store, /restWorkspace:\s*\{/);
  assert.match(store, /setRestWorkspace:\s*\(patch\)\s*=>/);

  // RestPage reads the workspace from store, not local useState.
  assert.match(page, /useAppStore\(\(s\)\s*=>\s*s\.restWorkspace\)/);
  // No local useState shadows the workspace fields.
  assert.doesNotMatch(page, /const \[selectedProjectId, setSelectedProjectId\] = useState/);
  assert.doesNotMatch(page, /const \[openTabIds, setOpenTabIds\] = useState/);
  assert.doesNotMatch(page, /const \[activeTabId, setActiveTabId\] = useState/);

  // Session-only — must NOT be a persistence key.
  assert.doesNotMatch(keys, /restWorkspace/);
});

test("RestRequestEditor — response/sending/sendError live in Zustand restResponses (survives module switch)", async () => {
  // Bug history: switching from REST → another module and back wiped
  // the response because state was held in component useState. Lifted
  // to a session-only Zustand slice keyed by request.id so the store
  // outlives the component lifecycle. Sub-tab + show-full-body live
  // on the same slot so they also survive.
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  const store = await loadSource("../src/lib/store.ts");
  const storeTypes = await loadSource("../src/lib/store-types.ts");
  const keys = await loadSource("../src/lib/persistence-keys.ts");

  // Editor reads response state from store, not local useState.
  assert.match(editor, /useAppStore[\s\S]{0,80}?restResponses\[request\.id\]/);
  assert.doesNotMatch(editor, /const \[response, setResponse\] = useState/);
  assert.doesNotMatch(editor, /const \[sending, setSending\] = useState/);
  assert.doesNotMatch(editor, /const \[sendError, setSendError\] = useState/);

  // Store declares the slice + all 6 mutators.
  assert.match(storeTypes, /export interface RestResponseSlot/);
  assert.match(storeTypes, /restResponses:\s*Record<string,\s*RestResponseSlot>/);
  assert.match(store, /setRestResponseResult:[\s\S]{0,400}?slot\.sendVersion !== version/);
  for (const setter of [
    "setRestResponseResult",
    "setRestSending",
    "bumpRestSendVersion",
    "setRestResponseSubTab",
    "setRestResponseShowFullBody",
    "clearRestResponse",
  ]) {
    assert.match(store, new RegExp(`\\b${setter}\\b`));
  }

  // Session-only contract — slot must NOT be a persistence key. A future
  // PR that accidentally persists 50 MB response blobs to app_kv would
  // bloat hydrate and slow cold start.
  assert.doesNotMatch(keys, /restResponses/);

  // Memory leak guard — deleting a request also clears its slot.
  const page = await loadSource("../src/components/rest/RestPage.tsx");
  assert.match(page, /clearRestResponse\(/);
});

test("rest-history — append/load/clear contract + 200-entry cap (Phase 10C)", async () => {
  const src = await loadSource("../src/components/rest/rest-history.ts");
  assert.match(src, /export function appendHistory\(/);
  assert.match(src, /export function loadHistory\(\)/);
  assert.match(src, /export function clearHistory\(\)/);
  // Cap at 200 — trim from the end so oldest fall off.
  assert.match(src, /MAX_ENTRIES = 200/);
  assert.match(src, /\.slice\(0, MAX_ENTRIES\)/);
  // Snapshot must carry the auth field (handles only — no plaintext).
  assert.match(src, /auth\?\: RestAuth/);
});

test("RestHistoryPanel — modal with replay + clear + capture-phase Esc (Phase 10C)", async () => {
  const panel = await loadSource("../src/components/rest/RestHistoryPanel.tsx");
  assert.match(panel, /export function RestHistoryPanel\(/);
  assert.match(panel, /onReplay/);
  assert.match(panel, /clearHistory\(\)/);
  assert.match(panel, /deleteHistoryEntry/);
  // Capture-phase + stopPropagation Esc so closing the modal doesn't bubble
  // up to RestPage's outer "close module" Esc.
  assert.match(panel, /addEventListener\("keydown"[\s\S]{0,50}?,\s*true\s*\)/);
  assert.match(panel, /e\.stopPropagation/);
});

test("App.tsx — ⌘+H module-aware (REST opens history modal, gRPC opens history panel)", async () => {
  const app = await loadSource("../src/App.tsx");
  assert.match(
    app,
    /case "h":[\s\S]{0,400}?if \(isClient\)[\s\S]{0,200}?setHistoryOpen[\s\S]{0,200}?else if \(isRest\)[\s\S]{0,200}?REST_OPEN_HISTORY_EVENT/,
  );
  // Event const added.
  const events = await loadSource("../src/lib/rest-events.ts");
  assert.match(events, /export const REST_OPEN_HISTORY_EVENT/);

  // RestPage listens + renders the panel + has a replay handler.
  const page = await loadSource("../src/components/rest/RestPage.tsx");
  assert.match(page, /addEventListener\(REST_OPEN_HISTORY_EVENT/);
  assert.match(page, /<RestHistoryPanel/);
  assert.match(page, /handleReplayFromHistory/);
});

test("commands.rs — Set-Cookie auto-parse + collection-scoped persistence (Phase 10D)", async () => {
  const cmds = await loadSource("../src-tauri/src/rest/commands.rs");
  // SendRequestPayload accepts an optional collection_id so cookies know
  // which bucket to land in.
  assert.match(cmds, /pub collection_id: Option<String>/);
  // Iteration over response headers looking for set-cookie (case-insensitive).
  assert.match(cmds, /eq_ignore_ascii_case\("set-cookie"\)/);
  // Upsert into the cookie_store on each match.
  assert.match(cmds, /super::cookie_store::upsert_cookie/);
  // parse_set_cookie function exists with proper attribute extraction
  // (max-age computes future expires_at).
  assert.match(cmds, /pub fn parse_set_cookie\(value: &str, fallback_domain: &str\)/);
  assert.match(cmds, /strip_prefix\("max-age="\)/);
  assert.match(cmds, /strip_prefix\("domain="\)/);
});

test("RestCookiesPanel — list/clear/add/delete UI backed by rest-keychain helpers", async () => {
  const panel = await loadSource("../src/components/rest/RestCookiesPanel.tsx");
  assert.match(panel, /export function RestCookiesPanel\(/);
  // Imports include the new saveCookie + deleteCookie helpers (Phase 10D
  // manual cookie CRUD).
  assert.match(panel, /import \{[\s\S]{0,200}?clearCookies[\s\S]{0,200}?\} from "\.\/rest-keychain"/);
  assert.match(panel, /\bsaveCookie\b/);
  assert.match(panel, /\bdeleteCookie\b/);
  // UI affordances: Add row + Refresh button + Clear all + per-row delete.
  assert.match(panel, /onClick=\{\(\) => setAddingDraft\(/);
  assert.match(panel, /Refresh/);
  assert.match(panel, /Clear all/);
  assert.match(panel, /handleDelete/);
  assert.match(panel, /No cookies yet/);
  // Expiry parser supports relative offsets + ISO date + never/session.
  assert.match(panel, /function parseExpiry\(/);
  assert.match(panel, /never \| 1d \| 2026-12-31/);

  // Rust commands registered.
  const lib = await loadSource("../src-tauri/src/lib.rs");
  assert.match(lib, /rest::commands::rest_save_cookie/);
  assert.match(lib, /rest::commands::rest_delete_cookie/);

  // commands.rs has the new Tauri command shells.
  const cmds = await loadSource("../src-tauri/src/rest/commands.rs");
  assert.match(cmds, /pub async fn rest_save_cookie\(/);
  assert.match(cmds, /pub async fn rest_delete_cookie\(/);

  // cookie_store has the per-row delete helper.
  const store = await loadSource("../src-tauri/src/rest/cookie_store.rs");
  assert.match(store, /pub fn delete_cookie\(/);
  assert.match(store, /synthetic_id = format!\("\{\}::\{\}::\{\}", collection_id, domain, name\)/);

  // Editor no longer mounts Cookies panel (simplified layout — Headers + Body only).
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  assert.doesNotMatch(editor, /RestCookiesPanel/);
});

test("jsonpath-mini — supports $.x / [n] / [-n] / [*] for back-compat consumers", async () => {
  // The REST response viewer no longer uses JSONPath filtering — the
  // input was removed per user request ("没用就删了"). The parser itself
  // stays as a shared lib (Docs KB / other modules can still use it).
  const src = await loadSource("../src/lib/jsonpath-mini.ts");
  assert.match(src, /export function applyJsonPath\(/);
  assert.match(src, /kind: "wildcard"/);
  assert.match(src, /current\.length \+ seg\.index/);
  assert.match(src, /inner\.startsWith\('"'\) && inner\.endsWith\('"'\)/);

  // ResponsePanel uses parseJsonBody to pretty-print but no longer
  // touches JSONPath UI / wildcard guard / truncation cap variables
  // that were tied to JSONPath filtering.
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  assert.match(editor, /import \{ parseJsonBody \} from "@\/lib\/jsonpath-mini"/);
  assert.match(editor, /useMemo\(\(\) => parseJsonBody\(response\.body\), \[response\.body\]\)/);
  // Negative assertions — the removed UI must NOT come back.
  assert.doesNotMatch(editor, /placeholder="\$ \(whole body\)/);
  assert.doesNotMatch(editor, /LARGE_BODY_BYTES/);
  assert.doesNotMatch(editor, /jsonPathUsesWildcard/);
  // Truncation cap stays (large response bodies still get clipped).
  assert.match(editor, /RESPONSE_DISPLAY_CAP/);
  assert.match(editor, /Show full/);
});

test("rest-curl-builder — Copy fetch button + buildFetchSnippet helper removed (post-Phase-10D cleanup)", async () => {
  // Per user request: only Copy curl is exposed in the editor; the JS
  // fetch() snippet was unused and added clutter to the action row.
  // Anti-regression — keep both the helper and the button from coming
  // back without a deliberate decision.
  const src = await loadSource("../src/components/rest/rest-curl-builder.ts");
  assert.doesNotMatch(src, /buildFetchSnippet/);
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  assert.doesNotMatch(editor, /Copy fetch/);
  assert.doesNotMatch(editor, /buildFetchSnippet/);
});

test("RestRequestEditor — body: JSON only (no toggle, no raw)", async () => {
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  assert.match(editor, /JsonEditor/);
  assert.match(editor, /handleFormatBody/);
  assert.doesNotMatch(editor, /BODY_MODES/);
  assert.doesNotMatch(editor, /handleBodyMode/);
  assert.doesNotMatch(editor, /bodyMode/);
  assert.doesNotMatch(editor, /<textarea/);
});

test("Phase 10D review fixes — must-fix invariants locked (post-adversarial-review)", async () => {
  // Critical: curl import promotes Authorization / well-known API-key headers
  // into req.auth via saveSecret (OS keychain) and strips them from
  // req.headers. Plaintext must NOT survive into app_kv / history / IPC.
  const dialog = await loadSource("../src/components/rest/RestCurlImportDialog.tsx");
  assert.match(dialog, /import \{ saveSecret \} from "\.\/rest-keychain"/);
  assert.match(dialog, /API_KEY_HEADER_NAMES = new Set\(/);
  assert.match(dialog, /promoteAuthHeaders/);
  // Bearer and Basic branches both call saveSecret and continue (skip the
  // header from kept[]) — that's the strip step. 800-char window covers
  // the username-decode + try/catch scaffolding inside the Basic branch.
  assert.match(dialog, /\^bearer\\s\+\/i\.test\(h\.value\)[\s\S]{0,800}?saveSecret/);
  assert.match(dialog, /\^basic\\s\+\/i\.test\(h\.value\)[\s\S]{0,800}?saveSecret/);

  // High: replay path validates handle ids and strips on miss.
  const page = await loadSource("../src/components/rest/RestPage.tsx");
  assert.match(page, /handleIdForAuth/);
  assert.match(page, /stripAuthHandle/);
  assert.match(page, /resolveSecretMasked\(\{ id: handleId \}\)/);
  assert.match(page, /Stored credentials for this request are no longer/);

  // Import button was removed from the header per user request; the
  // cURL import flow itself is still reachable via the ⌘+Shift+I
  // shortcut → REST_OPEN_CURL_IMPORT_EVENT → setCurlImportOpen(true).
  // Verify the wiring is intact even without the button.
  assert.match(page, /const onOpenCurlImport = \(\) => setCurlImportOpen\(true\)/);
  assert.match(page, /REST_OPEN_CURL_IMPORT_EVENT, onOpenCurlImport/);

  // High: clipboard error surfaces in the UI instead of silent-failing.
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  assert.match(editor, /setClipboardError/);
  assert.match(editor, /catch \(e\)[\s\S]{0,200}?setClipboardError/);

  // High: appendHistory call sits inside the version-match guard so a
  // stale (canceled) send never leaks into history. Post lift-to-store
  // refactor the version lives in the Zustand slot; the guard reads
  // the current sendVersion via getState().
  assert.match(
    editor,
    /restResponses\[req\.id\]\?\.sendVersion[\s\S]{0,80}?\?\?[\s\S]{0,40}?currentVersion === myVersion[\s\S]{0,400}?appendHistory\(/,
  );

  // High: the rest-keychain helpers used by replay only return handle IDs —
  // they never expose plaintext. Locking the function shape prevents a
  // refactor from accidentally widening the contract.
  const kc = await loadSource("../src/components/rest/rest-keychain.ts");
  assert.match(kc, /export function handleIdForAuth\(auth: RestAuth \| undefined\): string \| null/);
  assert.match(kc, /export function stripAuthHandle\(auth: RestAuth \| undefined\): RestAuth \| undefined/);
});

test("RestMigrationBanner — removed per user request (gRPC client view stays clean)", async () => {
  // Migration banner was tried in Phase 10B and removed by user feedback —
  // gRPC client view should not show a REST cross-promo strip. Guard against
  // accidental reintroduction in a future refactor.
  const app = await loadSource("../src/App.tsx");
  assert.doesNotMatch(app, /RestMigrationBanner/);
});

test("RestCurlImportDialog — module-aware ⌘+Shift+I opens REST-shaped curl importer (Phase 10C)", async () => {
  // Pre-10C ⌘+Shift+I in REST module opened the gRPC-shaped CurlImport which
  // created a gRPC tab — useless from inside REST. Phase 10C dispatches the
  // REST_OPEN_CURL_IMPORT_EVENT instead, RestPage opens its own dialog.
  const dialog = await loadSource("../src/components/rest/RestCurlImportDialog.tsx");
  assert.match(dialog, /export function RestCurlImportDialog\(/);

  // Uses the shared parseCurl helper (not a fork — the gRPC dialog and REST
  // dialog must agree on what a "curl command" looks like).
  assert.match(dialog, /import \{ parseCurl, type ParsedCurl \} from "@\/lib\/curl-parser"/);

  // Body content-type detection covers JSON + form-urlencoded; everything
  // else lands in `raw` mode (REST editor still renders it cleanly).
  assert.match(dialog, /application\/json/);
  assert.match(dialog, /application\/x-www-form-urlencoded/);
  assert.match(dialog, /mode: "raw"/);

  // Event wiring — App.tsx dispatches, RestPage listens.
  const events = await loadSource("../src/lib/rest-events.ts");
  assert.match(events, /export const REST_OPEN_CURL_IMPORT_EVENT/);

  const app = await loadSource("../src/App.tsx");
  // ⌘+Shift+I in REST → dispatch event, else open the legacy gRPC dialog.
  assert.match(
    app,
    /case "i":[\s\S]{0,300}?if \(e\.shiftKey\)[\s\S]{0,200}?if \(isRest\)[\s\S]{0,100}?REST_OPEN_CURL_IMPORT_EVENT[\s\S]{0,200}?else setCurlImportOpen/,
  );

  const page = await loadSource("../src/components/rest/RestPage.tsx");
  assert.match(page, /addEventListener\(REST_OPEN_CURL_IMPORT_EVENT/);
  assert.match(page, /<RestCurlImportDialog/);
  // RestPage handles the import — createRequest + upsertRequest patches in
  // the parsed method/url/headers/body, then opens the tab.
  assert.match(page, /handleImportFromCurl/);
});

test("keychain.rs — active_adapter defaults to SqliteKeychain to avoid macOS prompt loop", async () => {
  // History: Phase 10B made OsKeychain the default. macOS issued a
  // keychain password prompt on every secret read by a fresh binary
  // (dev rebuilds = fresh signature). User feedback ("他一直跳这个，我
  // 重启了就这样") made that UX unacceptable. We now store secrets in
  // app_kv via SqliteKeychain — same on-disk plaintext model as
  // Postman / Insomnia / Bruno.
  const src = await loadSource("../src-tauri/src/rest/keychain.rs");

  // Only SqliteKeychain remains — OS keychain + keyring crate are gone.
  // User pushback ("普通代码都不需要，postman 都不需要") finalized this:
  // Postman / Insomnia / Bruno all store secrets in a local file, no
  // OS-level prompts. Match that.
  assert.match(src, /pub struct SqliteKeychain;/);
  assert.match(src, /impl KeychainAdapter for SqliteKeychain/);

  // SqliteKeychain routes through internal app_kv helpers under a stable
  // key prefix. The renderer-facing db_* IPC helpers reject this prefix so
  // secrets are not returned by generic app-state hydration.
  assert.match(src, /crate::db::app_value_set_internal\(/);
  assert.match(src, /crate::db::app_value_get_internal\(/);
  assert.match(src, /crate::db::app_value_delete_internal\(/);
  assert.match(src, /"rest:secret:\{\}::\{\}"/);

  // active_adapter() defaults to SqliteKeychain.
  assert.match(
    src,
    /pub fn active_adapter\(\)[\s\S]{0,300}?Box::new\(SqliteKeychain::new\(\)\)/,
  );

  // Anti-regression: no OS keychain code, no keyring crate import.
  assert.doesNotMatch(src, /OsKeychain/);
  assert.doesNotMatch(src, /keyring::/);

  // Cargo manifest no longer pulls the keyring crate.
  const cargo = await loadSource("../src-tauri/Cargo.toml");
  assert.doesNotMatch(cargo, /^keyring\s*=/m);
});

test("Rust dev build hygiene — test-only helpers do not leak into normal builds", async () => {
  const authPopover = await loadSource("../src-tauri/src/auth_popover.rs");
  assert.doesNotMatch(authPopover, /fn\s+base64_encode\(/);

  const keychain = await loadSource("../src-tauri/src/rest/keychain.rs");
  assert.match(keychain, /#\[cfg\(test\)\]\s*pub struct MockKeychain\b/);
  assert.match(
    keychain,
    /pub trait KeychainAdapter[\s\S]*?#\[cfg\(test\)\]\s*fn delete\(/,
  );
  assert.match(
    keychain,
    /impl KeychainAdapter for SqliteKeychain[\s\S]*?#\[cfg\(test\)\]\s*fn delete\(/,
  );
});

test("jsonpath-mini — whole-body path pretty-prints instead of returning the server's minified blob", async () => {
  // Before: applyJsonPathToParsed("$", body) returned body as-is, so
  // the response viewer showed `{"cpf":"...","name":"..."}` on one
  // long line — unreadable for non-trivial responses. Now it always
  // emits JSON.stringify(parsed, null, 2) when the path is empty / "$".
  const src = await loadSource("../src/lib/jsonpath-mini.ts");
  // Whole-body branch routes through prettyPrint().
  assert.match(
    src,
    /if \(!trimmed \|\| trimmed === "\$"\) return prettyPrint\(parsed, jsonText\)/,
  );
  // Helper uses the 2-space indent.
  assert.match(src, /JSON\.stringify\(parsed, null, 2\)/);
});

test("REST send path — materializes req.auth into placeholder headers/queryParams so secret_refs land somewhere", async () => {
  // Bug history: api-key auth showed the masked secret value correctly
  // in the Authorization tab but the outgoing HTTP request was missing
  // the x-api-key header → server returned 401. Root cause: Rust's
  // send loop only iterates req.headers / req.queryParams when applying
  // secret_refs. req.auth lives OUTSIDE the headers list (so the
  // plaintext can be promoted to the keychain via a handle id), and
  // before this fix the FE never re-injected a placeholder row for
  // Rust's loop to find — so secret_refs resolved the right plaintext
  // but had no header to attach it to.
  //
  // Lock the materialization: handleSend must append a placeholder
  // row for every auth mode (bearer / basic / api-key in header /
  // api-key in query) before invoke()'ing rest_send_request.
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  // Local mutable copies that don't write back to the persisted record.
  // Changed from spread to .map() in Phase 10C to inject env-var interpolation.
  assert.match(editor, /const sendHeaders[\s\S]{0,120}?req\.headers\.map\(/);
  assert.match(editor, /const sendQuery[\s\S]{0,120}?req\.queryParams\.map\(/);
  // Each auth branch pushes the right row.
  assert.match(
    editor,
    /auth\.kind === "bearer"[\s\S]{0,200}?sendHeaders\.push\(\{ key: "Authorization"/,
  );
  assert.match(
    editor,
    /auth\.kind === "basic"[\s\S]{0,200}?sendHeaders\.push\(\{ key: "Authorization"/,
  );
  assert.match(
    editor,
    /auth\.kind === "api-key"[\s\S]{0,400}?auth\.in === "query"[\s\S]{0,80}?sendQuery\.push/,
  );
  // The payload sent to Rust uses the materialized lists, not the raw
  // req.headers / req.queryParams.
  assert.match(editor, /headers: sendHeaders/);
  assert.match(editor, /queryParams: sendQuery/);
});

test("REST URL bar — paste-curl auto-detect populates fields + promotes secrets (DEC #195)", async () => {
  // User-requested feature: pasting a curl command into the URL bar
  // should fill out method / headers / body / auth across the editor
  // instead of dumping the raw curl as a URL. Sensitive headers must
  // promote to the OS keychain via saveSecret() — plaintext must NEVER
  // land in app_kv / IPC / history.
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  const apply = await loadSource("../src/components/rest/rest-curl-apply.ts");

  // Editor wiring: onPaste handler detects curl prefix + applies result.
  assert.match(editor, /import \{ applyCurlToRequest \} from "\.\/rest-curl-apply"/);
  assert.match(editor, /onPaste=\{\(e\)/);
  assert.match(editor, /text\.trim\(\)\.toLowerCase\(\)\.startsWith\("curl"\)/);
  assert.match(editor, /applyCurlToRequest\(text, request\.collectionId\)/);
  // Falls back to raw URL paste if parse fails — don't lose the user's text.
  assert.match(editor, /Couldn't parse curl[\s\S]{0,400}?patch\(\{ url: text \}\)/);

  // Helper exports the high-level wrapper + the secret-promotion path.
  assert.match(apply, /export async function applyCurlToRequest\(/);
  assert.match(apply, /export async function promoteAuthHeaders\(/);
  assert.match(apply, /export function inferBody\(/);

  // DEC #195: every auth branch (bearer / basic / api-key) calls
  // saveSecret() and `continue`s instead of pushing the header to
  // `kept`. The plaintext value never reaches the returned headers.
  assert.match(apply, /\^bearer\\s\+\/i\.test\(h\.value\)[\s\S]{0,400}?saveSecret/);
  assert.match(apply, /\^basic\\s\+\/i\.test\(h\.value\)[\s\S]{0,400}?saveSecret/);
  assert.match(apply, /API_KEY_HEADER_NAMES\.has\(lc\)[\s\S]{0,400}?saveSecret/);
});

test("REST split pane — min-w-0 chain still locks content-driven width drift", async () => {
  // Original bug history: pressing Send made the split visibly shift
  // because intrinsic min-content from the response <pre> leaked up
  // the flex chain. The Postman-tabs refactor replaced ResizablePanels
  // with a hardcoded w-1/2 layout, which removes the drag handle but
  // does NOT remove the min-w-0 requirement — a wide response body
  // can still inflate the row past viewport without it.
  //
  // Per-div token checks instead of exact className substrings so
  // Prettier / Tailwind class reorder doesn't break the test. We
  // identify each load-bearing div by a stable marker class (e.g.
  // flex-col + p-3 + overflow-hidden) then assert the safety tokens
  // are present in the SAME className.
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  const page = await loadSource("../src/components/rest/RestPage.tsx");

  // Helper: at least one div has ALL of `tokens` in its className
  // (order-independent). Tolerates Prettier / Tailwind class reorder.
  function hasDivWithAll(src, marker, ...tokens) {
    const allClasses = [...src.matchAll(/className="([^"]+)"/g)].map((m) => m[1]);
    const hit = allClasses.find((cn) =>
      tokens.every((t) => cn.split(/\s+/).includes(t)),
    );
    assert.ok(hit, `${marker} — no div has all of [${tokens.join(", ")}]`);
  }

  // Editor outer wrapper — flex-col with min-h-0 + min-w-0 + flex-1.
  hasDivWithAll(editor, "RestRequestEditor outer wrapper", "flex", "flex-1", "min-h-0", "min-w-0", "flex-col");
  // Two-pane row — flex with flex-1 + min-h-0 + min-w-0 (NOT flex-col).
  const editorRow = [...editor.matchAll(/className="([^"]+)"/g)]
    .map((m) => m[1])
    .find((cn) => {
      const toks = cn.split(/\s+/);
      return ["flex", "flex-1", "min-h-0", "min-w-0"].every((t) => toks.includes(t))
        && !toks.includes("flex-col");
    });
  assert.ok(editorRow, "RestRequestEditor two-pane row — no flex row with flex-1 + min-h-0 + min-w-0");
  // Response body viewer — p-3 + overflow-hidden (simplified, no sub-tabs).
  hasDivWithAll(editor, "Response body wrapper", "flex", "flex-1", "min-h-0", "min-w-0", "overflow-hidden", "p-3");

  // Response-body viewer — read-only JsonEditor (syntax-highlighted JSON).
  assert.match(editor, /<JsonEditor[\s\S]{0,200}?readOnly/);

  // RestPage chain — workspace column (flex-col + chain-safe) + sidebar+workspace row (flex, not flex-col).
  hasDivWithAll(page, "RestPage workspace column", "flex", "flex-1", "min-h-0", "min-w-0", "flex-col");
  const pageRow = [...page.matchAll(/className="([^"]+)"/g)]
    .map((m) => m[1])
    .find((cn) => {
      const toks = cn.split(/\s+/);
      return ["flex", "flex-1", "min-h-0", "min-w-0"].every((t) => toks.includes(t))
        && !toks.includes("flex-col");
    });
  assert.ok(pageRow, "RestPage sidebar+workspace row — no flex row with flex-1 + min-h-0 + min-w-0");
});

test("REST body panel — JSON only, always JsonEditor (no raw)", async () => {
  // Simplified: json → CodeMirror only, no raw mode.
  const editor = await loadSource("../src/components/rest/RestRequestEditor.tsx");
  assert.match(editor, /^import \{ JsonEditor \} from "@\/components\/ui\/json-editor"/m);
  assert.match(editor, /<JsonEditor/);
  assert.doesNotMatch(editor, /<textarea/);
  assert.doesNotMatch(editor, /BODY_MODES/);
  assert.doesNotMatch(editor, /bodyMode/);
  assert.doesNotMatch(editor, /name="body-mode"/);
});
