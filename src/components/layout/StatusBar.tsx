// Persistent bottom status bar. Lives at the root of App.tsx so it
// renders under every module (Home / Client / Vault / REST / Docs) —
// users get a stable reference strip for connectivity + shortcuts +
// settings no matter where they are in the app.
//
// Postman / VS Code / Insomnia all ship something like this; the user
// asked for parity ("我想要每一个 module 都 default 有一个下面的 bar").
//
// Items kept intentionally minimal — connectivity indicator, help,
// settings, version. Per-module quick actions (e.g. Cookies, Trash)
// can be added later via a status-bar-extension slot if needed.

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Keyboard,
  RefreshCw,
  Settings as SettingsIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { RuntimeStatusButton } from "@/components/runtime/RuntimeStatusButton";
import { closeAllInlineWebviews } from "@/lib/inline-webview";
import { countErrorLogSince } from "@/lib/penguin-db";
import { subscribeErrorLogChanged } from "@/lib/error-log-events";
import {
  getPersistedValue,
  setPersistedValue,
} from "@/lib/app-persistence";
import { APP_VALUE_KEYS } from "@/lib/persistence-keys";
import pkg from "../../../package.json";

const ErrorLogDialog = lazy(() =>
  import("@/components/error-log/ErrorLogDialog").then((m) => ({
    default: m.ErrorLogDialog,
  })),
);

interface StatusBarProps {
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
}

function readLastSeenAt(): number {
  const raw = getPersistedValue(APP_VALUE_KEYS.errorLogLastSeenAt);
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function StatusBar({ onOpenSettings, onOpenShortcuts }: StatusBarProps) {
  // Error-log dialog open state + unread-count badge. Re-fetched on
  // every "penguin:error-log-changed" event so logger.error()s landing
  // mid-session update the badge in real time.
  const [errorLogOpen, setErrorLogOpen] = useState(false);
  const [unreadErrors, setUnreadErrors] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const since = readLastSeenAt();
      const count = await countErrorLogSince(since);
      if (!cancelled) setUnreadErrors(count);
    };
    void refresh();
    const unsub = subscribeErrorLogChanged(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const openErrorLog = useCallback(() => {
    setErrorLogOpen(true);
    // Stamp lastSeenAt to "now" so the badge clears immediately. The
    // dialog still reloads the full list on every open.
    const now = Date.now();
    try {
      setPersistedValue(APP_VALUE_KEYS.errorLogLastSeenAt, String(now));
    } catch {
      /* best-effort */
    }
    setUnreadErrors(0);
  }, []);

  // Manual reload escape hatch — when the React tree gets into a wedged
  // state (stale store hydration, orphaned dialog, dead inline webview)
  // the user can click this instead of hunting for the OS context menu.
  // Active module + Vault / Docs / REST data are all persisted, so the
  // only loss is mid-edit form input (same trade-off as Cmd+R). We
  // close Tauri-side child webviews first so they don't paint over the
  // freshly mounted React tree during the brief reload window.
  const hardReload = useCallback(() => {
    closeAllInlineWebviews()
      .catch(() => {
        /* best-effort — child webviews die on reload anyway */
      })
      .finally(() => {
        window.location.reload();
      });
  }, []);

  const [online, setOnline] = useState<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return (
    <>
    <div
      role="contentinfo"
      aria-label="App status bar"
      className="flex shrink-0 items-center gap-0.5 border-t border-border bg-background/95 px-2 py-1 text-[10px] text-muted-foreground"
    >
      {/* Left cluster — connectivity + keyboard shortcuts launcher. */}
      <div
        title={online ? "Online" : "Offline — requests will fail"}
        aria-label={online ? "Network online" : "Network offline"}
        className="flex items-center gap-1.5 rounded px-1.5 py-0.5"
      >
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            online ? "bg-emerald-500" : "bg-red-500",
          )}
          aria-hidden="true"
        />
        <span>{online ? "Online" : "Offline"}</span>
      </div>
      <button
        type="button"
        onClick={onOpenShortcuts}
        title="Keyboard shortcuts (⌘/)"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
      >
        <Keyboard className="h-3 w-3" />
        <span>Shortcuts</span>
      </button>

      {/* Right cluster — errors + reload + settings + help + version. */}
      <button
        type="button"
        onClick={openErrorLog}
        title={
          unreadErrors > 0
            ? `${unreadErrors} new error${unreadErrors === 1 ? "" : "s"} since you last looked`
            : "Error log"
        }
        aria-label="Open error log"
        className="ml-auto relative flex items-center justify-center rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
      >
        <AlertCircle className="h-3 w-3" />
        {unreadErrors > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-3 min-w-[12px] items-center justify-center rounded-full bg-red-500/15 px-1 text-[8px] font-medium leading-none text-red-400/90">
            {unreadErrors > 99 ? "99+" : unreadErrors}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        onClick={hardReload}
        title="Reload Penguin — clears UI state; module + data persist"
        aria-label="Hard reload"
        className="flex items-center justify-center rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
      >
        <RefreshCw className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={onOpenSettings}
        title="Settings (⌘,)"
        aria-label="Open settings"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
      >
        <SettingsIcon className="h-3 w-3" />
      </button>
      <RuntimeStatusButton
        onOpenSettings={() => {
          /* TODO(Task 13): wire this to open the Settings dialog scoped to the Runtime section. */
        }}
      />
      <span
        className="px-1.5 text-muted-foreground/60"
        title={`Pengvi v${pkg.version} · NgSE`}
      >
        <span className="tabular-nums">v{pkg.version}</span> · NgSE
      </span>
    </div>
    {errorLogOpen ? (
      <Suspense fallback={null}>
        <ErrorLogDialog open={errorLogOpen} onClose={() => setErrorLogOpen(false)} />
      </Suspense>
    ) : null}
    </>
  );
}
