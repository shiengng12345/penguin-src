import type { AppTheme } from "./theme";

// Themes that ship their own illustration set (mirroring the penguin default).
// Add a theme id here + drop its art under public/{id}.png, public/mascot/{id}/,
// public/nav/{id}/ and it swaps automatically.
const MASCOT_THEMES = new Set<AppTheme>(["duck", "cat", "black-cat", "hamster", "rabbit"]);

// Map a default (penguin) mascot asset path to the active theme's variant.
// Themes without an alternate set keep the penguin art. A missing variant file
// falls back to the penguin original at the <img> level (see ThemedMascotImg),
// so this never breaks the UI.
export function themedMascot(penguinPath: string, theme: AppTheme): string {
  if (!MASCOT_THEMES.has(theme)) return penguinPath;
  if (penguinPath === "/penguin.png") return `/${theme}.png`;
  if (penguinPath.startsWith("/mascot/penguin/")) {
    return penguinPath.replace("/mascot/penguin/", `/mascot/${theme}/`);
  }
  if (penguinPath.startsWith("/nav/")) {
    return penguinPath.replace("/nav/", `/nav/${theme}/`);
  }
  return penguinPath;
}
