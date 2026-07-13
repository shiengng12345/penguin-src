// tests/pipeline-fpms-grpc-js.test.mjs
// FPMS-style JS gRPC client calls (serviceRegistry + grpcClientCall, see
// grpc-js-client.ts): the consumer-side pass in pipeline.ts must attribute an
// `invokes` edge from the exporting symbol to the GLOBAL grpc endpoint id.
// Regression: extractSymbols emits file-prefixed qualifiedNames
// ("<relPath>::<name>") while the pass matched bare/dot-suffixed names only,
// so every real FPMS call site silently produced zero edges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepo } from "../packages/knowledge-indexer/dist/pipeline.js";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { grpcEndpointKey } from "../packages/knowledge-indexer/dist/grpc-client.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-fpms-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

// Minimal fpmsNTAPI.js-shaped fixture: registry entry + export object function
// that resolves a client from the registry and dispatches via grpcClientCall.
function fpmsRepo() {
  const repo = mkdtempSync(join(tmpdir(), "fpms-src-"));
  mkdirSync(join(repo, "Server/externalAPI"), { recursive: true });
  writeFileSync(
    join(repo, "Server/externalAPI/ntAPI.js"),
    `const serviceRegistry = {
    [SERVICE_RISK]: { serviceName: 'RiskControlService', address: 'risk:50051' },
};
module.exports = {
    CheckAMLConditions: async function (data) {
        const { client } = createGrpcClientFromRegistry(SERVICE_RISK, 'CheckAMLConditions');
        return grpcClientCall(client, 'CheckAMLConditions', data);
    },
};
`,
  );
  return repo;
}

test("FPMS js gRPC client call → invokes edge to the global grpc endpoint", async () => {
  const store = openStore();
  await indexRepo({ store, rootPath: fpmsRepo(), mode: "incremental" });
  const key = grpcEndpointKey("RiskControlService", "CheckAMLConditions");
  const edges = store.db
    .prepare(
      `SELECT e.id FROM edges e JOIN nodes d ON d.id = e.dst
       WHERE d.identity_key = ? AND e.edge_type = 'invokes' AND e.status = 'active'`,
    )
    .all(key);
  assert.ok(edges.length >= 1, `invokes edge to ${key} exists (got ${edges.length})`);
  store.close();
});
