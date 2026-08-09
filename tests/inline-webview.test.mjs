import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Source-assertion tests for the native child-webview stack. The In-App
// Browser module that once drove it was removed; Vault still owns the inline
// webview components + the Rust commands, so those are what we cover here.

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
  // the label already exists — preserves cookies on intra-host switch.
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
  assert.match(src, /toolbar\?:\s*ReactNode/);
  assert.match(src, /toolbarHeight\?:\s*number/);
  assert.match(src, /flexShrink:\s*0,?\s*\n\s*height:\s*toolbarHeight/);
  assert.match(src, /flexGrow:\s*1/);
  assert.match(src, /role="menu"/);
  assert.match(src, /role="listbox"/);
  assert.match(src, /role="alertdialog"/);
  assert.match(src, /new MutationObserver/);
  assert.match(src, /x:\s*-10000,\s*y:\s*-10000/);
  assert.match(src, /setInlineWebviewVisible\(props\.label, false\)/);
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
  assert.match(src, /evalInlineWebview\(props\.label,\s*script\)/);
});

test("VaultMainPanel reverted: no inline webview JSX, no viewMode state, no InlineWebview* imports", async () => {
  const src = await readFile(`${ROOT}/src/components/vault/VaultMainPanel.tsx`, "utf8");
  assert.doesNotMatch(src, /import \{ InlineWebviewPanel \}/);
  assert.doesNotMatch(src, /import \{ InlineWebviewToolbar \}/);
  assert.doesNotMatch(src, /showInlineWebview/);
  assert.doesNotMatch(src, /viewMode/);
  assert.doesNotMatch(src, /activeWebviewCredId/);
  assert.doesNotMatch(src, /handleOpenWebviewExternal/);
});

test("Vault credential editor surfaces an 'argocd-server' template (URL + username + password)", async () => {
  const src = await readFile(`${ROOT}/src/components/vault/VaultCredentialEditor.tsx`, "utf8");
  assert.match(src, /argocd:\s*"argocd-server"/);
  assert.match(src, /id:\s*"argocd-server"/);
  assert.match(src, /kind:\s*"argocd"/);
  assert.match(src, /label:\s*"Username",\s*kind:\s*"generic",\s*sensitive:\s*false/);
  assert.match(src, /label:\s*"Password",\s*kind:\s*"token",\s*sensitive:\s*true/);
});
