import type { Platform, SubmoduleDefinition } from "./types";

// Best-effort platform detection from the webview UA. Enough to gate discovery
// of platform-specific submodules (e.g. macOS-only wallpaper). This is a UI
// gate for entry points only — NOT a security boundary (Rust commands + Tauri
// capabilities enforce the real thing).
export function currentPlatform(): Platform | "unknown" {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "macos";
  if (/Win/i.test(ua)) return "windows";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "unknown";
}

export function submoduleAvailability(def: SubmoduleDefinition): {
  available: boolean;
  reason?: string;
} {
  const platforms = def.availability?.platforms;
  if (platforms && platforms.length > 0) {
    const here = currentPlatform();
    if (!(platforms as string[]).includes(here)) {
      return { available: false, reason: `${platforms.join(" / ")} only` };
    }
  }
  return { available: true };
}
