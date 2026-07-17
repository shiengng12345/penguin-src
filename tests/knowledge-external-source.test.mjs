import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, ExternalSourceStore, searchKnowledge, syncRemoteSource, validateExternalLocation } from "../packages/knowledge-core/dist/index.js";

test("external knowledge sources are explicit and SSRF guarded", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-external-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  assert.throws(() => validateExternalLocation("url", "http://example.com/a"), /HTTPS/);
  assert.throws(() => validateExternalLocation("url", "https://127.0.0.1/a"), /SSRF/);
  assert.throws(() => validateExternalLocation("url", "https://[::1]/a"), /SSRF/);
  const sources = new ExternalSourceStore(store);
  const source = sources.register({ type: "url", location: "https://docs.example.com/api", config: { license: "review" }, allowHosts: ["docs.example.com"] });
  assert.equal(sources.list()[0].status, "registered");
  assert.deepEqual(sources.list()[0].config.allowHosts, ["docs.example.com"]);
  assert.equal(sources.markSynced(source.id, { content: "untrusted docs", finalUrl: "https://docs.example.com/api" }).status, "synced");
  sources.remove(source.id);
  assert.equal(sources.list().length, 0);
  store.close();
});

test("markdown directory sources can sync into the shared index", async () => {
  const root = mkdtempSync(join(tmpdir(), "pk-external-vault-"));
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested", "guide.md"), "# Deployment\nUse the staging checklist.\n");
  const dbDir = mkdtempSync(join(tmpdir(), "pk-external-sync-"));
  const store = KnowledgeStore.open({ dbPath: join(dbDir, "knowledge.db"), ledgerPath: join(dbDir, "ledger.jsonl") });
  const source = new ExternalSourceStore(store).register({ type: "markdown_directory", location: root });
  store.close();
  const { runCli } = await import("../packages/knowledge-cli/dist/index.js");
  const output = [];
  const deps = { cwd: root, out: (line) => output.push(line), err: (line) => output.push(line), openStore: () => KnowledgeStore.open({ dbPath: join(dbDir, "knowledge.db"), ledgerPath: join(dbDir, "ledger.jsonl") }), storeExists: () => true };
  assert.equal(await runCli(["source", "sync", source.id, "--json"], deps), 0);
  assert.equal(await runCli(["source", "sync", source.id, "--json"], deps), 0);
  assert.match(output.join("\n"), /synced/);
  const syncedStore = deps.openStore();
  assert.equal(new ExternalSourceStore(syncedStore).list()[0].status, "synced");
  assert.ok(syncedStore.db.prepare("SELECT 1 FROM source_facts WHERE file_path='nested/guide.md'").get());
  syncedStore.close();
});

test("remote source sync follows only validated redirects and stores untrusted HTML as a revision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-external-remote-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const source = new ExternalSourceStore(store).register({ type: "url", location: "https://docs.example.com/start" });
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith("/start")) return { status: 302, headers: { get: (name) => name === "location" ? "/final" : null }, arrayBuffer: async () => new ArrayBuffer(0) };
    const body = Buffer.from("<html><script>alert(1)</script><h1>Guide</h1><p>Use <a href=\"/penguin\">Penguin</a>.</p></html>");
    return { status: 200, headers: { get: (name) => name === "content-type" ? "text/html; charset=utf-8" : name === "content-length" ? String(body.length) : null }, arrayBuffer: async () => body }; 
  };
  const result = await syncRemoteSource(store, source.id, fetcher);
  assert.deepEqual(calls, ["https://docs.example.com/start", "https://docs.example.com/final"]);
  assert.equal(result.contentType, "text/html");
  assert.equal(new ExternalSourceStore(store).list()[0].status, "synced");
  assert.equal(new ExternalSourceStore(store).list()[0].contentType, "text/html");
  assert.ok(store.db.prepare("SELECT 1 FROM source_facts WHERE repo_id=? AND file_path='index.md'").get(result.repoId));
  assert.match(store.db.prepare("SELECT decoded_content FROM source_blobs ORDER BY id DESC LIMIT 1").get().decoded_content, /# Guide/);
  assert.match(store.db.prepare("SELECT decoded_content FROM source_blobs ORDER BY id DESC LIMIT 1").get().decoded_content, /\[Penguin\]\(\/penguin\)/);
  assert.doesNotMatch(store.db.prepare("SELECT decoded_content FROM source_blobs ORDER BY id DESC LIMIT 1").get().decoded_content, /alert/);
  const search = searchKnowledge({ query: "Penguin", mode: "exact", page: { limit: 5 } }, { store, scopes: [{ repoId: result.repoId, snapshotId: result.snapshotId }] });
  assert.equal(search.hits[0].evidence[0].status, "observed");
  store.close();
});

test("remote source sync rejects a redirect into a private host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-external-ssrf-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const source = new ExternalSourceStore(store).register({ type: "url", location: "https://docs.example.com/start" });
  await assert.rejects(() => syncRemoteSource(store, source.id, async () => ({ status: 302, headers: { get: () => "https://127.0.0.1/secret" }, arrayBuffer: async () => new ArrayBuffer(0) })), /SSRF/);
  store.close();
});
