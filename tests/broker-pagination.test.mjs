import assert from "node:assert/strict";
import { test } from "node:test";
import { paginate } from "@penguin/broker-core";

const items = Array.from({ length: 250 }, (_, i) => ({ name: `topic-${String(i).padStart(3, "0")}`, size: i }));
const searchOf = (t) => t.name;
const sortOf = (t, key) => (key === "size" ? t.size : t.name);

test("returns one page and the true total", () => {
  // Admin REST hands us everything at once; the page boundary is ours to draw.
  const page = paginate(items, { offset: 0, limit: 25 }, searchOf, sortOf);
  assert.equal(page.items.length, 25);
  assert.equal(page.total, 250);
  assert.equal(page.offset, 0);
});

test("offset walks the list", () => {
  const page = paginate(items, { offset: 240, limit: 25 }, searchOf, sortOf);
  assert.equal(page.items.length, 10, "last page is short, not padded");
  assert.equal(page.items[0].name, "topic-240");
});

test("search narrows before paging, and total reflects the filtered set", () => {
  const page = paginate(items, { offset: 0, limit: 25, search: "topic-01" }, searchOf, sortOf);
  assert.equal(page.total, 10, "topic-010..019");
  assert.ok(page.items.every((t) => t.name.includes("topic-01")));
});

test("search is case-insensitive", () => {
  const page = paginate(items, { offset: 0, limit: 5, search: "TOPIC-1" }, searchOf, sortOf);
  assert.ok(page.total > 0);
});

test("sorting applies before paging", () => {
  const page = paginate(items, { offset: 0, limit: 3, sortBy: "size", sortDir: "desc" }, searchOf, sortOf);
  assert.deepEqual(page.items.map((t) => t.size), [249, 248, 247]);
});

test("an offset past the end yields an empty page, not a crash", () => {
  const page = paginate(items, { offset: 9999, limit: 25 }, searchOf, sortOf);
  assert.deepEqual(page.items, []);
  assert.equal(page.total, 250);
});

test("an empty source yields an empty page", () => {
  const page = paginate([], { offset: 0, limit: 25 }, searchOf, sortOf);
  assert.deepEqual(page.items, []);
  assert.equal(page.total, 0);
});

test("a zero or negative limit is clamped up to 1, not thrown", () => {
  const zero = paginate(items, { offset: 0, limit: 0 }, searchOf, sortOf);
  assert.equal(zero.limit, 1);
  assert.equal(zero.items.length, 1);

  const negative = paginate(items, { offset: 0, limit: -5 }, searchOf, sortOf);
  assert.equal(negative.limit, 1);
  assert.equal(negative.items.length, 1);
});
