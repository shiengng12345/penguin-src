import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KnowledgeStore,
  buildContextPack,
  renderContextPackMarkdown,
} from "../packages/knowledge-core/dist/index.js";

// caller → login → helper; login throws AuthError, uses JWT_SECRET.
function seed() {
  const dir = mkdtempSync(join(tmpdir(), "pk-cp-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "auth", rootPath: "/auth" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  store.recordBranchIndexed({ branchId, commit: "c0" });
  const mk = (name, kind = "function") => {
    const id = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::${name}`, title: name, repoId });
    store.upsertSymbolVersion({ nodeId: id, branchId, commitSha: "c0", filePath: "a.ts", lang: "ts", kind, contentHash: `h_${name}`, status: "fresh" });
    return id;
  };
  const caller = mk("caller");
  const login = mk("login");
  const helper = mk("helper");
  const err = store.upsertNode({ nodeType: "entity", identityKey: `${repoId}::entity::error::AuthError`, title: "AuthError", repoId });
  store.replaceFileEdges({ branchId, filePath: "a.ts", edges: [
    { src: caller, dst: login, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
    { src: login, dst: helper, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
    { src: login, dst: err, edgeType: "throws", origin: "parser", method: "EXTRACTED" },
  ] });
  return { store, login };
}

test("buildContextPack: focus + callers + calls + throws, branch-scoped (Phase 2)", () => {
  const { store, login } = seed();
  const pack = buildContextPack(store, "login");
  assert.ok(pack.focus, "focus resolved");
  assert.equal(pack.focus.title, "login");
  assert.ok(pack.callers.some((c) => c.title === "caller"), "caller listed");
  assert.ok(pack.calls.some((c) => c.title === "helper"), "calls helper");
  assert.ok(pack.errors.includes("AuthError"), "throws AuthError");
  store.close();
});

test("renderContextPackMarkdown: produces an AI-readable pack (Phase 2)", () => {
  const { store, login } = seed();
  const md = renderContextPackMarkdown(buildContextPack(store, login));
  assert.match(md, /# Context Pack: login/);
  assert.match(md, /Called by/);
  assert.match(md, /Calls/);
  store.close();
});

test("buildContextPack: unknown target → empty pack (no focus)", () => {
  const { store } = seed();
  const pack = buildContextPack(store, "does-not-exist");
  assert.equal(pack.focus, null);
  store.close();
});

test("buildFlow: linear downstream chain from a symbol (Phase 5)", async () => {
  const { KnowledgeStore, buildFlow, renderFlowMarkdown } = await import("../packages/knowledge-core/dist/index.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pk-flow-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "svc", rootPath: "/svc" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  store.recordBranchIndexed({ branchId, commit: "c0" });
  const mk = (n) => { const id = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::${n}`, title: n, repoId }); store.upsertSymbolVersion({ nodeId: id, branchId, commitSha: "c0", filePath: "a.ts", lang: "ts", kind: "method", contentHash: `h_${n}`, status: "fresh" }); return id; };
  const ctrl = mk("Ctrl.create"), svc = mk("Svc.createWithdraw"), wallet = mk("Wallet.freeze");
  store.replaceFileEdges({ branchId, filePath: "a.ts", edges: [
    { src: ctrl, dst: svc, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
    { src: svc, dst: wallet, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
  ] });
  const flow = buildFlow(store, "Ctrl.create");
  assert.equal(flow.root.title, "Ctrl.create");
  const titles = flow.steps.map((s) => s.title);
  assert.ok(titles.includes("Svc.createWithdraw") && titles.includes("Wallet.freeze"), "downstream chain captured");
  assert.match(renderFlowMarkdown(flow), /# Flow: Ctrl\.create/);
  store.close();
});
