import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, SourceStore } from "../packages/knowledge-core/dist/index.js";
import { buildLineIndex } from "../packages/knowledge-core/dist/line-index.js";
import { packLineIndex, readLineOffsets, lineEntry, lineAtChar, lineAtByte } from "../packages/knowledge-core/dist/line-offsets.js";

// source_blob_lines stored six integers plus a two-column primary key and a
// secondary index for every LINE of every indexed file: 5.3 GB of a 16 GB
// database. Both end offsets are derivable from the next line's start, so two
// packed uint32 arrays hold the same information at 8 bytes per line.
//
// The only thing that matters is that no answer changes. These tests compare
// the packed form against buildLineIndex — the definition both forms encode.

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-lines-"));
  return KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
}

function put(store, text) {
  const raw = Buffer.from(text, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  return new SourceStore(store).putBlob({ contentHash: hash, rawBytes: raw, decodedContent: text, encoding: "utf8" });
}

const SAMPLES = {
  "plain ascii": "const a = 1;\nconst b = 2;\nexport { a, b };\n",
  "no trailing newline": "line one\nline two\nline three",
  "single line": "just the one line",
  "empty lines between": "first\n\n\nfourth\n",
  // Multi-byte characters make char and byte offsets diverge, which is the
  // whole reason both arrays exist.
  "multibyte": "const 名前 = '日本語';\n// комментарий\nconst emoji = '👋🏽';\nend\n",
  "empty file": "",
};

test("the packed form reproduces buildLineIndex exactly", () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    const index = buildLineIndex(Buffer.from(text, "utf8"), text);
    const packed = packLineIndex(index);
    const offsets = {
      lineCount: packed.lineCount,
      totalChars: packed.totalChars,
      totalBytes: packed.totalBytes,
      startChars: new Uint32Array(new Uint8Array(packed.startChars).buffer.slice(0, packed.lineCount * 4)),
      startBytes: new Uint32Array(new Uint8Array(packed.startBytes).buffer.slice(0, packed.lineCount * 4)),
    };
    assert.equal(offsets.lineCount, index.lines.length, `${name}: line count`);
    for (const expected of index.lines) {
      assert.deepEqual(
        lineEntry(offsets, expected.line),
        expected,
        `${name}: line ${expected.line} must match the definition both forms encode`,
      );
    }
  }
});

test("stored offsets round-trip through the database", () => {
  const store = openStore();
  for (const [name, text] of Object.entries(SAMPLES)) {
    const blobId = put(store, text);
    const offsets = readLineOffsets(store, blobId);
    const expected = buildLineIndex(Buffer.from(text, "utf8"), text);
    if (text === "") {
      // One empty segment: a real line with zero length, not an absent index.
      assert.ok(offsets, `${name}: an empty file still has one line`);
    }
    assert.equal(offsets.lineCount, expected.lines.length, name);
    for (const line of expected.lines) assert.deepEqual(lineEntry(offsets, line.line), line, `${name} line ${line.line}`);
  }
  store.close();
});

test("offset lookup lands in the same line the old query would have", () => {
  const store = openStore();
  const text = SAMPLES.multibyte;
  const offsets = readLineOffsets(store, put(store, text));
  const expected = buildLineIndex(Buffer.from(text, "utf8"), text);

  // Every character offset in the file, checked against the line whose range
  // contains it — the exact predicate the old SQL used.
  for (let char = 0; char < text.length; char += 1) {
    const want = expected.lines.find((l) => l.startChar <= char && l.endChar >= char)
      ?? expected.lines.filter((l) => l.startChar <= char).at(-1);
    assert.equal(lineAtChar(offsets, char), want.line, `char ${char}`);
  }
  const bytes = Buffer.byteLength(text, "utf8");
  for (let byte = 0; byte < bytes; byte += 1) {
    // The old byte query took the last line starting at or before the offset.
    const want = expected.lines.filter((l) => l.startByte <= byte).at(-1);
    assert.equal(lineAtByte(offsets, byte), want.line, `byte ${byte}`);
  }
  store.close();
});

test("a line outside the file is reported as absent, not clamped", () => {
  const store = openStore();
  const offsets = readLineOffsets(store, put(store, SAMPLES["plain ascii"]));
  assert.equal(lineEntry(offsets, 0), null);
  assert.equal(lineEntry(offsets, offsets.lineCount + 1), null, "asking for line 900 of a 4-line file must not return line 4");
  assert.ok(lineEntry(offsets, offsets.lineCount), "the last line itself resolves");
  store.close();
});

test("one row per blob, not one per line", () => {
  const store = openStore();
  const text = Array.from({ length: 500 }, (_, i) => `const line${i} = ${i};`).join("\n");
  const blobId = put(store, text);
  const rows = store.db
    .prepare("SELECT COUNT(*) AS n FROM source_blob_line_offsets WHERE source_blob_id=?")
    .get(blobId).n;
  assert.equal(rows, 1, "500 lines must cost one row");
  const stored = store.db
    .prepare("SELECT LENGTH(start_chars) + LENGTH(start_bytes) AS bytes FROM source_blob_line_offsets WHERE source_blob_id=?")
    .get(blobId).bytes;
  assert.equal(stored, 500 * 8, "eight bytes a line, both arrays together");
  store.close();
});

test("an existing database converts its row-per-line index on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-lines-mig-"));
  const dbPath = join(dir, "k.db");
  const ledgerPath = join(dir, "l.jsonl");

  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const text = SAMPLES.multibyte;
  const blobId = put(store, text);
  const expected = buildLineIndex(Buffer.from(text, "utf8"), text);

  // Recreate the old shape from the packed one, then drop the packed table so
  // the database looks exactly like one written by the previous build.
  store.db.exec(`CREATE TABLE source_blob_lines (
    source_blob_id INTEGER NOT NULL, line_number INTEGER NOT NULL,
    start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL,
    start_char INTEGER NOT NULL, end_char INTEGER NOT NULL,
    PRIMARY KEY (source_blob_id, line_number))`);
  const insert = store.db.prepare("INSERT INTO source_blob_lines VALUES (?,?,?,?,?,?)");
  for (const l of expected.lines) insert.run(blobId, l.line, l.startByte, l.endByte, l.startChar, l.endChar);
  store.db.exec("DROP TABLE source_blob_line_offsets");
  store.close();

  const reopened = KnowledgeStore.open({ dbPath, ledgerPath });
  assert.equal(
    reopened.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_blob_lines'").get(),
    undefined,
    "the old table is gone",
  );
  const offsets = readLineOffsets(reopened, blobId);
  assert.equal(offsets.lineCount, expected.lines.length);
  for (const line of expected.lines) {
    assert.deepEqual(lineEntry(offsets, line.line), line, `converted line ${line.line} must be identical`);
  }
  reopened.close();
});
