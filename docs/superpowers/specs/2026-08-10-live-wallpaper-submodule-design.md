# Live Wallpaper submodule + "Extras" launcher — design

**Date:** 2026-08-10
**Status:** design approved; not yet implemented
**Consulted:** Codex (repo-grounded) + DeepSeek, reconciled against current source.

## Context

Add a macOS **Live Wallpaper** feature to Penguin, reached through a new **"Extras" launcher** opened from the top-left penguin icon (currently a non-interactive brand `<img>` in `Header.tsx`). This is the first of a possible family of *submodules* — add-ons that are deliberately NOT primary sidebar modules (Client/Vault/REST/Docs/Wiki). Penguin is a dev API client; the wallpaper is an orthogonal extra, so scope discipline matters — build a thin, typed submodule surface, **not** a plugin framework.

The primary-module nav already sprawls as `*Open` booleans → `activeModule` in `App.tsx`; this design must not extend that.

## Decided architecture

### Launcher UX — centered "Extras" modal
- The penguin icon (only the image, not the greeting/clock) becomes a button → opens a centered modal (~600px), titled **Extras / Labs**, 2-column tiles. Each tile: icon, title, short description, badges (`Experimental`, `macOS`), and a runtime status dot (`Running / Paused / Error`).
- Single tile today renders as one card; no empty placeholders. Add in-modal search only past ~8 submodules.
- Esc / click-outside closes. Opening the launcher first dispatches the existing `penguin:close-all-dialogs` to avoid modal stacking. Keep the per-theme mascot swap on the icon.

### Submodule registry (compile-time, not a plugin system)
Files under `src/submodules/`:
- `types.ts` — the `Submodule` definition.
- `registry.ts` — `export const submodules: Submodule[]` (typed array).
- `SubmoduleLauncher.tsx` — the Extras modal, renders tiles from the registry.
- `SubmoduleSurfaceHost.tsx` — mounts the active submodule surface (dialog/page).
- `wallpaper/` — `{ index.ts (definition), ConfigDialog.tsx, hooks.ts }`.

Adding a submodule = one folder + one array entry. `App.tsx` never imports a submodule's internals; it only (a) passes `openLauncher` to `Header` and (b) mounts `<SubmoduleSurfaceHost/>`. Do **not** reuse `MainSidebar`'s `ITEMS` — primary nav and extras are different product semantics (may share the access context, never the registry). No dynamic manifests / third-party loading / marketplace.

### Two-axis surface/runtime model
Each submodule declares two independent axes (cleaner than one `kind`):
- `surface: "dialog" | "page" | "none"`
- `runtime: "background" | "none"`

Wallpaper = `surface: "dialog"` + `runtime: "background"`.
Future full-page submodules use a **separate** `activeSubmoduleSurface` state — never written into `activeModule`; closing returns to the prior Client/Vault/REST/Docs/Wiki. A page-style submodule leaves the sidebar with no item marked current and shows an explicit "back to <module>". Promoting a submodule into a real sidebar module is a product decision, not a registry flag.

### State — three layers, kept separate
| State | Authority | Persisted |
|---|---|---|
| launcher / config-dialog open | React submodule-UI state | no |
| `enabled` + scene + video + settings | React Wallpaper store, via existing SQLite `app-persistence.ts` | yes |
| `starting/running/paused/error` + window instances | Rust `WallpaperManager` | no (queried + event-pushed) |

`enabled` = user intent; `runtimeStatus` = what Rust actually did; `configOpen` = pure UI. **Closing the config never disables.** After hydration, React replays config to Rust; Rust returns a status snapshot and emits status events. When the main window is closed, Rust keeps the applied config running; on reopen, React calls `getWallpaperStatus` to resync rather than trusting a stale store.

> Reconciled disagreement: DeepSeek wanted Rust to own persisted `enabled` (for future headless login-start); Codex wanted React+SQLite + replay. **MVP uses React+SQLite** (reuse existing persistence). If headless login-start is added later (P4), move `enabled` authority to Rust.

### Gating
Submodules carry their own declarative gating: `platforms: ["macos"]`, `access: "developer" | ...`, `experimental: true`, resolved by one helper that also returns an unavailable-reason. Wallpaper ships `macOS + experimental` first; loosen later. **Do not reuse `super-admin`** (that's a data-access tier). The UI gate only controls discovery/entry — it is **not** the security boundary: Rust commands, Tauri capabilities, and wallpaper-window-label exclusion are enforced independently.

### Wallpaper native mechanics (from the prior consult — settled)
macOS-only. A dedicated hidden Tauri `WebviewWindow` (never the main window); its `NSWindow` mutated on the main thread via `objc2`/`objc2-app-kit` (make these **direct** macOS-target deps):
- Tauri builder: `decorations(false) resizable(false) focusable(false) focused(false) shadow(false) visible(false)` (this is how `canBecomeKey/Main=false` is achieved — not an objc2 subclass).
- `styleMask = .borderless`, `level = CGWindowLevelForKey(kCGDesktopIconWindowLevelKey) - 1` (compute at runtime, never hard-code), `collectionBehavior = canJoinAllSpaces | stationary | ignoresCycle | fullScreenNone`, `ignoresMouseEvents`, `hasShadow=false`, `isOpaque=true`, black bg, `orderFrontRegardless()` (never Tauri `show()` → it calls `makeKeyAndOrderFront`).
- Render bundled HTML/WebGL + local video in WKWebView (`<video autoplay muted playsinline loop>`, `object-fit: cover`). WebM decodes in WKWebView (AVFoundation can't) — one render path for MVP; native `AVPlayerLayer` only later if profiling demands.
- Pause on `NSWindow.didChangeOcclusionStateNotification` (a hint, not a perfect fullscreen detector), `screensDidSleep/Wake`, session resign, `isLowPowerModeEnabled` + thermal state. Pause = `webview.eval` a first-party `window.__wallpaperSetPaused(true)` contract; arbitrary sites can't meet a battery budget. Never register with Penguin's prevent-sleep runtime.

## Prerequisites / top risks (P0 sign-off)
1. **Upgrade Tauri 2.10.3 → 2.11.1** (fixes a remote-origin custom-command ACL bypass) and **exclude wallpaper window labels from all backend capabilities**.
2. **"Close main window ≠ quit"** — the riskiest change; it affects every module. Today cleanup only runs at `RunEvent::Exit`. Needs: main-window close hides (while wallpaper enabled); Dock reopen restores the config window; a **visible Quit affordance**; explicit Quit runs `wallpaper_shutdown()` (destroy windows, remove observers) before existing cleanup.
3. **CSP** gains `media-src` + a **narrowly-scoped** asset protocol for local video (never scope the whole home dir). Current CSP has neither.
4. **State resync** across "React main window gone, Rust utility still running."
5. Per-screen WKWebView ≈ 100MB+ RSS → MVP single-display only.

## Phased plan
- **P0 — Foundation:** Tauri 2.10.3 → 2.11.1; regress existing windows/ACL/primary modules. Sign off the close-vs-quit approach.
- **P1 — Launcher vertical slice:** penguin-icon button; centered Extras modal; minimal `types.ts`/`registry.ts`; one wallpaper tile; a config-dialog **stub**. Verify it never mutates `activeModule` and closes cleanly.
- **P2 — Wallpaper MVP runtime:** Rust `WallpaperManager` + IPC (`set_wallpaper_settings` / `get_wallpaper_status` + `wallpaper://status` events); single display; one bundled WebGL scene + one local video; enable/disable; settings persistence; runtime status wired to the tile dot.
- **P3 — Release-gate hardening:** occlusion/sleep/low-power pause; close-main-window-≠-quit + Quit teardown; CSP + asset-scope; capability-label exclusion; reopen resync; test on Sonoma 14 / Sequoia 15 / Tahoe 26 (Stage Manager, Spaces, fullscreen, Mission Control, sleep/wake, display hot-plug).
- **P4 — Defer:** multi-display, login-start-without-main-window (move `enabled` authority to Rust then), scene library, preview thumbnails, in-modal search, page-style-extra keep-alive, tray icon, AVPlayerLayer.

Non-macOS dev machines: the wallpaper tile is hidden/disabled by platform gating; nothing wallpaper-related loads or crashes on Windows/Linux.

## Verification
- P0: `pnpm typecheck` + `cargo check` green after the Tauri bump; existing app launches + all primary modules work; run the node suite (note the pre-existing `knowledge-notes-watcher` failure is unrelated).
- P1: launcher opens/closes from the penguin icon; `activeModule` unchanged; stub dialog opens.
- P2/P3: dev-run the app, enable wallpaper, confirm the animated background renders behind desktop icons, click-through works, and it pauses when a fullscreen app covers it / on sleep; confirm main-window close keeps the wallpaper and Quit stops it.

## Explicitly NOT doing
A plugin trait / dynamic loader / event bus / marketplace; a unified primary+submodule registry; react-router / new state library; importing Wallpaper Engine `.pkg` scenes or Steam Workshop content; Mac App Store sandbox packaging (Penguin ships Developer-ID + GitHub updater).
