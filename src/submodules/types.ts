import type { ComponentType } from "react";

// A "submodule" is an add-on reached from the Extras launcher (penguin icon),
// deliberately separate from the primary sidebar modules. Two independent axes:
//   surface — where its UI lives (a dialog, a transient full page, or nothing)
//   runtime — whether it drives a persistent background process (e.g. the
//             wallpaper window) independent of whether its surface is open
export type SubmoduleSurface = "dialog" | "page" | "none";
export type SubmoduleRuntime = "background" | "none";
export type SubmoduleStatus = "disabled" | "running" | "paused" | "error";

export type Platform = "macos" | "windows" | "linux";

export interface SubmoduleAvailability {
  /** Only offered on these platforms; absent = all. */
  platforms?: Platform[];
  /** Tag as experimental in the launcher. */
  experimental?: boolean;
}

export interface SubmoduleDefinition {
  id: string;
  title: string;
  description: string;
  /** Emoji (MVP) or asset path. */
  icon: string;
  availability?: SubmoduleAvailability;
  surface: SubmoduleSurface;
  runtime: SubmoduleRuntime;
  /** Rendered for surface "dialog" (config) or "page". Receives onClose. */
  component?: ComponentType<{ onClose: () => void }>;
  /** Optional live status for the launcher tile's dot. */
  useStatus?: () => SubmoduleStatus;
}
