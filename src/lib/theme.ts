export type AppTheme =
  | "dark"
  | "light"
  | "nord"
  | "emerald"
  | "rose"
  | "violet"
  | "antarctic-snow"
  | "penguin"
  | "duck";

export const THEMES = [
  { id: "dark" as const, label: "Dark", color: "oklch(0.25 0.02 260)" },
  { id: "light" as const, label: "Light", color: "oklch(0.98 0.01 260)" },
  { id: "nord" as const, label: "Nord", color: "oklch(0.55 0.08 220)" },
  { id: "emerald" as const, label: "Emerald", color: "oklch(0.55 0.12 160)" },
  { id: "rose" as const, label: "Rose", color: "oklch(0.65 0.15 10)" },
  { id: "violet" as const, label: "Violet", color: "oklch(0.55 0.2 290)" },
  { id: "antarctic-snow" as const, label: "Antarctic Snow", color: "oklch(0.94 0.035 210)" },
  { id: "penguin" as const, label: "Penguin", color: "oklch(0.72 0.15 65)" },
  { id: "duck" as const, label: "Duck", color: "oklch(0.82 0.15 90)" },
] as const;

const THEME_IDS = new Set<AppTheme>(THEMES.map((theme) => theme.id));

export function isAppTheme(value: string): value is AppTheme {
  return THEME_IDS.has(value as AppTheme);
}

export function isLightAppTheme(
  value: string | null | undefined,
): value is "light" | "antarctic-snow" | "penguin" | "duck" {
  return value === "light" || value === "antarctic-snow" || value === "penguin" || value === "duck";
}
