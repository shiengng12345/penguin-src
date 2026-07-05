import ReactDOM from "react-dom/client";
import "./index.css";
import { hydratePersistedValues } from "./lib/app-persistence";
import { installErrorLogSink } from "./lib/error-log-sink";
// IMPORTANT: do NOT statically `import App from "./App"` here. App's
// transitive import graph includes src/lib/store.ts, whose Zustand
// initializer SYNCHRONOUSLY reads getPersistedValue(devModeEnabled) at
// module-eval time. With a static import that read happens BEFORE
// `await hydratePersistedValues()` populates the cache, so the store
// locks devModeEnabled to false even when the user IS in dev mode →
// initializeDevModeOnAppStart early-returns → token stays on disk but
// the in-memory flags stay false → Vault/Docs/REST/Home look locked.
// Dynamic-importing App AFTER hydration restores the ordering contract.

// NOTE: installed packages (~/.penguin/*/node_modules) deliberately survive
// app updates. They are standard npm installs read at runtime — user data,
// not an app-version-derived cache. A version-triggered package wipe used to
// live here and forced everyone to reinstall every package (with registry
// auth) after every release. Manual clearing stays available in Settings; a
// future version that truly needs a wipe should ship a one-shot targeted
// migration instead.

// Hash-routed mini-apps (popovers spawned in their own Tauri window).
// Each runs in a fresh OS window with the same Vite bundle, so we
// branch BEFORE hydrating + before loading the main App tree — that
// keeps cold-start fast and avoids spinning up the full Zustand
// store / Vault / REST modules for a 360px popover.
function popoverModeFromHash(): "auth" | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  if (hash === "popover=auth") return "auth";
  return null;
}

async function bootstrapAuthPopover(): Promise<void> {
  // Reset default body margin — Tauri's borderless window is opaque
  // (transparent NSWindow needs macOSPrivateApi which we removed for
  // stability), so the popover panel just fills the OS window
  // edge-to-edge. No rounded corners until we revisit the private-
  // API path.
  document.body.style.margin = "0";
  const { AuthPopoverApp } = await import("./components/browser/AuthPopoverApp");
  ReactDOM.createRoot(document.getElementById("root")!).render(<AuthPopoverApp />);
}

async function bootstrap(): Promise<void> {
  // Hydrate stays blocking — otherwise components mount with empty cache
  // and visibly pop when state lands. Then dynamic-import App so its
  // transitive module graph (including store.ts whose Zustand
  // initializer reads getPersistedValue synchronously) evaluates
  // against a POPULATED cache. See header comment for the bug class.
  await hydratePersistedValues();
  // Wire logger.warn() / logger.error() and global window errors into
  // the SQLite error_log table BEFORE App mounts — otherwise the
  // earliest crashes / warnings during boot escape the dialog.
  installErrorLogSink();
  const { default: App } = await import("./App");
  const { ErrorBoundary } = await import("./components/error-log/ErrorBoundary");

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
}

const mode = popoverModeFromHash();
if (mode === "auth") {
  void bootstrapAuthPopover();
} else {
  void bootstrap();
}
