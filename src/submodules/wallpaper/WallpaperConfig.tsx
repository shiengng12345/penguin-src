import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { getPersistedValue, setPersistedValue } from "@/lib/app-persistence";
import { APP_VALUE_KEYS } from "@/lib/persistence-keys";
import { useWallpaperStatus } from "./useWallpaperStatus";

// P2 config panel (full-page inside Extras). Toggling drives the Rust
// WallpaperManager (create/destroy the macOS desktop window) and persists the
// choice. The status line reflects Rust reality via the wallpaper://status
// event. onClose is provided by the Extras page (back navigation).
export function WallpaperConfig(_: { onClose: () => void }) {
  const status = useWallpaperStatus();
  const [enabled, setEnabled] = useState<boolean>(
    () => getPersistedValue(APP_VALUE_KEYS.wallpaperEnabled) === "true",
  );
  const [busy, setBusy] = useState(false);

  // If it was left enabled, re-apply on open so the window actually comes up
  // after a restart (idempotent — enable no-ops when already running).
  useEffect(() => {
    if (getPersistedValue(APP_VALUE_KEYS.wallpaperEnabled) === "true") {
      void invoke("wallpaper_set_enabled", { enabled: true }).catch(() => {});
    }
  }, []);

  const toggle = async (next: boolean) => {
    setEnabled(next);
    setBusy(true);
    setPersistedValue(APP_VALUE_KEYS.wallpaperEnabled, String(next));
    try {
      await invoke("wallpaper_set_enabled", { enabled: next });
    } catch {
      // The status event / error state surfaces failures below.
    } finally {
      setBusy(false);
    }
  };

  const statusLabel =
    status.state === "running" ? "Running" : status.state === "error" ? "Error" : "Off";
  const statusColor =
    status.state === "running"
      ? "text-emerald-500"
      : status.state === "error"
        ? "text-red-500"
        : "text-muted-foreground";

  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-2xl">🎨</span>
        <h2 className="text-base font-semibold text-foreground">Live Wallpaper</h2>
        <Badge variant="outline">macOS</Badge>
        <Badge variant="secondary">Experimental</Badge>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Enable live wallpaper</div>
          <div className="text-[11px] text-muted-foreground">
            Animated desktop background behind your icons.{" "}
            <span className={statusColor}>● {statusLabel}</span>
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={toggle}
          disabled={busy}
          aria-label="Enable live wallpaper"
        />
      </div>

      {status.state === "error" && status.message && (
        <p className="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-500">
          {status.message}
        </p>
      )}

      <p className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        macOS only, single display for now. Uses a bundled animated scene. Occlusion/battery pausing,
        multiple displays, and custom video/web sources come next.
      </p>
    </div>
  );
}
