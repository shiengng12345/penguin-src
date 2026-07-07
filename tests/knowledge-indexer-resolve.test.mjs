import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractSymbols,
  resolveRefs,
  detectRenames,
} from "../packages/knowledge-indexer/dist/index.js";

function fakeLookup({ qualified = {}, bare = {} } = {}) {
  return {
    byQualifiedName: (qn) => qualified[qn] ?? null,
    bareNameCandidates: (b) => bare[b] ?? [],
  };
}

test("extractSymbols attributes refs to their enclosing symbol", async () => {
  const src = "function outer() {\n  return inner();\n}\nfunction inner() {}";
  const out = await extractSymbols({ lang: "ts", source: src });
  const call = out.refs.find((r) => r.kind === "call" && r.rawName === "inner");
  assert.equal(call.enclosingQualifiedName, "outer");
});

test("resolveRefs tier 1: same-file call resolves EXTRACTED", async () => {
  const src = "function outer() { return inner(); }\nfunction inner() {}";
  const out = await extractSymbols({ lang: "ts", source: src });
  const ids = new Map([["outer", "n_outer"], ["inner", "n_inner"]]);
  const r = resolveRefs({
    refs: out.refs, fileSymbols: out.symbols, fileSymbolIds: ids, lookup: fakeLookup(),
  });
  const calls = r.edges.filter((e) => e.edgeType === "calls");
  assert.ok(calls.some((e) => e.src === "n_outer" && e.dst === "n_inner" && e.method === "EXTRACTED"));
});

test("resolveRefs tier 3: unique bare hit EXTRACTED, multi INFERRED conf<1, none dropped", async () => {
  const src = "function caller() { one(); two(); three(); }";
  const out = await extractSymbols({ lang: "ts", source: src });
  const ids = new Map([["caller", "n_caller"]]);
  const lookup = fakeLookup({ bare: { one: ["n_one"], two: ["n_a", "n_b"] } }); // three: none
  const r = resolveRefs({ refs: out.refs, fileSymbols: out.symbols, fileSymbolIds: ids, lookup });
  const one = r.edges.find((e) => e.dst === "n_one");
  assert.equal(one.method, "EXTRACTED");
  const two = r.edges.find((e) => e.dst === "n_a");
  assert.equal(two.method, "INFERRED");
  assert.ok(two.confidence < 1);
  assert.ok(r.unresolved >= 1); // three() had no candidate
});

test("resolveRefs drops calls with no enclosing symbol (no caller)", async () => {
  const src = "topLevel();"; // call at file top level, not inside a symbol
  const out = await extractSymbols({ lang: "ts", source: src });
  const r = resolveRefs({
    refs: out.refs, fileSymbols: out.symbols, fileSymbolIds: new Map(),
    lookup: fakeLookup({ bare: { topLevel: ["n_x"] } }),
  });
  assert.equal(r.edges.length, 0);
  assert.ok(r.unresolved >= 1);
});

test("detectRenames: equal-hash disappeared+appeared → one alias; unrelated → none", () => {
  const gone = [{ qualifiedName: "Svc.login", name: "login", kind: "method", contentHash: "H", signature: null, startLine: 1, endLine: 3 }];
  const arrived = [{ qualifiedName: "Svc.signIn", name: "signIn", kind: "method", contentHash: "H", signature: null, startLine: 1, endLine: 3 }];
  const ev = detectRenames({ disappeared: gone, appeared: arrived });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].aliasKey, "Svc.login");
  assert.equal(ev[0].reason, "rename");

  // different hash → not a rename
  assert.equal(
    detectRenames({ disappeared: gone, appeared: [{ ...arrived[0], contentHash: "OTHER" }] }).length,
    0,
  );
});

test("detectRenames: ambiguous equal-hash (2 appeared) → no alias (never auto-merge)", () => {
  const gone = [{ qualifiedName: "A.x", name: "x", kind: "method", contentHash: "H", signature: null, startLine: 1, endLine: 2 }];
  const arrived = [
    { qualifiedName: "A.y", name: "y", kind: "method", contentHash: "H", signature: null, startLine: 1, endLine: 2 },
    { qualifiedName: "A.z", name: "z", kind: "method", contentHash: "H", signature: null, startLine: 3, endLine: 4 },
  ];
  assert.equal(detectRenames({ disappeared: gone, appeared: arrived }).length, 0);
});
