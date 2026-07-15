import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Source-assertion tests for the native child-webview feature now
// driven by the In-App Browser module (Sprint 11 — re-architected
// after the Vault-embedded version's layout-race chase). Vault no
// longer mounts a webview itself; it forwards a deeplink to Browser.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Rust inline_webview module exposes the 12 commands + reuse path + 1px clamp", async () => {
  const src = await readFile(`${ROOT}/src-tauri/src/inline_webview.rs`, "utf8");
  for (const cmd of [
    "inline_webview_open",
    "inline_webview_set_bounds",
    "inline_webview_set_visible",
    "inline_webview_set_zoom",
    "inline_webview_reload",
    "inline_webview_navigate",
    "inline_webview_back",
    "inline_webview_forward",
    "inline_webview_close",
    "inline_webview_eval",
    "inline_webview_list",
    "inline_webview_close_all",
  ]) {
    assert.match(src, new RegExp(`pub fn ${cmd}`), `missing command ${cmd}`);
  }
  // Reuse-path: open should reposition + show instead of erroring when
  // the label already exists — preserves cookies on intra-Browser switch.
  assert.match(src, /if let Some\(webview\) = app\.webviews\(\)\.get\(&label\)/);
  // 0x0 panic guard.
  assert.match(src, /fn clamp_size/);
  assert.match(src, /fn clamp_zoom/);
  // Native API path — WebviewBuilder + add_child, NOT iframe / shell open.
  assert.match(src, /WebviewBuilder::new\(&label, WebviewUrl::External\(parsed\)\)/);
  assert.match(src, /main\.add_child\(/);
});

test("Rust inline_webview applies native frame updates atomically with set_bounds", async () => {
  const src = await readFile(`${ROOT}/src-tauri/src/inline_webview.rs`, "utf8");
  assert.match(src, /fn logical_rect\(bounds: &Bounds\) -> Rect/);
  assert.match(src, /webview\s*\n\s*\.set_bounds\(logical_rect\(&bounds\)\)/);
  assert.doesNotMatch(src, /inline_webview_set_bounds[\s\S]*?\.set_position\(/);
  assert.doesNotMatch(src, /inline_webview_set_bounds[\s\S]*?\.set_size\(/);
});

test("Rust inline_webview rejects non-http schemes before opening or navigating", async () => {
  const src = await readFile(`${ROOT}/src-tauri/src/inline_webview.rs`, "utf8");
  assert.match(src, /fn parse_http_webview_url/);
  assert.match(src, /match parsed\.scheme\(\)\s*\{\s*"http"\s*\|\s*"https"\s*=>/);
  assert.match(src, /inline_webview_open[\s\S]*?parse_http_webview_url\(&url\)/);
  assert.match(src, /inline_webview_navigate[\s\S]*?parse_http_webview_url\(&url\)/);
});

test("lib.rs registers all 12 inline_webview commands in the invoke handler", async () => {
  const src = await readFile(`${ROOT}/src-tauri/src/lib.rs`, "utf8");
  assert.match(src, /mod inline_webview;/);
  for (const cmd of [
    "inline_webview_open",
    "inline_webview_set_bounds",
    "inline_webview_set_visible",
    "inline_webview_set_zoom",
    "inline_webview_reload",
    "inline_webview_navigate",
    "inline_webview_back",
    "inline_webview_forward",
    "inline_webview_close",
    "inline_webview_eval",
    "inline_webview_list",
    "inline_webview_close_all",
  ]) {
    assert.match(src, new RegExp(`inline_webview::${cmd}`), `${cmd} not in invoke_handler`);
  }
});

test("Cargo.toml enables tauri's `unstable` feature (gates WebviewBuilder + Manager::webviews)", async () => {
  const cargo = await readFile(`${ROOT}/src-tauri/Cargo.toml`, "utf8");
  assert.match(cargo, /tauri\s*=\s*\{\s*version\s*=\s*"2",\s*features\s*=\s*\["unstable"\]\s*\}/);
});

test("src/lib/inline-webview.ts exports the 12 typed bridges", async () => {
  const src = await readFile(`${ROOT}/src/lib/inline-webview.ts`, "utf8");
  for (const fn of [
    "openInlineWebview",
    "setInlineWebviewBounds",
    "setInlineWebviewVisible",
    "setInlineWebviewZoom",
    "reloadInlineWebview",
    "navigateInlineWebview",
    "inlineWebviewBack",
    "inlineWebviewForward",
    "closeInlineWebview",
    "evalInlineWebview",
    "listInlineWebviews",
    "closeAllInlineWebviews",
  ]) {
    assert.match(src, new RegExp(`export function ${fn}`), `missing export ${fn}`);
  }
  assert.match(src, /invoke\("inline_webview_open"/);
  assert.match(src, /invoke\("inline_webview_set_bounds"/);
  assert.match(src, /invoke\("inline_webview_set_zoom"/);
});

test("InlineWebviewPanel: inline-style flex sibling layout + slot prop + modal guard + hide-on-unmount", async () => {
  const src = await readFile(`${ROOT}/src/components/vault/InlineWebviewPanel.tsx`, "utf8");
  // Slot prop architecture: toolbar passed as a prop, NOT rendered by
  // the panel itself — keeps the panel reusable across Vault deeplinks
  // + Browser pinned shortcuts + future hosts.
  assert.match(src, /toolbar\?:\s*ReactNode/);
  assert.match(src, /toolbarHeight\?:\s*number/);
  // Inline-style flex sibling layout: toolbar has flexShrink: 0 +
  // explicit height so it physically occupies its band from frame 1,
  // body div is flexGrow: 1 with minHeight: 0 to fill the rest. This
  // is the layout that finally renders the toolbar reliably after
  // multiple iterations of absolute-position + Tailwind-class chasing.
  assert.match(src, /flexShrink:\s*0,?\s*\n\s*height:\s*toolbarHeight/);
  assert.match(src, /flexGrow:\s*1/);
  // Modal-open guard covers Radix DropdownMenu / Select / Tooltip /
  // AlertDialog in addition to Dialog.
  assert.match(src, /role="menu"/);
  assert.match(src, /role="listbox"/);
  assert.match(src, /role="alertdialog"/);
  assert.match(src, /new MutationObserver/);
  // Unmount: hide + offscreen but do NOT destroy. App-level guard
  // handles full destruction.
  assert.match(src, /x:\s*-10000,\s*y:\s*-10000/);
  assert.match(src, /setInlineWebviewVisible\(props\.label, false\)/);
  // Body-only — must NOT contain its own toolbar JSX (slot pattern).
  assert.doesNotMatch(src, /aria-label="Back"/);
  assert.doesNotMatch(src, /aria-label="Reload"/);
});

test("InlineWebviewPanel measures the actual content rect below the toolbar", async () => {
  const src = await readFile(`${ROOT}/src/components/vault/InlineWebviewPanel.tsx`, "utf8");
  assert.match(src, /function boundsFromRect\(rect: DOMRectReadOnly\): InlineWebviewBounds/);
  assert.match(src, /const rect = el\.getBoundingClientRect\(\);\s*\n\s*return boundsFromRect\(rect\);/);
  assert.doesNotMatch(src, /rect\.top \+ offsetTop/);
  assert.doesNotMatch(src, /rect\.height - offsetTop/);
});

test("InlineWebviewToolbar exposes back / forward / reload / close + url display + reload re-injects prefill", async () => {
  const src = await readFile(`${ROOT}/src/components/vault/InlineWebviewToolbar.tsx`, "utf8");
  assert.match(src, /aria-label="Back"/);
  assert.match(src, /aria-label="Forward"/);
  assert.match(src, /aria-label="Reload"/);
  assert.match(src, /aria-label="Close inline view"/);
  assert.match(src, /{props\.url}/);
  assert.match(src, /rightSlot\?:\s*ReactNode/);
  assert.match(src, /{props\.rightSlot}/);
  // Reload re-injects prefill so Vault sign-in form refills after refresh.
  assert.match(src, /evalInlineWebview\(props\.label,\s*script\)/);
});

test("BrowserPage uses compact zoom chrome and opens embedded pages at 85% by default", async () => {
  const src = await readFile(`${ROOT}/src/components/browser/BrowserPage.tsx`, "utf8");
  assert.match(src, /DEFAULT_BROWSER_ZOOM\s*=\s*0\.85/);
  assert.match(src, /APP_VALUE_KEYS\.browserZoomScale/);
  assert.doesNotMatch(
    src,
    /parsed < LEGACY_BROWSER_ZOOM_FLOOR/,
    "60% is a valid user-selected zoom and must survive reloads",
  );
  assert.doesNotMatch(src, /setPersistedValue\(APP_VALUE_KEYS\.browserZoomScale,\s*String\(DEFAULT_BROWSER_ZOOM\)\)/);
  assert.match(src, /setInlineWebviewZoom\(webviewLabel,\s*browserZoom\)/);
  assert.match(src, /<BrowserZoomControl/);
  assert.match(src, /aria-label="Zoom out"/);
  assert.match(src, /aria-label="Zoom in"/);
  assert.match(src, /Math\.round\(zoom \* 100\)/);
});

test("Browser store slice: shortcut + deeplink types + addOrPromote dedupes by URL + persists", async () => {
  const types = await readFile(`${ROOT}/src/lib/store-types.ts`, "utf8");
  assert.match(types, /export interface BrowserShortcut/);
  assert.match(types, /projectId\?:\s*string/);
  assert.match(types, /envId\?:\s*string/);
  assert.match(types, /prefillToken\?:\s*string/);
  assert.match(types, /export interface BrowserDeeplinkRequest/);
  assert.match(types, /export interface BrowserState/);
  // AppState wires the 7 actions.
  for (const action of [
    "addOrPromoteBrowserShortcut",
    "removeBrowserShortcut",
    "renameBrowserShortcut",
    "reorderBrowserShortcuts",
    "setActiveBrowserShortcut",
    "requestBrowserDeeplink",
    "consumeBrowserDeeplink",
  ]) {
    assert.match(types, new RegExp(action), `missing ${action} on AppState`);
  }

  const store = await readFile(`${ROOT}/src/lib/store.ts`, "utf8");
  // URL-based dedup — re-adding the same URL must promote, not duplicate.
  assert.match(store, /existing\s*=\s*get\(\)\.browser\.shortcuts\.find\(\(s\)\s*=>\s*s\.url === shortcut\.url\)/);
  // Persistence call on every mutation.
  assert.match(store, /persistBrowserShortcuts\(next\)/);
  // projectId / envId merged on promote so re-deeplinks update context.
  assert.match(store, /projectId:\s*shortcut\.projectId\s*\?\?\s*existing\.projectId/);
});

test("BrowserPage groups shortcuts by project+env with stable order, unscoped last", async () => {
  const src = await readFile(`${ROOT}/src/components/browser/BrowserPage.tsx`, "utf8");
  // Soft-filter contract (option A).
  assert.match(src, /UNSCOPED_GROUP_KEY/);
  assert.match(src, /function groupKey/);
  // Unscoped sort-last; otherwise STABLE (by first member createdAt) —
  // we explicitly do NOT re-sort by active group, the user disliked
  // groups jumping to the top when switching shortcuts.
  assert.match(src, /b\.key === UNSCOPED_GROUP_KEY/);
  assert.match(src, /a\.shortcuts\[0\]\.createdAt - b\.shortcuts\[0\]\.createdAt/);
  // Group header derives label from VaultProject + Environment.
  assert.match(src, /groupHeaderLabel/);
  // Deeplink consumption is atomic — store action returns + clears.
  assert.match(src, /consumeDeeplink\(\)/);
  // Prefill script only built when token + baseKind=vault.
  assert.match(src, /active\.baseKind !== "vault"/);
});

test("VaultMainPanel surfaces 'Open in Browser' button on web-renderable kinds + threads paired token", async () => {
  const src = await readFile(`${ROOT}/src/components/vault/VaultMainPanel.tsx`, "utf8");
  // Per-credential dispatcher resolves URL + paired token + env metadata.
  assert.match(src, /handleCredentialOpenInBrowser/);
  // Whitelist matches Browser's renderable set — vault gets token,
  // others don't.
  assert.match(src, /\["vault",\s*"argocd",\s*"monitoring",\s*"web"\]/);
  // Paired-token lookup, both link directions.
  assert.match(src, /cred\.pairedWith !== undefined/);
  assert.match(src, /c\.pairedWith === cred\.id/);
  // Project + env metadata travels with the deeplink for sidebar grouping.
  assert.match(src, /projectId:\s*project\.id/);
  assert.match(src, /envId:\s*selectedEnvId/);
  // Card header button — Compass icon, aria-label.
  assert.match(src, /aria-label="Open in Browser"/);
});

test("VaultMainPanel reverted: no inline webview JSX, no viewMode state, no InlineWebview* imports", async () => {
  const src = await readFile(`${ROOT}/src/components/vault/VaultMainPanel.tsx`, "utf8");
  // The Sprint 10 / Sprint 11 webview-inside-Vault attempt is fully out.
  assert.doesNotMatch(src, /import \{ InlineWebviewPanel \}/);
  assert.doesNotMatch(src, /import \{ InlineWebviewToolbar \}/);
  assert.doesNotMatch(src, /showInlineWebview/);
  assert.doesNotMatch(src, /viewMode/);
  assert.doesNotMatch(src, /activeWebviewCredId/);
  assert.doesNotMatch(src, /handleOpenWebviewExternal/);
});

test("App.tsx Browser module + closeAll guard spares 'vault' AND 'browser'", async () => {
  const src = await readFile(`${ROOT}/src/App.tsx`, "utf8");
  assert.match(src, /import \{ BrowserPage \} from "@\/components\/browser\/BrowserPage"/);
  // App.tsx was updated to use hideAllInlineWebviews (preserves webview
  // session on module switch) instead of closeAllInlineWebviews.
  assert.match(src, /import \{ hideAllInlineWebviews \} from "@\/lib\/inline-webview"/);
  assert.match(src, /\[browserOpen, setBrowserOpen\]/);
  // The guard MUST exempt both vault (legacy, no longer mounts a
  // webview after the revert) AND browser (the dedicated module that
  // does mount one) — otherwise the Browser webview closes itself.
  assert.match(src, /activeModule === "vault"\s*\|\|\s*activeModule === "browser"/);
  // handleOpenInBrowser is the Vault → Browser dispatcher.
  assert.match(src, /handleOpenInBrowser/);
  assert.match(src, /requestBrowserDeeplink\(deeplink\)/);
  // VaultPage receives the dispatcher.
  assert.match(src, /onOpenInBrowser=\{handleOpenInBrowser\}/);
});

test("MainSidebar.tsx exposes the 'browser' MainModule entry", async () => {
  const src = await readFile(`${ROOT}/src/components/layout/MainSidebar.tsx`, "utf8");
  assert.match(src, /"client"\s*\|\s*"rest"\s*\|\s*"vault"\s*\|\s*"docs"\s*\|\s*"browser"\s*\|\s*"database"/);
  // Compass icon used for the browser entry; Browser is super-admin only
  // (normal admins get Client + Vault).
  assert.match(src, /kind:\s*"browser"/);
  assert.match(src, /icon:\s*Compass/);
  assert.match(src, /kind:\s*"browser"[^}]*?requires:\s*"super-admin"/);
});

test("BrowserPage Argo prefill: detects username + password via paired credentials' sensitive flag, with legacy parser fallback", async () => {
  const src = await readFile(`${ROOT}/src/components/browser/BrowserPage.tsx`, "utf8");
  // Triple-credential path — preferred (created by argocd-server template).
  // Username = paired non-sensitive (or kind=generic), Password = paired
  // sensitive credential. Looked up by isSensitive so the naming convention
  // doesn't matter.
  assert.match(src, /function pairedUsernamePasswordForCredential/);
  assert.match(src, /passCred = paired\.find\(\(c\) => c\.isSensitive\)/);
  // Legacy single-credential fallback parser still present.
  assert.match(src, /function parseLoginCredentialValue/);
  assert.match(src, /trimmed\.startsWith\("{"\)/);
  assert.match(src, /trimmed\.indexOf\("\|\|"\)/);
  // baseKind === "argocd" path populates username + password on the
  // shortcut payload (which the prefill script then injects).
  assert.match(src, /baseKind === "argocd"/);
  assert.match(src, /payload\.prefillUsername = parsed\.username/);
  assert.match(src, /payload\.prefillPassword = parsed\.password/);
  // Argo prefill script targets both username + password inputs with
  // a battery of selectors + dispatches input/change events so Argo's
  // Redux-Form state machine picks up the values.
  assert.match(src, /argo prefill script loaded/);
  assert.match(src, /input\[name="username"\]/);
  assert.match(src, /input\[name="password"\]/);
});

test("BrowserPage prefill is host-bound: never fills saved credentials on a foreign origin (F4)", async () => {
  const src = await readFile(`${ROOT}/src/components/browser/BrowserPage.tsx`, "utf8");
  // Expected host is derived from the shortcut URL at build time...
  assert.match(src, /expectedHost = new URL\(active\.url\)\.hostname/);
  // ...embedded as a JSON-safe literal into the injected guard...
  assert.match(src, /const safeHost = JSON\.stringify\(expectedHost\)/);
  // ...and the injected script bails before filling when the live document
  // host differs from the intended host (SSO / redirect / manual nav).
  assert.match(src, /location\.hostname!==__penguinExpectedHost/);
  // Guard must be wired into BOTH the argo (user+pass) and the token IIFEs —
  // a single shared hostGuardJs interpolated into each.
  const guardHits = src.match(/\$\{hostGuardJs\}/g) ?? [];
  assert.ok(guardHits.length >= 2, `expected hostGuardJs in both prefill scripts, found ${guardHits.length}`);
});

test("Vault credential editor surfaces an 'argocd-server' template (URL + username + password)", async () => {
  const src = await readFile(`${ROOT}/src/components/vault/VaultCredentialEditor.tsx`, "utf8");
  // KIND_TO_TEMPLATE_ID picks the new template when the user clicks
  // "Add credential" on the ArgoCD kind rail.
  assert.match(src, /argocd:\s*"argocd-server"/);
  // Template itself — 3 fields with the right kinds + sensitive flag.
  assert.match(src, /id:\s*"argocd-server"/);
  assert.match(src, /kind:\s*"argocd"/);
  assert.match(src, /label:\s*"Username",\s*kind:\s*"generic",\s*sensitive:\s*false/);
  assert.match(src, /label:\s*"Password",\s*kind:\s*"token",\s*sensitive:\s*true/);
});

test("BrowserPage paste auto-matches the URL against Vault credentials + paired token", async () => {
  const src = await readFile(`${ROOT}/src/components/browser/BrowserPage.tsx`, "utf8");
  // Module-level helper functions — shared between paste-add and the
  // explicit From-Vault picker.
  assert.match(src, /function normalizeUrlForMatch/);
  assert.match(src, /function pairedTokenForCredential/);
  assert.match(src, /function shortcutPayloadFromCredential/);
  assert.match(src, /function findVaultMatchForUrl/);
  // handleAddFromInput must consult findVaultMatchForUrl before
  // falling back to a plain URL payload.
  assert.match(src, /vaultMatch\s*=\s*findVaultMatchForUrl\(url, vaultProjects\)/);
  // baseKind branches: vault gets token, argocd gets parsed login,
  // others fall through to plain URL.
  assert.match(src, /if \(baseKind === "vault"\)/);
  assert.match(src, /payload\.prefillToken = pairedTokenForCredential/);
});

test("BrowserPage auto-mirrors Vault + Argo credentials as virtual shortcuts (no picker UI)", async () => {
  const src = await readFile(`${ROOT}/src/components/browser/BrowserPage.tsx`, "utf8");
  // Derived list — built each render from vaultProjects + filtered to
  // the two baseKinds the user wants auto-mirrored.
  assert.match(src, /vaultDerivedShortcuts/);
  assert.match(src, /AUTO_MIRROR_BASE_KINDS = new Set\(\["vault",\s*"argocd"\]\)/);
  // Synthetic id prefix + virtual-shortcut detector control the "no
  // trash icon" rendering branch.
  assert.match(src, /VAULT_DERIVED_PREFIX/);
  assert.match(src, /function isVaultDerivedShortcut/);
  assert.match(src, /isVaultDerivedShortcut\(s\)\s*\?\s*null/);
  // Final render list merges derived + manual, dedupe by URL.
  assert.match(src, /displayShortcuts/);
  // Picker UI is removed — auto-mirror replaces it.
  assert.doesNotMatch(src, />From Vault</);
  assert.doesNotMatch(src, /vaultPickerOpen/);
});
