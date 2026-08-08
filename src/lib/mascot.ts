import type { AppTheme } from "./theme";

// Map a default (penguin) mascot asset path to the active theme's variant.
// Only the "duck" theme ships an alternate illustration set today; every other
// theme keeps the penguin art. Paths that have no known variant pass through
// unchanged, and a missing variant file falls back to the penguin original at
// the <img> level (see ThemedMascotImg), so this never breaks the UI.
export function themedMascot(penguinPath: string, theme: AppTheme): string {
  if (theme !== "duck") return penguinPath;
  if (penguinPath === "/penguin.png") return "/duck.png";
  if (penguinPath.startsWith("/mascot/penguin/")) {
    return penguinPath.replace("/mascot/penguin/", "/mascot/duck/");
  }
  if (penguinPath.startsWith("/nav/") && !penguinPath.startsWith("/nav/duck/")) {
    return penguinPath.replace("/nav/", "/nav/duck/");
  }
  return penguinPath;
}
