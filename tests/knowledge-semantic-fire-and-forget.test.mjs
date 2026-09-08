import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

test("two independent processes cannot both acquire one branch index marker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-marker-race-"));
  const dbPath = join(directory, "knowledge.db");
  const ledgerPath = join(directory, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const repoId = store.registerRepo({ name: "marker-race", rootPath: directory });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  store.close();
  const barrier = join(directory, "marker.barrier");
  const ready = (id) => join(directory, `marker.${id}.ready`);
  const coreUrl = new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href;
  const script = (id) => `
    import { existsSync, writeFileSync } from "node:fs";
    import { KnowledgeStore } from ${JSON.stringify(coreUrl)};
    writeFileSync(${JSON.stringify(ready(id))}, "ready");
    while (!existsSync(${JSON.stringify(barrier)})) await new Promise((resolve) => setTimeout(resolve, 2));
    const store = KnowledgeStore.open({ dbPath: ${JSON.stringify(dbPath)}, ledgerPath: ${JSON.stringify(ledgerPath)} });
    try {
      store.acquireIndexMarker(${JSON.stringify(branchId)});
      process.stdout.write("acquired");
      await new Promise((resolve) => setTimeout(resolve, 120));
      store.releaseIndexMarker(${JSON.stringify(branchId)});
    } catch (error) {
      process.stdout.write("blocked:" + String(error.message));
    } finally { store.close(); }
  `;
  const run = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script(id)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `child exited ${code}`)));
  });
  const first = run("a");
  const second = run("b");
  const readyDeadline = Date.now() + 5_000;
  while ((!existsSync(ready("a")) || !existsSync(ready("b"))) && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(existsSync(ready("a")), true, "marker child a did not reach the barrier");
  assert.equal(existsSync(ready("b")), true, "marker child b did not reach the barrier");
  assert.equal(existsSync(barrier), false);
  writeFileSync(barrier, "go");
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((result) => result === "acquired").length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.startsWith("blocked:index already running")).length, 1, JSON.stringify(results));
});

test("the writer marker serializes different branches in one database", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-global-marker-"));
  const store = KnowledgeStore.open({
    dbPath: join(directory, "knowledge.db"),
    ledgerPath: join(directory, "ledger.jsonl"),
  });
  const repoId = store.registerRepo({ name: "global-marker", rootPath: directory });
  const mainId = store.registerBranch({ repoId, name: "main", status: "live" });
  const featureId = store.registerBranch({ repoId, name: "feature", status: "snapshot" });

  store.acquireIndexMarker(mainId);
  assert.throws(
    () => store.acquireIndexMarker(featureId),
    (error) => error?.code === "INDEX_WRITER_BUSY" && /another repository or branch/.test(error.message),
    "a second branch must receive a typed writer-busy error",
  );
  store.releaseIndexMarker(mainId);
  store.acquireIndexMarker(featureId);
  store.releaseIndexMarker(featureId);
  store.close();
});

