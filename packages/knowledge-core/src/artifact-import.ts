import { unzipSync, strFromU8 } from "fflate";
import { createHash, createDecipheriv, createHmac, createPublicKey, scryptSync, timingSafeEqual, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import type { KnowledgeArtifactManifest } from "./artifact-manifest.js";
import { KnowledgeStore } from "./store.js";
import { tmpdir } from "node:os";
function sha(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function legacyKey(passphrase: string): Buffer { return createHash("sha256").update(passphrase).digest(); }
function scryptKey(passphrase: string, salt: Uint8Array): Buffer {
  return scryptSync(passphrase, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}
export interface ArtifactImportResult { manifest: KnowledgeArtifactManifest; database: Uint8Array; }
export function importKnowledgeArtifact(bytes: Uint8Array, expectedCapabilityHashOrOptions?: string | { expectedCapabilityHash?: string; expectedSchemaVersion?: number; expectedContractVersion?: string; signingKey?: string; signingPublicKey?: string; encryptionKey?: string; baseDatabase?: Uint8Array }): ArtifactImportResult {
  const options = typeof expectedCapabilityHashOrOptions === "string" ? { expectedCapabilityHash: expectedCapabilityHashOrOptions } : (expectedCapabilityHashOrOptions ?? {});
  const magic = Buffer.from(bytes).subarray(0, 4).toString();
  if (magic === "PKA1" || magic === "PKA2") {
    if (!options.encryptionKey || bytes.byteLength < 32) throw new Error("ARTIFACT_ENCRYPTION_KEY_REQUIRED");
    try {
      const raw = Buffer.from(bytes);
      const salt = magic === "PKA2" ? raw.subarray(4, 20) : null;
      const ivStart = magic === "PKA2" ? 20 : 4;
      const tagStart = magic === "PKA2" ? 32 : 16;
      const dataStart = magic === "PKA2" ? 48 : 32;
      const decipher = createDecipheriv("aes-256-gcm", salt ? scryptKey(options.encryptionKey, salt) : legacyKey(options.encryptionKey), raw.subarray(ivStart, tagStart));
      decipher.setAuthTag(raw.subarray(tagStart, dataStart));
      bytes = new Uint8Array(Buffer.concat([decipher.update(raw.subarray(dataStart)), decipher.final()]));
    } catch { throw new Error("ARTIFACT_DECRYPT_FAILED"); }
  }
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); } catch { throw new Error("ARTIFACT_INVALID"); }
  for (const path of Object.keys(files)) if (!path || path.startsWith("/") || path.split("/").includes("..") || path.includes("\\")) throw new Error("ARTIFACT_PATH_UNSAFE");
  if (!files["manifest.json"] || !files["checksums.sha256"]) throw new Error("ARTIFACT_INCOMPLETE");
  const manifest = JSON.parse(strFromU8(files["manifest.json"])) as KnowledgeArtifactManifest;
  if (manifest.formatVersion !== 1) throw new Error("ARTIFACT_VERSION_UNSUPPORTED");
  if (options.expectedCapabilityHash && manifest.capabilityHash !== options.expectedCapabilityHash) throw new Error("CAPABILITY_MISMATCH");
  if ("expectedSchemaVersion" in options && options.expectedSchemaVersion !== undefined && manifest.schemaVersion !== options.expectedSchemaVersion) throw new Error("SCHEMA_VERSION_MISMATCH");
  if ("expectedContractVersion" in options && options.expectedContractVersion !== undefined && manifest.contractVersion !== options.expectedContractVersion) throw new Error("CONTRACT_VERSION_MISMATCH");
  for (const line of strFromU8(files["checksums.sha256"]).trim().split("\n")) { const [expected, ...pathParts] = line.trim().split(/\s+/); const path = pathParts.join(" "); if (!files[path] || sha(files[path]) !== expected) throw new Error("ARTIFACT_CHECKSUM_MISMATCH"); }
  let database = files["database/knowledge.sqlite"];
  if (!database && files["database/knowledge.sqlite.delta.json"]) {
    if (!options.baseDatabase) throw new Error("ARTIFACT_BASE_DATABASE_REQUIRED");
    if (!manifest.baseArtifactHash || sha(options.baseDatabase) !== manifest.baseArtifactHash) throw new Error("ARTIFACT_BASE_MISMATCH");
    let delta: { algorithm: string; chunkSize: number; size: number; chunks: Array<{ offset: number; data: string }> };
    try { delta = JSON.parse(strFromU8(files["database/knowledge.sqlite.delta.json"])); } catch { throw new Error("ARTIFACT_DELTA_INVALID"); }
    if (delta.algorithm !== "fixed-chunk-v1" || delta.chunkSize <= 0 || !Number.isInteger(delta.size) || !Array.isArray(delta.chunks)) throw new Error("ARTIFACT_DELTA_INVALID");
    database = new Uint8Array(delta.size);
    database.set(options.baseDatabase.slice(0, delta.size));
    for (const chunk of delta.chunks) {
      if (!Number.isInteger(chunk.offset) || chunk.offset < 0 || chunk.offset >= delta.size || typeof chunk.data !== "string") throw new Error("ARTIFACT_DELTA_INVALID");
      const data = Buffer.from(chunk.data, "base64");
      if (chunk.offset + data.byteLength > delta.size || data.byteLength > delta.chunkSize) throw new Error("ARTIFACT_DELTA_INVALID");
      database.set(data, chunk.offset);
    }
  }
  if (!database) throw new Error("ARTIFACT_INCOMPLETE");
  if (manifest.signature) {
    if (manifest.signature.algorithm === "ed25519") {
      const publicKey = options.signingPublicKey ?? manifest.signature.publicKey;
      if (!publicKey) throw new Error("ARTIFACT_SIGNATURE_KEY_REQUIRED");
      const unsigned = { ...manifest }; delete unsigned.signature;
      const payload = Buffer.from(`${JSON.stringify(unsigned)}\n${sha(database)}`, "utf8");
      try {
        const key = createPublicKey(publicKey.includes("BEGIN") ? publicKey : { key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
        if (!verify(null, payload, key, Buffer.from(manifest.signature.value, "base64"))) throw new Error("invalid");
      } catch { throw new Error("ARTIFACT_SIGNATURE_INVALID"); }
    } else {
      if (!options.signingKey) throw new Error("ARTIFACT_SIGNATURE_KEY_REQUIRED");
      const unsigned = { ...manifest }; delete unsigned.signature;
      const expected = createHmac("sha256", options.signingKey).update(JSON.stringify(unsigned)).update(sha(database)).digest("hex");
      if (expected.length !== manifest.signature.value.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(manifest.signature.value))) throw new Error("ARTIFACT_SIGNATURE_INVALID");
    }
  }
  return { manifest, database };
}

/** Restore only after the caller has explicitly confirmed the destination.
 * The existing database is moved aside first; a failed write cannot silently
 * destroy the previous store. The caller must run `penguin doctor` afterwards. */
export function restoreKnowledgeArtifact(bytes: Uint8Array, destination: string, options: { expectedCapabilityHash?: string; signingKey?: string; encryptionKey?: string; baseDatabase?: Uint8Array; confirmed: boolean }): { manifest: KnowledgeArtifactManifest; backupPath?: string } {
  if (!options.confirmed) throw new Error("ARTIFACT_RESTORE_CONFIRMATION_REQUIRED");
  const imported = importKnowledgeArtifact(bytes, options);
  mkdirSync(dirname(destination), { recursive: true });
  const stagingDir = mkdtempSync(join(dirname(destination), ".penguin-artifact-restore-"));
  const stagingPath = join(stagingDir, "knowledge.db");
  try {
    writeFileSync(stagingPath, imported.database, { flag: "wx", mode: 0o600 });
    const stagingStore = KnowledgeStore.open({ dbPath: stagingPath, ledgerPath: join(stagingDir, "ledger.jsonl") });
    const integrity = stagingStore.db.pragma("integrity_check", { simple: true }) as string;
    stagingStore.db.pragma("wal_checkpoint(TRUNCATE)");
    stagingStore.close();
    if (integrity !== "ok") throw new Error(`ARTIFACT_RESTORE_INTEGRITY_FAILED:${integrity}`);
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
  const backupPath = existsSync(destination) ? `${destination}.before-restore-${Date.now()}` : undefined;
  if (backupPath) renameSync(destination, backupPath);
  try {
    renameSync(stagingPath, destination);
    rmSync(stagingDir, { recursive: true, force: true });
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    if (backupPath) renameSync(backupPath, destination);
    throw error;
  }
  return { manifest: imported.manifest, ...(backupPath ? { backupPath } : {}) };
}
