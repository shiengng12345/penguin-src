import type { SubmoduleDefinition } from "./types";
import { wallpaperSubmodule } from "./wallpaper";

// Compile-time registry of Extras submodules. Adding one = one folder under
// src/submodules/ + one entry here. Intentionally a plain typed array — not a
// plugin system / dynamic loader.
export const submodules: SubmoduleDefinition[] = [wallpaperSubmodule];
