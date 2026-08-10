import type { SubmoduleDefinition, SubmoduleStatus } from "../types";
import { WallpaperConfig } from "./WallpaperConfig";
import { useWallpaperStatus } from "./useWallpaperStatus";

export const wallpaperSubmodule: SubmoduleDefinition = {
  id: "wallpaper",
  title: "Live Wallpaper",
  description: "Animated desktop wallpaper (web / video) behind your icons.",
  icon: "🎨",
  availability: { platforms: ["macos"], experimental: true },
  surface: "page",
  runtime: "background",
  component: WallpaperConfig,
  useStatus: (): SubmoduleStatus => {
    const state = useWallpaperStatus().state;
    return state === "running" ? "running" : state === "error" ? "error" : "disabled";
  },
};
