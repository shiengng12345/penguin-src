import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSymbols, anonymousCallbackIdentity } from "../packages/knowledge-indexer/dist/index.js";

test("symbol identity keeps overload parameter discriminators", async () => {
  const result = await extractSymbols({ lang: "ts", relPath: "src/parser.ts", source: "class Parser { parse(value: string): string { return value; } parse(value: number): number { return value; } }" });
  const overloads = result.symbols.filter((symbol) => symbol.name === "parse");
  assert.equal(overloads.length, 2);
  assert.equal(new Set(overloads.map((symbol) => symbol.qualifiedName)).size, 2);
  assert.ok(overloads.some((symbol) => symbol.qualifiedName.includes("string")));
  assert.ok(overloads.some((symbol) => symbol.qualifiedName.includes("number")));
});

test("Java overloads use parameter arity/type as identity discriminator", async () => {
  const result = await extractSymbols({ lang: "java", relPath: "src/Parser.java", source: "class Parser { String parse(String value) { return value; } String parse(int value) { return String.valueOf(value); } }" });
  const overloads = result.symbols.filter((symbol) => symbol.name === "parse");
  assert.equal(overloads.length, 2);
  assert.equal(new Set(overloads.map((symbol) => symbol.qualifiedName)).size, 2);
});

test("anonymous callback identity uses parent identity and stable ordinal", () => {
  assert.equal(anonymousCallbackIdentity("src/provider.spec.ts::test-file", 3), "src/provider.spec.ts::test-file::anonymous_callback#3");
  assert.throws(() => anonymousCallbackIdentity("", 0), /ANONYMOUS_CALLBACK_ID_INVALID/);
});
