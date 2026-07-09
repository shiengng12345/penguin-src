import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, affectedByFiles } from "../packages/knowledge-core/dist/index.js";

test("affectedByFiles: changed file → its symbols + transitive callers + tests + routes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-aff-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "r", rootPath: "/r" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const mk = (n, file) => { const id = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::${n}`, title: n, repoId }); store.upsertSymbolVersion({ nodeId: id, branchId, commitSha: "c0", filePath: file, lang: "ts", kind: "function", contentHash: `h_${n}`, status: "fresh" }); return id; };
  const helper = mk("helper", "svc/util.ts");
  const svc = mk("svc", "svc/svc.ts");
  const ctrl = mk("ctrl", "svc/ctrl.ts");
  const specFile = store.upsertNode({ nodeType: "file", identityKey: `${repoId}::file::svc/util.spec.ts`, title: "svc/util.spec.ts", repoId });
  const route = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::S.m", title: "gRPC S.m", repoId: null });
  store.replaceFileEdges({ branchId, filePath: "svc/svc.ts", edges: [{ src: svc, dst: helper, edgeType: "calls", origin: "parser", method: "EXTRACTED" }] });
  store.replaceFileEdges({ branchId, filePath: "svc/ctrl.ts", edges: [{ src: ctrl, dst: svc, edgeType: "calls", origin: "parser", method: "EXTRACTED" }] });
  store.replaceFileEdges({ branchId, filePath: "svc/util.spec.ts", edges: [{ src: specFile, dst: helper, edgeType: "tests", origin: "parser", method: "EXTRACTED" }] });
  store.replaceFileEdges({ branchId, filePath: "svc/ctrl.ts.route", edges: [{ src: route, dst: ctrl, edgeType: "handles", origin: "parser", method: "EXTRACTED" }] });

  const a = affectedByFiles(store, ["svc/util.ts"]);
  assert.ok(a.changed.some((x) => x.title === "helper"), "helper is changed");
  assert.ok(a.impacted.some((x) => x.title === "svc"), "svc impacted (calls helper)");
  assert.ok(a.impacted.some((x) => x.title === "ctrl"), "ctrl impacted (transitive)");
  assert.ok(a.tests.some((x) => x.title.includes("util.spec")), "covering test found");
  assert.ok(a.routes.some((r) => r.includes("S.m")), "reaching route found");
  store.close();
});
