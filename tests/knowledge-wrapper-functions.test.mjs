import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSymbols } from "../packages/knowledge-indexer/dist/extract.js";
import { isFunctionReturningWrapper } from "../packages/knowledge-indexer/dist/wrapper-functions.js";

// The tags query captures `const X = call(callback)` as a function so that
// HOC/hook-wrapped components get indexed. It fires on ANY call taking a
// callback, which made every `.filter()` / `.find()` / `renderHook()` bound to
// a const a phantom function — 5,670 of 48,863 function symbols (11.6%).

async function functionNames(source) {
  const extracted = await extractSymbols({ lang: "ts", source, relPath: "a.ts" });
  return extracted.symbols.filter((symbol) => symbol.kind === "function").map((symbol) => symbol.name).sort();
}

test("allowlist matches bare and member forms, and nothing else", () => {
  assert.equal(isFunctionReturningWrapper("memo"), true);
  assert.equal(isFunctionReturningWrapper("React.memo"), true, "React wrappers ARE member expressions");
  assert.equal(isFunctionReturningWrapper("_.debounce"), true);
  assert.equal(isFunctionReturningWrapper("useCallback"), true);
  assert.equal(isFunctionReturningWrapper("children.filter"), false);
  assert.equal(isFunctionReturningWrapper("config.plugins.find"), false);
  assert.equal(isFunctionReturningWrapper("renderHook"), false);
  // useMemo returns whatever the callback returns; the call site cannot tell an
  // array from a function, so it stays out rather than guessing.
  assert.equal(isFunctionReturningWrapper("useMemo"), false);
  // A method merely NAMED like a wrapper on an unrelated object still counts —
  // matching the property is what keeps React.memo working, and the trade is
  // deliberate: a false function is cheaper than losing every React component.
  assert.equal(isFunctionReturningWrapper("myLib.memo"), true);
});

test("wrapped components and handlers are still indexed as functions", async () => {
  // This is the capability the pattern exists for; losing it would be worse
  // than the bug being fixed.
  assert.deepEqual(await functionNames("const C = memo(() => null);"), ["C"]);
  assert.deepEqual(await functionNames("const C = React.memo(() => null);"), ["C"]);
  assert.deepEqual(await functionNames("const R = forwardRef(() => null);"), ["R"]);
  assert.deepEqual(await functionNames("const h = useCallback(() => {}, []);"), ["h"]);
});

test("array and utility calls are no longer phantom functions", async () => {
  assert.deepEqual(await functionNames("const filtered = children.filter((r) => !!r);"), []);
  assert.deepEqual(await functionNames("const plugin = config.plugins.find((p) => p.x);"), []);
  assert.deepEqual(await functionNames("const sorted = items.sort((a, b) => a - b);"), []);
  assert.deepEqual(await functionNames("const total = rows.reduce((a, b) => a + b, 0);"), []);
  assert.deepEqual(await functionNames("const rendered = renderHook(() => useThing());"), []);
  assert.deepEqual(await functionNames("const items = useMemo(() => arr.filter((x) => x), []);"), []);
});

test("ordinary function forms are untouched by the filter", async () => {
  // The filter must only apply to the wrapped-call shape.
  assert.deepEqual(await functionNames("const fn = () => 1;"), ["fn"]);
  assert.deepEqual(await functionNames("function real() { return 1; }"), ["real"]);
  assert.deepEqual(await functionNames("const named = function inner() { return 1; };"), ["named"]);
  assert.deepEqual(await functionNames("export async function go() { return 1; }"), ["go"]);
});

test("callables the allowlist must never drop again", async () => {
  // createAsyncThunk returns a callable thunk, and dropping it costs more than
  // one symbol: the gRPC calls inside its callback lose their enclosing scope,
  // so those edges vanish from the graph entirely. An earlier version of this
  // allowlist did exactly that and broke an existing extract test.
  assert.deepEqual(
    await functionNames("export const load = createAsyncThunk('p/load', async () => svc.get({}));"),
    ["load"],
  );
  // Test doubles are callable by construction, and there are ~200 in this index.
  assert.deepEqual(await functionNames("const spy = jest.fn(() => 1);"), ["spy"]);
  assert.deepEqual(await functionNames("const s = jest.spyOn(obj, 'm').mockImplementation(() => 1);"), ["s"]);
  assert.deepEqual(await functionNames("const Page = React.lazy(() => import('./Page'));"), ["Page"]);
});

test("callback-taking calls that return data stay excluded", async () => {
  // Sized from the real index — these appear in the hundreds and are exactly
  // what the bug was mislabelling.
  assert.deepEqual(await functionNames("const list = Array.from(x, (v) => v);"), []);
  assert.deepEqual(await functionNames("const pairs = Object.entries(o).map(([k]) => k);"), []);
  assert.deepEqual(await functionNames("const t = setTimeout(() => {}, 10);"), []);
});

test("a real-world mix keeps only the genuine functions", async () => {
  const source = [
    "const Card = React.memo(() => null);",
    "const onPick = useCallback(() => {}, []);",
    "const visible = rows.filter((r) => r.show);",
    "const first = rows.find((r) => r.id === 1);",
    "export function helper() { return 1; }",
  ].join("\n");
  assert.deepEqual(await functionNames(source), ["Card", "helper", "onPick"]);
});
