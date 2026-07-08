import assert from "node:assert/strict";
import { readFile as readFileP, writeFile as writeFileP, unlink as unlinkP } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function load() {
  const source = await readFileP(new URL("../src/lib/response-body-format.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  const tmp = new URL(`./.tmp-respfmt-${process.pid}.mjs`, import.meta.url);
  await writeFileP(tmp, outputText);
  try {
    return await import(tmp.href);
  } finally {
    await unlinkP(tmp);
  }
}
const { elideLargeStrings, MAX_DISPLAY_STRING_LEN, capRawBody, MAX_RAW_BODY_LEN } = await load();

test("short strings and non-strings pass through untouched", () => {
  assert.equal(elideLargeStrings("hello"), "hello");
  assert.equal(elideLargeStrings(42), 42);
  assert.equal(elideLargeStrings(true), true);
  assert.equal(elideLargeStrings(null), null);
});

test("a blob-sized string is elided with a head + size", () => {
  const big = "A".repeat(600 * 1024); // ~600KB base64-ish blob
  const out = elideLargeStrings(big);
  assert.notEqual(out, big);
  assert.ok(out.length < 200, "placeholder is short");
  assert.match(out, /elided/);
  assert.match(out, /KB|MB/, "shows size");
  assert.match(out, /starts: A+…/, "keeps an identifying head");
});

test("recurses into arrays and objects, eliding only oversized leaves", () => {
  const big = "x".repeat(MAX_DISPLAY_STRING_LEN + 1);
  const input = {
    ok: "small",
    image: big,
    articles: [{ title: "t", thumb: big }, { title: "u", thumb: "small" }],
    meta: { count: 2 },
  };
  const out = elideLargeStrings(input);
  assert.equal(out.ok, "small");
  assert.match(out.image, /elided/);
  assert.match(out.articles[0].thumb, /elided/);
  assert.equal(out.articles[1].thumb, "small");
  assert.equal(out.meta.count, 2);
  // original object is not mutated
  assert.equal(input.image.length, MAX_DISPLAY_STRING_LEN + 1);
});

test("exactly at the threshold is kept; one over is elided", () => {
  const atLimit = "y".repeat(MAX_DISPLAY_STRING_LEN);
  const over = "y".repeat(MAX_DISPLAY_STRING_LEN + 1);
  assert.equal(elideLargeStrings(atLimit), atLimit);
  assert.match(elideLargeStrings(over), /elided/);
});

test("capRawBody leaves small bodies alone and truncates huge non-JSON blobs", () => {
  assert.equal(capRawBody("small raw body"), "small raw body");
  const huge = "z".repeat(MAX_RAW_BODY_LEN + 5000);
  const out = capRawBody(huge);
  assert.ok(out.length < huge.length, "truncated");
  assert.match(out, /truncated — showing first \d+ KB of \d+ KB/);
  assert.ok(out.startsWith("z".repeat(100)), "keeps the head");
});
