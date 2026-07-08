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
    // candidates carry a filePath now; accept bare string ids for terseness.
    bareNameCandidates: (b) =>
      (bare[b] ?? []).map((x) => (typeof x === "string" ? { id: x, filePath: null } : x)),
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

test("extractSymbols captures type references (Plan B)", async () => {
  const src = [
    "export interface Resp { token: TokenDto; }",
    "export class Proc extends Base implements IProc {",
    "  run(): Promise<Wrapper<Resp>> { const x: TokenDto = build(); return x; }",
    "}",
  ].join("\n");
  const out = await extractSymbols({ lang: "ts", source: src });
  const typeNames = new Set(out.refs.filter((r) => r.kind === "type").map((r) => r.rawName));
  for (const n of ["TokenDto", "Base", "IProc", "Resp", "Wrapper"]) {
    assert.ok(typeNames.has(n), `expected a type reference for ${n}`);
  }
});

test("resolveRefs: type ref becomes a references edge to the used type (Plan B)", async () => {
  const src = "export interface Resp { token: Foo; }";
  const out = await extractSymbols({ lang: "ts", source: src });
  const ids = new Map([["Resp", "n_resp"]]);
  const r = resolveRefs({
    refs: out.refs, fileSymbols: out.symbols, fileSymbolIds: ids,
    lookup: fakeLookup({ qualified: { Foo: "n_foo" } }),
  });
  const edge = r.edges.find((e) => e.edgeType === "references" && e.dst === "n_foo");
  assert.ok(edge, "expected a references edge to Foo");
  assert.equal(edge.src, "n_resp");
});

test("resolveRefs: over-ambiguous bare name is dropped, not force-merged (Plan B)", async () => {
  const src = "function caller() { log(); }";
  const out = await extractSymbols({ lang: "ts", source: src });
  const many = Array.from({ length: 20 }, (_, i) => `n_${i}`);
  const r = resolveRefs({
    refs: out.refs, fileSymbols: out.symbols, fileSymbolIds: new Map([["caller", "n_caller"]]),
    lookup: fakeLookup({ bare: { log: many } }),
  });
  assert.equal(r.edges.length, 0, "a name matching 20 candidates must not create a fake hub edge");
  assert.ok(r.unresolved >= 1);
});

test("resolveRefs: import scoping picks the imported candidate over ambiguity (Plan B)", async () => {
  const out = await extractSymbols({ lang: "ts", source: "function caller() { build(); }" });
  const lookup = {
    byQualifiedName: () => null,
    bareNameCandidates: () => [
      { id: "n_a", filePath: "src/a.ts" },
      { id: "n_b", filePath: "src/b.ts" },
    ],
  };
  const r = resolveRefs({
    refs: out.refs, fileSymbols: out.symbols, fileSymbolIds: new Map([["caller", "n_caller"]]),
    lookup, currentFile: "src/caller.ts", importedFiles: new Set(["src/b.ts"]),
  });
  const e = r.edges.find((x) => x.edgeType === "calls");
  assert.ok(e && e.dst === "n_b", "should resolve to the imported-file candidate");
  assert.equal(e.method, "EXTRACTED");
});

test("resolveRefs: still-ambiguous after import scoping → dropped, no guess (Plan B)", async () => {
  const out = await extractSymbols({ lang: "ts", source: "function caller() { build(); }" });
  const lookup = {
    byQualifiedName: () => null,
    bareNameCandidates: () => [
      { id: "n_a", filePath: "src/a.ts" },
      { id: "n_b", filePath: "src/b.ts" },
    ],
  };
  const r = resolveRefs({
    refs: out.refs, fileSymbols: out.symbols, fileSymbolIds: new Map([["caller", "n_caller"]]),
    lookup, currentFile: "src/caller.ts", importedFiles: new Set(["src/a.ts", "src/b.ts"]),
  });
  assert.equal(r.edges.filter((x) => x.edgeType === "calls").length, 0);
  assert.ok(r.unresolved >= 1);
});

test("detectRenames: equal-hash disappeared+appeared → one alias; unrelated → none", () => {
  const gone = [{ qualifiedName: "Svc.login", name: "login", kind: "method", contentHash: "H", signature: null, startLine: 1, endLine: 3 }];
  const arrived = [{ qualifiedName: "Svc.signIn", name: "signIn", kind: "method", contentHash: "H", signature: null, startLine: 1, endLine: 3 }];
  const ev = detectRenames({ disappeared: gone, appeared: arrived });
  assert.equal(ev.auto.length, 1);
  assert.equal(ev.auto[0].aliasKey, "Svc.login");
  assert.equal(ev.auto[0].reason, "rename");
  assert.equal(ev.suggested.length, 0);

  // different hash → not a rename
  const diff = detectRenames({ disappeared: gone, appeared: [{ ...arrived[0], contentHash: "OTHER" }] });
  assert.equal(diff.auto.length, 0);
  assert.equal(diff.suggested.length, 0);
});

test("detectRenames: ambiguous equal-hash (2 appeared) → no auto, goes to suggested queue", () => {
  const gone = [{ qualifiedName: "A.x", name: "x", kind: "method", contentHash: "H", signature: null, startLine: 1, endLine: 2 }];
  const arrived = [
    { qualifiedName: "A.y", name: "y", kind: "method", contentHash: "H", signature: null, startLine: 1, endLine: 2 },
    { qualifiedName: "A.z", name: "z", kind: "method", contentHash: "H", signature: null, startLine: 3, endLine: 4 },
  ];
  const r = detectRenames({ disappeared: gone, appeared: arrived });
  assert.equal(r.auto.length, 0); // never auto-merge on ambiguity
  assert.equal(r.suggested.length, 1);
  assert.deepEqual(r.suggested[0].candidateKeys.sort(), ["A.y", "A.z"]);
});
