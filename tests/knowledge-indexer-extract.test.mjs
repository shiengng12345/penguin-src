import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSymbols } from "../packages/knowledge-indexer/dist/index.js";

test("TS: extracts functions, classes, methods with kinds + line ranges", async () => {
  const src = [
    "export function getLoginUrl(a) { return build(a); }",
    "class Svc {",
    "  handle() { return 1; }",
    "}",
  ].join("\n");
  const out = await extractSymbols({ lang: "ts", source: src });
  assert.equal(out.parseError, null);
  const byName = Object.fromEntries(out.symbols.map((s) => [s.name, s]));
  assert.equal(byName.getLoginUrl.kind, "function");
  assert.equal(byName.getLoginUrl.startLine, 1);
  assert.equal(byName.Svc.kind, "class");
  assert.equal(byName.handle.kind, "method");
});

test("TS: qualified name is scope-joined (Class.method)", async () => {
  const src = "class Svc {\n  login() {}\n}";
  const out = await extractSymbols({ lang: "ts", source: src });
  const method = out.symbols.find((s) => s.name === "login");
  assert.equal(method.qualifiedName, "Svc.login");
  const cls = out.symbols.find((s) => s.name === "Svc");
  assert.equal(cls.qualifiedName, "Svc");
});

test("TS: captures call refs + import targets", async () => {
  const src = "import { x } from './dep';\nfunction f() { return bar(x); }";
  const out = await extractSymbols({ lang: "ts", source: src });
  assert.ok(out.refs.some((r) => r.kind === "call" && r.rawName === "bar"));
  assert.ok(out.fileImports.includes("./dep"));
  assert.ok(out.refs.some((r) => r.kind === "import" && r.rawName === "./dep"));
});

test("contentHash is stable per symbol and independent of other symbols", async () => {
  const a = await extractSymbols({ lang: "ts", source: "function keep(){ return 1; }\nfunction other(){ return 2; }" });
  const b = await extractSymbols({ lang: "ts", source: "function keep(){ return 1; }\nfunction other(){ return 999; }" });
  const ka = a.symbols.find((s) => s.name === "keep").contentHash;
  const kb = b.symbols.find((s) => s.name === "keep").contentHash;
  assert.equal(ka, kb, "keep() hash must not change when other() changes");
});

test("multi-language: python, go, rust, java extract symbols", async () => {
  const py = await extractSymbols({ lang: "python", source: "def foo():\n    pass\nclass C:\n    def m(self):\n        pass" });
  assert.ok(py.symbols.some((s) => s.name === "foo" && s.kind === "function"));
  assert.ok(py.symbols.some((s) => s.name === "m" && s.qualifiedName === "C.m"));

  const go = await extractSymbols({ lang: "go", source: "package p\nfunc Foo() {}\n" });
  assert.ok(go.symbols.some((s) => s.name === "Foo" && s.kind === "function"));

  const rust = await extractSymbols({ lang: "rust", source: "fn foo() {}\nstruct S {}" });
  assert.ok(rust.symbols.some((s) => s.name === "foo"));
  assert.ok(rust.symbols.some((s) => s.name === "S" && s.kind === "struct"));

  const java = await extractSymbols({ lang: "java", source: "class C { void m() {} }" });
  assert.ok(java.symbols.some((s) => s.name === "m" && s.qualifiedName === "C.m"));
});

test("degrade: oversize file and no-tags-query language do not throw", async () => {
  const big = await extractSymbols({ lang: "ts", source: "x", maxBytes: 0 });
  assert.equal(big.symbols.length, 0);
  assert.match(big.parseError, /max bytes/);

  // css has a grammar but no tags query yet → clean parse, no symbols, no error
  const css = await extractSymbols({ lang: "css", source: "a { color: red; }" });
  assert.equal(css.parseError, null);
  assert.equal(css.symbols.length, 0);

  // A grammar whose wasm can't parse in this runtime must degrade, never throw:
  // parseError is surfaced, results empty, no exception escapes (§9).
  const quirky = await extractSymbols({ lang: "yaml", source: "a: 1\nb: 2\n" });
  assert.equal(quirky.symbols.length, 0);
  assert.equal(Array.isArray(quirky.refs), true);
});
