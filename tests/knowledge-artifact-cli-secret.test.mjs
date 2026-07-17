import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

test("artifact CLI reads encryption passphrase by env name, never by argv value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-artifact-cli-secret-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const artifactPath = join(dir, "encrypted.pka");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  store.registerRepo({ name: "secret-cli", rootPath: "/secret-cli" });
  store.close();
  const lines = [];
  const errs = [];
  const deps = { cwd: dir, out: (line) => lines.push(line), err: (line) => errs.push(line), storeExists: () => existsSync(dbPath), openStore: () => KnowledgeStore.open({ dbPath, ledgerPath }) };
  const previous = process.env.PENGUIN_TEST_ARTIFACT_PASSPHRASE;
  process.env.PENGUIN_TEST_ARTIFACT_PASSPHRASE = "not-in-argv-secret";
  try {
    const code = await runCli(["artifact", "export", "--out", artifactPath, "--passphrase-env", "PENGUIN_TEST_ARTIFACT_PASSPHRASE", "--confirm=legacy-confirm", "--json"], deps);
    assert.equal(code, 0, errs.join("\n"));
    assert.equal(existsSync(artifactPath), true);
    lines.length = 0;
    assert.equal(await runCli(["artifact", "import", "--input", artifactPath, "--passphrase-env", "PENGUIN_TEST_ARTIFACT_PASSPHRASE", "--json"], deps), 0);
    assert.match(lines.at(-1), /validation completed/);
  } finally {
    if (previous === undefined) delete process.env.PENGUIN_TEST_ARTIFACT_PASSPHRASE;
    else process.env.PENGUIN_TEST_ARTIFACT_PASSPHRASE = previous;
  }
});
