import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { KnowledgeStore, GitTopologyStore, SourceStore, SourceSnapshotStore, searchKnowledge } from "../packages/knowledge-core/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "knowledge-universal-retrieval");

function readJson(name) {
  return JSON.parse(readFileSync(join(FIXTURE, name), "utf8"));
}

function collectFiles(root, prefix = "") {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) return collectFiles(join(root, entry.name), relative);
    return [relative];
  });
}

test("universal retrieval fixture contains every documented searchable needle", () => {
  const needles = readJson("needles.json");
  const files = new Set(collectFiles(FIXTURE));
  assert.ok(needles.length >= 7);
  for (const needle of needles) {
    assert.ok(files.has(needle.path), needle.id + " points at a missing fixture file");
    const content = readFileSync(join(FIXTURE, needle.path), "utf8");
    assert.ok(content.includes(needle.query), needle.id + " query is absent from its fixture");
    const actualLine = content.slice(0, content.indexOf(needle.query)).split("\n").length;
    assert.equal(actualLine, needle.line, needle.id + " line metadata must match the fixture");
  }
});

test("coverage expectations distinguish admitted source text from parser capability", () => {
  const expectations = readJson("coverage-expectations.json");
  const paths = new Set(collectFiles(FIXTURE));
  for (const expectation of expectations) {
    if (expectation.materialized) continue;
    assert.ok(paths.has(expectation.path), expectation.path + " is missing");
    assert.equal(expectation.status, "admitted");
    assert.notEqual(expectation.parser, "excluded");
  }
});

test("baseline fixture materializes encoding, line-ending, size, binary, and secret boundaries", () => {
  const temp = mkdtempSync(join(tmpdir(), "pk-universal-boundaries-"));
  const generated = join(temp, "generated");
  mkdirSync(generated);
  const expectations = readJson("coverage-expectations.json").filter((item) => item.materialized);
  writeFileSync(join(generated, "utf16le.txt"), Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("uniqueUtf16Needle\n", "utf16le"),
  ]));
  writeFileSync(join(generated, "crlf.txt"), "uniqueCrlfNeedle\r\nsecond line\r\n");
  writeFileSync(join(generated, "large.txt"), "large-needle\n".repeat(150000));
  writeFileSync(join(generated, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  writeFileSync(join(generated, ".env"), "SECRET_TOKEN=not-for-indexing\n");

  for (const expectation of expectations) {
    const file = join(temp, expectation.path);
    assert.equal(readFileSync(file).length > 0, true, expectation.path + " must materialize");
    if (expectation.parser === "binary") assert.equal(readFileSync(file).includes(0), true);
    if (expectation.parser === "secret") assert.equal(expectation.status, "excluded");
  }
  assert.match(readFileSync(join(generated, "utf16le.txt")).toString("utf16le"), /uniqueUtf16Needle/);
  assert.match(readFileSync(join(generated, "crlf.txt"), "utf8"), /\r\n/);
  assert.ok(readFileSync(join(generated, "large.txt")).length >= 1.5 * 1024 * 1024);
});

test("baseline proves full call-site text is retrieved by the source lane", () => {
  const temp = mkdtempSync(join(tmpdir(), "pk-universal-baseline-"));
  const store = KnowledgeStore.open({
    dbPath: join(temp, "knowledge.db"),
    ledgerPath: join(temp, "ledger.jsonl"),
  });
  try {
    const repoId = store.registerRepo({ name: "fixture", rootPath: temp });
    const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "baseline", repoId, parserVersion: "p", resolverVersion: "r", schemaVersion: 13 });
    const content = "const result = playerAdditionalDetailRepository.findAllByCpf(cpf);\n";
    const raw = Buffer.from(content);
    const hash = createHash("sha256").update(raw).digest("hex");
    const source = new SourceStore(store);
    const blob = source.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: content, encoding: "utf8" });
    const fact = source.putSourceFact({ repoId, filePath: "src/call-site.ts", factFingerprint: hash, contentHash: hash, sourceBlobId: blob, coverage: { status: "admitted", reasonCode: "text_searchable", classification: "source" } });
    const cow = new SourceSnapshotStore(store);
    cow.replaceOverlay(snapshot.id, [{ op: "add", path: "src/call-site.ts", sourceFactId: fact }]);
    cow.materializeManifest(snapshot.id);
    const result = searchKnowledge({ query: "playerAdditionalDetailRepository.findAllByCpf", mode: "exact", scope: { revisions: [{ repoId, snapshotId: snapshot.id }] }, page: { limit: 10 } }, { store, scopes: [{ repoId, snapshotId: snapshot.id }] });
    assert.ok(result.hits.some((hit) => hit.locator.filePath === "src/call-site.ts" && hit.lane === "source"));
  } finally {
    store.close();
  }
});
