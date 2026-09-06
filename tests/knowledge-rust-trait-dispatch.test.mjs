import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSymbols, resolveRefs } from "../packages/knowledge-indexer/dist/index.js";

test("Rust trait receiver dispatch stays candidate/unresolved instead of a proven implementation", async () => {
  const source = [
    "trait Worker { fn run(&self); }",
    "struct WorkerA;",
    "struct WorkerB;",
    "impl Worker for WorkerA { fn run(&self) {} }",
    "impl Worker for WorkerB { fn run(&self) {} }",
    "fn invoke(worker: &dyn Worker) { worker.run(); }",
  ].join("\n");
  const extracted = await extractSymbols({ lang: "rust", relPath: "src/worker.rs", source });
  const invoke = extracted.symbols.find((symbol) => symbol.name === "invoke");
  assert.ok(invoke, JSON.stringify(extracted.symbols));
  const call = extracted.refs.find((ref) => ref.kind === "call" && ref.rawName === "run" && ref.enclosingQualifiedName === invoke.qualifiedName);
  assert.ok(call?.memberReceiver, JSON.stringify(extracted.refs));
  const ids = new Map(extracted.symbols.map((symbol, index) => [symbol.qualifiedName, `node-${index}`]));
  const resolved = resolveRefs({
    refs: extracted.refs,
    fileSymbols: extracted.symbols,
    fileSymbolIds: ids,
    language: "rust",
    currentFile: "src/worker.rs",
    lookup: {
      byQualifiedName: () => null,
      bareNameCandidates: (name) => name === "run"
        ? [{ id: "impl-a-run", filePath: "src/worker.rs" }, { id: "impl-b-run", filePath: "src/worker.rs" }]
        : [],
    },
  });
  const invokeId = ids.get(invoke.qualifiedName);
  const invokeEdges = resolved.edges.filter((edge) => edge.src === invokeId && edge.edgeType === "calls");
  assert.equal(invokeEdges.some((edge) => edge.method === "EXTRACTED"), false, JSON.stringify(resolved));
  assert.ok(resolved.unresolvedItems.some((item) => item.rawTarget === "run"), JSON.stringify(resolved));
});
