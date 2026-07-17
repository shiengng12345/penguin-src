import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { decodeTextFileStream, hashFileStream } from "../packages/knowledge-indexer/dist/encoding.js";

test("streaming hash and decoder match byte/hash truth for UTF-8 and UTF-16", async () => {
  const root = await mkdtemp(join(tmpdir(), "penguin-stream-"));
  const cases = [
    ["utf8.txt", Buffer.from("first\nneedle\nlast", "utf8"), "utf8"],
    ["utf16le.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("needle", "utf16le")]), "utf16le"],
    ["utf16be.txt", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("needle", "utf16le").swap16()]), "utf16be"],
  ];
  for (const [name, bytes, encoding] of cases) {
    const path = join(root, name);
    await writeFile(path, bytes);
    const result = await hashFileStream(path);
    assert.equal(result.byteSize, bytes.byteLength);
    assert.equal(result.contentHash, createHash("sha256").update(bytes).digest("hex"));
    const decoded = await decodeTextFileStream(path);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.encoding, encoding);
    assert.match(decoded.text, /needle|first/);
  }
});

test("streaming decoder fails closed on invalid UTF-8", async () => {
  const root = await mkdtemp(join(tmpdir(), "penguin-stream-invalid-"));
  const path = join(root, "invalid.txt");
  await writeFile(path, Buffer.from([0xc3, 0x28]));
  assert.deepEqual(await decodeTextFileStream(path), { ok: false, reason: "unsupported_encoding" });
});
