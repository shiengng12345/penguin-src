import assert from "node:assert/strict";
import { readFile as readFileP, writeFile as writeFileP, unlink as unlinkP } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function load() {
  const source = await readFileP(new URL("../src/lib/note-autocomplete.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  const tmp = new URL(`./.tmp-noteac-${process.pid}.mjs`, import.meta.url);
  await writeFileP(tmp, outputText);
  try {
    return await import(tmp.href);
  } finally {
    await unlinkP(tmp);
  }
}
const { noteCompletionTrigger } = await load();

test("detects a [[ wikilink trigger and the partial query + from offset", () => {
  const r = noteCompletionTrigger("see [[Log");
  assert.deepEqual(r, { kind: "wikilink", query: "Log", from: 6 }); // 'L' starts at index 6
});

test("bare [[ triggers with empty query", () => {
  assert.deepEqual(noteCompletionTrigger("[["), { kind: "wikilink", query: "", from: 2 });
});

test("detects a # tag trigger at a word boundary", () => {
  assert.deepEqual(noteCompletionTrigger("todo #brazil"), { kind: "tag", query: "brazil", from: 6 });
  assert.equal(noteCompletionTrigger("#top").kind, "tag"); // start of line
});

test("closed [[link]] is not a trigger", () => {
  assert.equal(noteCompletionTrigger("[[Done]] then"), null);
});

test("no trigger in plain text", () => {
  assert.equal(noteCompletionTrigger("just some words"), null);
});

test("[[ does not cross a newline", () => {
  // the [[ on the current line triggers; a stray ] earlier is fine
  assert.deepEqual(noteCompletionTrigger("prev line\n[[Foo"), { kind: "wikilink", query: "Foo", from: 12 });
  // an unclosed [[ on a PREVIOUS line does not leak past the newline
  assert.equal(noteCompletionTrigger("[[open\nnext"), null);
});
