// Merges a caller-supplied `DataTable` `rowProps(row)` result onto the
// component's own row attributes. Kept in its own module (alongside
// data-table-status.tsx / data-table-pagination.tsx / data-table-types.ts)
// so data-table.tsx itself stays under this repo's file-size budget.
//
// Merge policy (deliberate, not incidental — this is the seam Task 17's
// review asked for after ConnectionTable found DataTable's row markup had no
// way to carry a per-row attribute like `aria-current`):
//
//  - `role` always wins from the base (component-owned) side. A caller can
//    decorate a row — `aria-current`, `aria-expanded`, `data-*`, a click
//    handler — but must never be able to turn a table row into something
//    other than a row; that would silently break every consumer that reads
//    this tree via `getByRole("row", ...)`.
//  - `className` is concatenated with `cn` (clsx + tailwind-merge), so a
//    caller's utility class wins over the component's own for the same
//    Tailwind property, but neither side's classes are dropped wholesale —
//    both are present unless they genuinely conflict on the same property.
//  - `style` is shallow-merged, caller's keys applied last so a caller can
//    override an individual declaration. This element only ever carries
//    flex/border layout styles today; the virtualiser's absolute-positioning
//    styles (`position`, `top`, `left`, `transform`) live one level up, on
//    the wrapper `rowProps` has no access to at all — so a caller can never
//    break virtualisation through this seam, even by returning a
//    deliberately conflicting `style`.
//  - Any other attribute present on both sides where both values are
//    functions (a future built-in `onClick`, for instance) is composed —
//    the base's handler fires first, then the caller's — rather than one
//    silently replacing the other. Every other caller-supplied attribute
//    (`aria-current`, `data-*`, event handlers with no built-in
//    counterpart, …) is added as-is.
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function mergeRowProps<T extends HTMLElement>(
  base: HTMLAttributes<T>,
  extra?: HTMLAttributes<T>,
): HTMLAttributes<T> {
  if (!extra) return base;

  const merged: Record<string, unknown> = { ...base, ...extra };

  merged.role = base.role;
  merged.className = cn(base.className, extra.className);
  if (base.style || extra.style) {
    merged.style = { ...base.style, ...extra.style };
  }

  for (const key of Object.keys(base)) {
    const baseValue = (base as Record<string, unknown>)[key];
    const extraValue = (extra as Record<string, unknown>)[key];
    if (typeof baseValue === "function" && typeof extraValue === "function") {
      merged[key] = (...args: unknown[]) => {
        (baseValue as (...callArgs: unknown[]) => void)(...args);
        (extraValue as (...callArgs: unknown[]) => void)(...args);
      };
    }
  }

  return merged as HTMLAttributes<T>;
}
