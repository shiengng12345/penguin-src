import ReactDOM from "react-dom/client";
import "./index.css";
import { getPersistedValue, hydratePersistedValues } from "./lib/app-persistence";
import { installErrorLogSink } from "./lib/error-log-sink";
import { RUNTIME_PREVENT_SLEEP_KEY } from "./lib/persistence-keys";
import { setPreventSleep, setRuntimeMode, type PreventSleepPolicy } from "./lib/runtime-client";
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

// Runtime Manager — Task 13: re-apply the user's saved Prevent Sleep policy
// on every launch. Runs exactly once, right after hydration populates the
// persistence cache, so it never fires mid-session or on every render.
// Best-effort — a missing/invalid persisted value or a backend call
// failure here must not block app boot.
async function applyPersistedRuntimePolicy(): Promise<void> {
  const raw = getPersistedValue(RUNTIME_PREVENT_SLEEP_KEY);
  if (raw === null) return;
  try {
    const policy = JSON.parse(raw) as PreventSleepPolicy;
    await setRuntimeMode(policy);
    if (policy.mode === "on_startup") {
      await setPreventSleep(true);
    }
  } catch (err) {
    console.error("Failed to apply persisted runtime policy", err);
  }
}

async function bootstrap(): Promise<void> {
  // Hydrate stays blocking — otherwise components mount with empty cache
  // and visibly pop when state lands. Then dynamic-import App so its
  // transitive module graph (including store.ts whose Zustand
  // initializer reads getPersistedValue synchronously) evaluates
  // against a POPULATED cache. See header comment for the bug class.
  await hydratePersistedValues();
  // Fire-and-forget: don't block first paint on a runtime backend
  // round-trip. Prevent-sleep engaging a beat after the window appears is
  // an acceptable trade-off for not delaying app boot.
  void applyPersistedRuntimePolicy();
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

void bootstrap();
