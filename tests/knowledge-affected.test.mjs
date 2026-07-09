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

test("architecture + deadCode overviews (§ parity)", async () => {
  const { KnowledgeStore, architecture, deadCode } = await import("../packages/knowledge-core/dist/index.js");
  const { mkdtempSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pk-arch-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "r", rootPath: "/r" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const mk = (n) => { const id = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::${n}`, title: n, repoId }); store.upsertSymbolVersion({ nodeId: id, branchId, commitSha: "c0", filePath: "a.ts", lang: "ts", kind: "function", contentHash: `h_${n}`, status: "fresh" }); return id; };
  const used = mk("used"); const caller = mk("caller"); const orphan = mk("orphan");
  store.replaceFileEdges({ branchId, filePath: "a.ts", edges: [{ src: caller, dst: used, edgeType: "calls", origin: "parser", method: "EXTRACTED" }] });

  const o = architecture(store);
  assert.ok(o.repos.some((r) => r.name === "r"));
  assert.equal(o.nodeCounts.symbol, 3);
  assert.ok(o.edgeCounts.calls >= 1);
  assert.ok(o.languages.some((l) => l.lang === "ts"));

  const d = deadCode(store, { limit: 50 });
  assert.ok(d.candidates.some((c) => c.title === "orphan"), "orphan flagged");
  assert.ok(!d.candidates.some((c) => c.title === "used"), "used symbol not flagged");
  store.close();
});
