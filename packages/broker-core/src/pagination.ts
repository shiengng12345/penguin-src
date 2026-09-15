// packages/broker-core/src/pagination.ts
import type { Page, PageQuery } from "@penguin/broker-contracts";

/**
 * Pagination lives here because Pulsar's Admin REST ignores `page` / `size`
 * entirely and always returns the full array (spec V-A5). Filter, then sort,
 * then slice — `total` must describe the filtered set or the UI's page count lies:
 * if `total` reflected the unfiltered source, the UI would compute page counts
 * from the wrong denominator and offer pages that, after filtering, do not exist.
 */
export function paginate<T>(
  items: T[],
  query: PageQuery,
  searchOf: (item: T) => string,
  sortOf: (item: T, key: string) => string | number,
): Page<T> {
  let working = items;

  if (query.search && query.search.trim() !== "") {
    const needle = query.search.trim().toLowerCase();
    working = working.filter((item) => searchOf(item).toLowerCase().includes(needle));
  }

  if (query.sortBy) {
    const key = query.sortBy;
    const dir = query.sortDir === "desc" ? -1 : 1;
    // Rust port: `av < bv` here relies on JS's implicit coercion rule for `<`
    // between two `string | number` values (same-typed operands compare
    // naturally; mixed types coerce to number). Rust has no such coercion —
    // `sortOf` always returns one variant per call site in practice, but the
    // port must match on the enum/variant explicitly and compare within it.
    // Also relies on `Array.prototype.sort`'s stability guarantee (ES2019+):
    // equal-key items keep their relative order. Rust must use `sort_by`,
    // not `sort_unstable_by`, to preserve the same guarantee.
    working = [...working].sort((a, b) => {
      const av = sortOf(a, key);
      const bv = sortOf(b, key);
      if (av === bv) return 0;
      return (av < bv ? -1 : 1) * dir;
    });
  }

  const offset = Math.max(0, query.offset);
  // A zero or negative limit is clamped up to 1 rather than thrown: this is a
  // read-only list endpoint, so a malformed query should degrade to "the
  // smallest sensible page" instead of failing the whole request. The Rust
  // port must clamp the same way, not return an error, to keep behaviour
  // identical across both implementations.
  const limit = Math.max(1, query.limit);
  return {
    items: working.slice(offset, offset + limit),
    total: working.length,
    offset,
    limit,
  };
}
