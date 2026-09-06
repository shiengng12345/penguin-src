import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSymbols, resolveRefs } from "../packages/knowledge-indexer/dist/index.js";

test("Rust std/iterator receiver calls never bind to unrelated local collect or is_empty", async () => {
  const source = [
    "struct TemplateChannels;",
    "impl TemplateChannels { fn is_empty(&self) {} }",
    "fn collect() {}",
    "fn check(games: Vec<i32>) {",
    "  let _: Vec<i32> = games.into_iter().collect();",
    "  let _ = String::new().is_empty();",
    "  let _ = Vec::<i32>::new().is_empty();",
    "}",
  ].join("\n");
  const extracted = await extractSymbols({ lang: "rust", relPath: "src/channels.rs", source });
  const collectRef = extracted.refs.find((ref) => ref.kind === "call" && ref.rawName === "collect");
  const emptyRefs = extracted.refs.filter((ref) => ref.kind === "call" && ref.rawName === "is_empty");
  assert.ok(collectRef?.memberReceiver, JSON.stringify(extracted.refs));
  assert.ok(emptyRefs.length >= 2, JSON.stringify(extracted.refs));
  assert.ok(emptyRefs.every((ref) => ref.memberReceiver), JSON.stringify(emptyRefs));
  const ids = new Map(extracted.symbols.map((symbol, index) => [symbol.qualifiedName, `node-${index}`]));
  const byName = new Map(extracted.symbols.map((symbol) => [symbol.name, ids.get(symbol.qualifiedName)]));
  const resolved = resolveRefs({
    refs: extracted.refs,
    fileSymbols: extracted.symbols,
    fileSymbolIds: ids,
    language: "rust",
    currentFile: "src/channels.rs",
    lookup: {
      byQualifiedName: () => null,
      bareNameCandidates: (name) => byName.has(name) ? [{ id: byName.get(name), filePath: "src/channels.rs" }] : [],
    },
  });
  const collectId = byName.get("collect");
  const emptyId = extracted.symbols.find((symbol) => symbol.name === "is_empty")
    ? ids.get(extracted.symbols.find((symbol) => symbol.name === "is_empty").qualifiedName)
    : null;
  assert.equal(resolved.edges.some((edge) => edge.dst === collectId), false, JSON.stringify(resolved));
  assert.equal(resolved.edges.some((edge) => edge.dst === emptyId), false, JSON.stringify(resolved));
  assert.ok(resolved.unresolvedItems.some((item) => item.reasonCode.includes("dynamic") || item.reasonCode.includes("platform") || item.reasonCode.includes("receiver")), JSON.stringify(resolved));
});
