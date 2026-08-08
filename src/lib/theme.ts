export type AppTheme =
  | "dark"
  | "light"
  | "penguin"
  | "duck"
  | "cat"
  | "black-cat"
  | "hamster"
  | "rabbit";

export const THEMES = [
  { id: "dark" as const, label: "Dark", color: "oklch(0.25 0.02 260)" },
  { id: "light" as const, label: "Light", color: "oklch(0.98 0.01 260)" },
  { id: "penguin" as const, label: "Penguin", color: "oklch(0.72 0.15 65)" },
  { id: "duck" as const, label: "Duck", color: "oklch(0.82 0.15 90)" },
  { id: "cat" as const, label: "Cat", color: "oklch(0.78 0.13 15)" },
  { id: "black-cat" as const, label: "Black Cat", color: "oklch(0.4 0.015 280)" },
  { id: "hamster" as const, label: "Hamster", color: "oklch(0.75 0.12 70)" },
  { id: "rabbit" as const, label: "Rabbit", color: "oklch(0.8 0.09 8)" },
] as const;

const THEME_IDS = new Set<AppTheme>(THEMES.map((theme) => theme.id));

export function isAppTheme(value: string): value is AppTheme {
  return THEME_IDS.has(value as AppTheme);
}

export function isLightAppTheme(
  value: string | null | undefined,
): value is "light" | "penguin" | "duck" | "cat" | "black-cat" | "hamster" | "rabbit" {
  return (
    value === "light" ||
    value === "penguin" ||
    value === "duck" ||
    value === "cat" ||
    value === "black-cat" ||
    value === "hamster" ||
    value === "rabbit"
  );
}
