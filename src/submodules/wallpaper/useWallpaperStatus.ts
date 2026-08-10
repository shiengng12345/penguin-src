import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface WallpaperStatus {
  state: "disabled" | "running" | "error";
  message?: string | null;
}

// Seeds from wallpaper_get_status and then follows the `wallpaper://status`
// event stream (Rust is the source of truth for whether the window is up).
export function useWallpaperStatus(): WallpaperStatus {
  const [status, setStatus] = useState<WallpaperStatus>({ state: "disabled" });

  useEffect(() => {
    let alive = true;
    invoke<WallpaperStatus>("wallpaper_get_status")
      .then((s) => alive && setStatus(s))
      .catch(() => {});
    const unlisten = listen<WallpaperStatus>("wallpaper://status", (e) => {
      if (alive) setStatus(e.payload);
    });
    return () => {
      alive = false;
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  return status;
}
