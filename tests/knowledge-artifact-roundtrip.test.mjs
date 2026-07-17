import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { zipSync, strToU8 } from "../packages/knowledge-core/node_modules/fflate/esm/index.mjs";
import { KnowledgeStore, SourceStore, exportKnowledgeArtifact, importKnowledgeArtifact, restoreKnowledgeArtifact } from "../packages/knowledge-core/dist/index.js";

test("artifact export/import is checksummed and portable", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-artifact-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  store.registerRepo({ name: "fixture", rootPath: "/absolute/path/must-not-be-used" });
  const exported = exportKnowledgeArtifact(store, { includeSource: true });
  const imported = importKnowledgeArtifact(exported.bytes, exported.manifest.capabilityHash);
  assert.equal(imported.manifest.formatVersion, 1);
  assert.equal(imported.manifest.contentPolicy.includesSource, true);
  assert.ok(imported.database.byteLength > 0);
  store.close();
});

test("artifact content policy excludes source unless explicitly opted in", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-artifact-policy-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "policy-fixture", rootPath: "/policy" });
  const source = new SourceStore(store);
  source.putBlob({ contentHash: "policy-hash", rawBytes: Buffer.from("secret source"), decodedContent: "secret source", encoding: "utf8" });
  const withoutSource = importKnowledgeArtifact(exportKnowledgeArtifact(store).bytes);
  const withoutDbPath = join(dir, "without.sqlite");
  writeFileSync(withoutDbPath, withoutSource.database);
  const withoutStore = KnowledgeStore.open({ dbPath: withoutDbPath, ledgerPath: join(dir, "without-ledger.jsonl") });
  assert.equal(withoutStore.db.prepare("SELECT COUNT(*) AS n FROM source_blobs").get().n, 0);
  withoutStore.close();
  const withSource = importKnowledgeArtifact(exportKnowledgeArtifact(store, { includeSource: true }).bytes);
  const withDbPath = join(dir, "with.sqlite");
  writeFileSync(withDbPath, withSource.database);
  const withStore = KnowledgeStore.open({ dbPath: withDbPath, ledgerPath: join(dir, "with-ledger.jsonl") });
  assert.equal(withStore.db.prepare("SELECT COUNT(*) AS n FROM source_blobs").get().n, 1);
  withStore.close();
  assert.equal(repoId.length > 0, true);
  store.close();
});

test("artifact export can be restricted to an explicit repository scope", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-artifact-scope-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const keep = store.registerRepo({ name: "keep", rootPath: "/keep" });
  store.registerRepo({ name: "drop", rootPath: "/drop" });
  const imported = importKnowledgeArtifact(exportKnowledgeArtifact(store, { repoIds: [keep] }).bytes);
  const dbPath = join(dir, "scoped.sqlite");
  writeFileSync(dbPath, imported.database);
  const scoped = KnowledgeStore.open({ dbPath, ledgerPath: join(dir, "scoped-ledger.jsonl") });
  assert.deepEqual(scoped.db.prepare("SELECT name FROM repos ORDER BY name").all(), [{ name: "keep" }]);
  scoped.close();
  store.close();
});

test("artifact tamper and unsafe entry are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-artifact-tamper-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const exported = exportKnowledgeArtifact(store);
  const tampered = new Uint8Array([1, 2, 3, 4]);
  assert.throws(() => importKnowledgeArtifact(tampered), /ARTIFACT/);
  const unsafe = zipSync({ "../escape": strToU8("no"), "manifest.json": strToU8("{}"), "checksums.sha256": strToU8("") });
  assert.throws(() => importKnowledgeArtifact(unsafe), /ARTIFACT_PATH_UNSAFE/);
  store.close();
});

test("artifact import rejects incompatible schema or contract before opening the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-artifact-compat-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const artifact = exportKnowledgeArtifact(store);
  assert.throws(() => importKnowledgeArtifact(artifact.bytes, { expectedSchemaVersion: 999 }), /SCHEMA_VERSION_MISMATCH/);
  assert.throws(() => importKnowledgeArtifact(artifact.bytes, { expectedContractVersion: "999" }), /CONTRACT_VERSION_MISMATCH/);
  store.close();
});

test("artifact signature and encryption protect offline transport", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-artifact-secure-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const exported = exportKnowledgeArtifact(store, { signingKey: "signing-secret", encryptionKey: "encryption-secret" });
  assert.equal(exported.manifest.signature.algorithm, "hmac-sha256");
  assert.throws(() => importKnowledgeArtifact(exported.bytes, { signingKey: "wrong", encryptionKey: "encryption-secret" }), /SIGNATURE/);
  const imported = importKnowledgeArtifact(exported.bytes, { signingKey: "signing-secret", encryptionKey: "encryption-secret" });
  assert.equal(imported.manifest.encryption.envelope, "PKA2");
  store.close();
});

test("artifact supports optional Ed25519 signatures with embedded public key", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-artifact-ed25519-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" });
  const exported = exportKnowledgeArtifact(store, { signingPrivateKey: privateKey.toString() });
  assert.equal(exported.manifest.signature.algorithm, "ed25519");
  const imported = importKnowledgeArtifact(exported.bytes);
  assert.equal(imported.manifest.signature.algorithm, "ed25519");
  assert.throws(() => importKnowledgeArtifact(exported.bytes, { signingPublicKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString().replace("PUBLIC KEY", "WRONG KEY") }), /SIGNATURE/);
  store.close();
});

test("artifact restore validates a staging database and atomically preserves the previous file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-artifact-restore-"));
  const destination = join(dir, "knowledge.db");
  const store = KnowledgeStore.open({ dbPath: destination, ledgerPath: join(dir, "ledger.jsonl") });
  store.registerRepo({ name: "restored", rootPath: "/private/local/path" });
  const artifact = exportKnowledgeArtifact(store, { includeSource: true });
  store.close();
  const result = restoreKnowledgeArtifact(artifact.bytes, destination, { expectedCapabilityHash: artifact.manifest.capabilityHash, confirmed: true });
  assert.ok(result.backupPath && existsSync(result.backupPath));
  const restored = KnowledgeStore.open({ dbPath: destination, ledgerPath: join(dir, "restored-ledger.jsonl") });
  assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM repos WHERE name='restored'").get().n, 1);
  assert.equal(restored.db.prepare("SELECT root_path FROM repos WHERE name='restored'").get().root_path, "artifact://repo/" + restored.db.prepare("SELECT id FROM repos WHERE name='restored'").get().id);
  restored.close();
});

test("failed artifact restore leaves the current database unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-artifact-restore-failure-"));
  const destination = join(dir, "knowledge.db");
  const store = KnowledgeStore.open({ dbPath: destination, ledgerPath: join(dir, "ledger.jsonl") });
  store.registerRepo({ name: "must-survive", rootPath: "/keep" });
  store.close();
  assert.throws(() => restoreKnowledgeArtifact(new Uint8Array([1, 2, 3]), destination, { confirmed: true }), /ARTIFACT/);
  const after = KnowledgeStore.open({ dbPath: destination, ledgerPath: join(dir, "after-ledger.jsonl") });
  assert.equal(after.db.prepare("SELECT COUNT(*) AS n FROM repos WHERE name='must-survive'").get().n, 1);
  after.close();
});

test("artifact delta export reconstructs the target database from a verified base", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-artifact-delta-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const baseDatabase = importKnowledgeArtifact(exportKnowledgeArtifact(store).bytes).database;
  store.registerRepo({ name: "delta-target", rootPath: "/delta-target" });
  const targetDatabase = importKnowledgeArtifact(exportKnowledgeArtifact(store).bytes).database;
  const exported = exportKnowledgeArtifact(store, { baseDatabase, signingKey: "delta-signing-secret" });
  assert.equal(exported.manifest.delta.algorithm, "fixed-chunk-v1");
  const imported = importKnowledgeArtifact(exported.bytes, { baseDatabase, signingKey: "delta-signing-secret" });
  assert.deepEqual(Buffer.from(imported.database), Buffer.from(targetDatabase));
  assert.throws(() => importKnowledgeArtifact(exported.bytes, { baseDatabase: new Uint8Array([1, 2, 3]) }), /BASE_MISMATCH|SIGNATURE_KEY_REQUIRED/);
  store.close();
});
