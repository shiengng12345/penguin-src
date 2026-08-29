import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, SourceStore, openDatabase } from "../packages/knowledge-core/dist/index.js";

// source_blobs stored raw_bytes AND decoded_content for every file. For UTF-8 —
// 32,860 of 32,862 blobs in the real index — the bytes ARE the decoded text
// re-encoded, so every source file was in the database twice: 3.49 GB of exact
// duplication. raw_bytes has one reader, the content-hash collision check.

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-blob-"));
  return { dir, store: KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") }) };
}

function put(store, text, encoding = "utf8", rawOverride) {
  const raw = rawOverride ?? Buffer.from(text, "utf8");
  const hash = createHash("sha256").update(raw).digest("hex");
  return {
    id: new SourceStore(store).putBlob({ contentHash: hash, rawBytes: raw, decodedContent: text, encoding }),
    hash,
    raw,
  };
}

const rawOf = (store, id) =>
  store.db.prepare("SELECT raw_bytes FROM source_blobs WHERE id=?").get(id).raw_bytes;

test("a UTF-8 blob stores its bytes once", () => {
  const { store } = openStore();
  const text = "export function alpha() { return 1; }\n";
  const { id } = put(store, text);
  assert.equal(rawOf(store, id), null, "the redundant copy must not be written");
  const back = store.db.prepare("SELECT decoded_content AS c, byte_size AS n FROM source_blobs WHERE id=?").get(id);
  assert.equal(back.c, text, "the content itself is untouched");
  assert.equal(back.n, Buffer.byteLength(text, "utf8"), "and byte_size still describes the original");
  store.close();
});

test("non-UTF-8 content keeps its original bytes", () => {
  // A lossy or non-round-tripping decode is the case the column exists for.
  const { store } = openStore();
  const raw = Buffer.from([0x00, 0x65, 0x00, 0x66]); // utf16be "ef"
  const { id } = put(store, "ef", "utf16be", raw);
  assert.ok(rawOf(store, id), "bytes that cannot be re-derived must be preserved");
  assert.ok(Buffer.from(rawOf(store, id)).equals(raw));
  store.close();
});

test("a utf8-labelled blob that does not round-trip keeps its bytes", () => {
  // The check is per blob, not a guess from the encoding name: an invalid
  // sequence labelled utf8 would otherwise be silently rewritten on read.
  const { store } = openStore();
  const raw = Buffer.from([0x61, 0xff, 0x62]); // 0xff is not valid UTF-8
  const { id } = put(store, raw.toString("utf8"), "utf8", raw);
  assert.ok(rawOf(store, id), "a decode that does not reproduce the bytes must keep them");
  store.close();
});

test("the collision check still catches different content under one hash", () => {
  // This is raw_bytes' only reader; it has to keep working when the column is
  // null, by comparing the re-derived bytes.
  const { store } = openStore();
  const { hash } = put(store, "the original\n");
  const different = Buffer.from("something else entirely\n", "utf8");
  assert.throws(
    () => new SourceStore(store).putBlob({
      contentHash: hash, rawBytes: different, decodedContent: different.toString("utf8"), encoding: "utf8",
    }),
    /CONTENT_HASH_COLLISION/,
    "a hash reused for different bytes must still be rejected",
  );
  store.close();
});

test("re-putting identical content is still a no-op returning the same id", () => {
  const { store } = openStore();
  const text = "export const same = 1;\n";
  const first = put(store, text);
  const second = put(store, text);
  assert.equal(second.id, first.id, "identical content deduplicates as before");
  store.close();
});

test("an existing database drops the duplicate copy when reopened", () => {
  // The migration path: a database written by the old build carries both, and
  // must shed the redundant half in place rather than needing a rebuild.
  const dir = mkdtempSync(join(tmpdir(), "pk-blob-mig-"));
  const dbPath = join(dir, "k.db");
  const ledgerPath = join(dir, "l.jsonl");

  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const text = "export function legacy() { return 1; }\n";
  const { id } = put(store, text);
  const utf16 = Buffer.from([0x00, 0x67]);
  const kept = put(store, "g", "utf16be", utf16);
  // Rebuild the table in the OLD shape — NOT NULL, both copies present — so the
  // migration has the real thing to work on rather than a half-simulated state.
  store.db.exec("ALTER TABLE source_blobs RENAME TO legacy_blobs");
  store.db.exec(`CREATE TABLE source_blobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, content_hash TEXT NOT NULL UNIQUE,
    byte_size INTEGER NOT NULL, encoding TEXT NOT NULL, raw_bytes BLOB NOT NULL,
    decoded_content TEXT NOT NULL, created_at TEXT NOT NULL)`);
  store.db.exec(`INSERT INTO source_blobs
    SELECT id, content_hash, byte_size, encoding,
           COALESCE(raw_bytes, CAST(decoded_content AS BLOB)), decoded_content, created_at
      FROM legacy_blobs`);
  store.db.exec("DROP TABLE legacy_blobs");
  assert.ok(rawOf(store, id), "precondition: the duplicate is present");
  store.close();

  const reopened = KnowledgeStore.open({ dbPath, ledgerPath });
  assert.equal(rawOf(reopened, id), null, "the redundant copy is gone");
  assert.equal(
    reopened.db.prepare("SELECT decoded_content AS c FROM source_blobs WHERE id=?").get(id).c,
    text,
    "and the content survived intact",
  );
  assert.ok(rawOf(reopened, kept.id), "while genuinely irreducible bytes stayed");
  reopened.close();
});

test("a fresh database declares the column nullable", () => {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "pk-blob-schema-")), "k.db"));
  const column = db.prepare("PRAGMA table_info(source_blobs)").all().find((c) => c.name === "raw_bytes");
  assert.equal(column.notnull, 0, "NOT NULL would force the duplicate back on every new index");
  db.close();
});
