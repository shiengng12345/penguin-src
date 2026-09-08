import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { QueryWorkerPool } from "../packages/knowledge-cli/dist/query-server.js";

test("resident query worker serves search through the deterministic async surface", () => {
  const source = readFileSync(new URL("../packages/knowledge-cli/src/query-worker.ts", import.meta.url), "utf8");
  assert.match(source, /searchKnowledgeAsync/u);
  assert.doesNotMatch(source, /semanticProviderPromise/u);
  assert.doesNotMatch(source, /semanticProviderFactory/u);
  assert.doesNotMatch(source, /openBundledEmbeddingProvider/u);
});

test("query timeout starts when a queued job begins execution", async () => {
  const workerUrl = new URL(
    "data:text/javascript,import%20%7B%20parentPort%20%7D%20from%20%27node%3Aworker_threads%27%3BparentPort.on(%27message%27%2Cm%3D%3EsetTimeout(()%3D%3EparentPort.postMessage(%7Btype%3A%27result%27%2Cid%3Am.id%2Cok%3Atrue%2Cresult%3Am.input%7D)%2CNumber(m.input.delay)%7C%7C0))",
  );
  const pool = new QueryWorkerPool({
    dbPath: "/tmp/penguin-query-server-test.db",
    ledgerPath: "/tmp/penguin-query-server-test.ledger",
    workerUrl,
    size: 1,
    maxQueue: 2,
    timeoutMs: 40,
  });
  try {
    const first = pool.run("test", { delay: 80 }, undefined, 200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const queued = pool.run("test", { delay: 0 }, undefined, 40);
    assert.deepEqual(await first, { delay: 80 });
    assert.deepEqual(await queued, { delay: 0 });
  } finally {
    await pool.close();
  }
});
