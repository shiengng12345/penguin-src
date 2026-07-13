import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { startWatcher } from "../packages/knowledge-indexer/dist/index.js";

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pk-watch-"));
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "refs", "heads", "main"), "c0\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  return dir;
}
function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-watchdb-"));
  return KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
}

test("watcher debounces a burst into a single index run and indexes the change", async () => {
  const root = tempRepo();
  const store = openStore();
  const runs = [];
  const w = startWatcher({ store, rootPath: root, debounceMs: 150, onRun: (r) => runs.push(r) });
  try {
    // wait for chokidar ready
    for (let i = 0; i < 40 && !w.status().watching; i++) await delay(25);
    assert.equal(w.status().watching, true);

    // burst: 5 writes to the same file within the debounce window
    const f = join(root, "src", "svc.ts");
    for (let i = 0; i < 5; i++) {
      writeFileSync(f, `export function fn${i}() { return ${i}; }`);
      await delay(10);
    }
    await w.whenIdle();
    await delay(50);

    assert.equal(runs.length, 1, "burst coalesced into one run");
    // the change got indexed — the last write's symbol is present. Identity
    // keys for file-scoped symbols are `repoId::relPath::name`, not bare
    // `repoId::name` — this assertion's stale key format was the actual
    // reason this test failed (not the debounce/watch logic, which was fine).
    assert.ok(store.resolveIdentity(`${runs[0].repoId}::src/svc.ts::fn4`), "fn4 indexed");
    store.close();
  } finally {
    await w.stop();
    assert.equal(w.status().watching, false);
  }
});
