import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { extractSymbols } from "../packages/knowledge-indexer/dist/index.js";

test("releases tree-sitter WASM resources during repeated extraction", { timeout: 120_000 }, () => {
  const childSource = String.raw`
    import { extractSymbols } from "./packages/knowledge-indexer/dist/index.js";
    import { extractIdentifiersFromSource } from "./packages/knowledge-indexer/dist/identifiers.js";

    const source = Array.from({ length: 250 }, (_, i) => [
      "export interface I" + i + " { field" + i + ": string; status: number }",
      "export class C" + i + " { value = " + i + "; method" + i + "() { return helper" + i + "(this.value); } }",
      "function helper" + i + "(x) { return x + " + i + "; }",
    ].join("\n")).join("\n");

    for (let i = 0; i < 10; i++) {
      await extractSymbols({ lang: "ts", source, relPath: "src/warm.ts" });
      await extractIdentifiersFromSource("ts", source);
    }
    global.gc();
    const baseline = process.memoryUsage().rss;
    for (let i = 0; i < 120; i++) {
      await extractSymbols({ lang: "ts", source, relPath: "src/file-" + i + ".ts" });
      await extractIdentifiersFromSource("ts", source);
      if (i % 20 === 19) global.gc();
    }
    global.gc();
    const growthMb = (process.memoryUsage().rss - baseline) / 1024 / 1024;
    process.stdout.write(JSON.stringify({ baselineMb: baseline / 1024 / 1024, growthMb }));
    if (growthMb > 180) process.exitCode = 1;
  `;

  const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", childSource], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 110_000,
  });
  assert.equal(
    child.status,
    0,
    `tree-sitter RSS must stay bounded after warmup; stdout=${child.stdout}; stderr=${child.stderr}`,
  );
  const result = JSON.parse(child.stdout);
  assert.ok(result.growthMb <= 180, `RSS grew ${result.growthMb.toFixed(1)} MB after warmup`);
});

test("languages without a tags query stay file-level even when their grammar rejects valid syntax", async () => {
  const extracted = await extractSymbols({
    lang: "bash",
    relPath: "scripts/branch.sh",
    source: 'case "$value" in ok) echo yes ;; esac',
  });
  assert.equal(extracted.parseError, null);
  assert.deepEqual(extracted.symbols, []);
});

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

test("TSX: extracts conservative component and callback relation refs", async () => {
  const source = [
    "function Screen() {",
    "  return <ProfileCard onSave={saveProfile} />;",
    "}",
    "function saveProfile() {}",
    "function ProfileCard() {}",
  ].join("\n");
  const out = await extractSymbols({ lang: "tsx", relPath: "screen.tsx", source });
  assert.ok(out.refs.some((ref) => ref.kind === "jsx-component" && ref.rawName === "ProfileCard"));
  assert.ok(out.refs.some((ref) => ref.kind === "jsx-callback" && ref.rawName === "saveProfile"));
  assert.equal(
    out.refs.find((ref) => ref.kind === "jsx-component")?.enclosingQualifiedName,
    "screen.tsx::Screen",
  );
});

test("TS: extracts identifiers and static log sites in the same AST pass", async () => {
  const src = [
    "interface Detail { accountStatus: string }",
    "class BpAccountClosureService {",
    "  closeAccount() {",
    "    this.logger.info('[BpAccountClosureService] closeAccount started');",
    "    this.appLogger.warn(`closing account ${playerId}`);",
    "  }",
    "}",
  ].join("\n");
  const out = await extractSymbols({ lang: "ts", relPath: "closure.ts", source: src });

  assert.ok(out.identifiers.some((entry) => entry.name === "accountStatus" && entry.kind === "field"));
  assert.deepEqual(
    out.logSites.map(({ message, level, startLine, enclosingQualifiedName }) => ({
      message, level, startLine, enclosingQualifiedName,
    })),
    [
      {
        message: "[BpAccountClosureService] closeAccount started",
        level: "info",
        startLine: 4,
        enclosingQualifiedName: "BpAccountClosureService.closeAccount",
      },
      {
        message: "closing account ",
        level: "warn",
        startLine: 5,
        enclosingQualifiedName: "BpAccountClosureService.closeAccount",
      },
    ],
  );
});

test("TS: captures dynamic import targets for test-to-symbol scoping", async () => {
  const src = [
    "async function exerciseProvider() {",
    "  const { Provider } = await import('./provider');",
    "  return new Provider().checkBlacklist();",
    "}",
  ].join("\n");
  const out = await extractSymbols({ lang: "ts", source: src });
  assert.ok(out.fileImports.includes("./provider"));
  assert.ok(out.refs.some((ref) => ref.kind === "import" && ref.rawName === "./provider"));
});

test("TS: factory-call variables enclose callbacks and their gRPC client calls", async () => {
  const src = [
    "export const loadProfile = createAsyncThunk('profile/load', async () => {",
    "  return playerService.getPlayerInfo({});",
    "});",
  ].join("\n");
  const out = await extractSymbols({ lang: "ts", relPath: "profile-slice.ts", source: src });
  const symbol = out.symbols.find((item) => item.name === "loadProfile");
  assert.equal(symbol?.kind, "function");
  assert.equal(symbol?.startLine, 1);
  assert.equal(symbol?.endLine, 3);
  const call = out.refs.find((item) => item.kind === "call" && item.rawName === "getPlayerInfo");
  assert.equal(call?.enclosingQualifiedName, "profile-slice.ts::loadProfile");
});

test("TS: ordinary call-valued constants are not promoted to function symbols", async () => {
  const out = await extractSymbols({
    lang: "ts",
    relPath: "config.ts",
    source: "export const config = makeConfig();",
  });
  assert.equal(out.symbols.some((item) => item.name === "config"), false);
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

test("more languages: ruby, php, c, cpp, csharp extract symbols", async () => {
  const ruby = await extractSymbols({ lang: "ruby", source: "class Foo\n  def bar\n  end\nend" });
  assert.ok(ruby.symbols.some((s) => s.name === "Foo" && s.kind === "class"));
  assert.ok(ruby.symbols.some((s) => s.name === "bar" && s.qualifiedName === "Foo.bar"));

  const php = await extractSymbols({ lang: "php", source: "<?php\nclass Svc { function login(){ return helper(); } }\nfunction helper(){ return 1; }" });
  assert.ok(php.symbols.some((s) => s.name === "login" && s.qualifiedName === "Svc.login"));
  assert.ok(php.refs.some((r) => r.kind === "call" && r.rawName === "helper"));

  const c = await extractSymbols({ lang: "c", source: "int add(int a,int b){return a+b;}\nint main(){return add(1,2);}" });
  assert.ok(c.symbols.some((s) => s.name === "add" && s.kind === "function"));
  assert.ok(c.refs.some((r) => r.rawName === "add"));

  const cpp = await extractSymbols({ lang: "cpp", source: "class C { public: void m(){} };\nint fn(){return 1;}" });
  assert.ok(cpp.symbols.some((s) => s.name === "C" && s.kind === "class"));

  const cs = await extractSymbols({ lang: "csharp", source: "class C { void M(){ N(); } void N(){} }" });
  assert.ok(cs.symbols.some((s) => s.name === "M" && s.qualifiedName === "C.M"));
  assert.ok(cs.refs.some((r) => r.rawName === "N"));
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
