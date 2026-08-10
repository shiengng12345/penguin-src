import type { SubmoduleDefinition } from "../types";
import { WallpaperConfig } from "./WallpaperConfig";

export const wallpaperSubmodule: SubmoduleDefinition = {
  id: "wallpaper",
  title: "Live Wallpaper",
  description: "Animated desktop wallpaper (web / video) behind your icons.",
  icon: "🎨",
  availability: { platforms: ["macos"], experimental: true },
  surface: "page",
  runtime: "background",
  component: WallpaperConfig,
};
