import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KNOWLEDGE_INDEXER_VERSION,
  loadParser,
  langForExtension,
  LANGS,
} from "../packages/knowledge-indexer/dist/index.js";

test("knowledge-indexer dist is importable", () => {
  assert.equal(KNOWLEDGE_INDEXER_VERSION, "0.0.1");
  assert.ok(LANGS.includes("ts"));
});

test("loadParser loads a grammar and parses source (web-tree-sitter + wasm ABI ok)", async () => {
  const parser = await loadParser("ts");
  const tree = parser.parse("const x = 1;");
  assert.equal(tree.rootNode.type, "program");
  assert.ok(tree.rootNode.namedChildCount >= 1);
});

test("langForExtension maps common extensions and rejects unknown", () => {
  assert.equal(langForExtension("src/a.ts"), "ts");
  assert.equal(langForExtension("src/a.tsx"), "tsx");
  assert.equal(langForExtension("m.rs"), "rust");
  assert.equal(langForExtension("s.py"), "python");
  assert.equal(langForExtension("Main.java"), "java");
  assert.equal(langForExtension("x.unknownext"), null);
  assert.equal(langForExtension("noext"), null);
});
