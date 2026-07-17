import assert from "node:assert/strict";
import { test } from "node:test";
import { exportGraphSelectionToCanvas, parseCanvas, serializeCanvas, canvasToSearchableMarkdown } from "../packages/knowledge-indexer/dist/index.js";

test("Canvas preserves geometry, edges, labels, colors, and unknown fields", () => {
  const source = JSON.stringify({
    customRoot: { plugin: "keep" },
    nodes: [{ id: "a", type: "file", file: "src/app.ts", x: 10, y: 20, width: 300, height: 140, color: "1", customNode: { keep: true } }, { id: "b", type: "text", text: "https://127.0.0.1/never-fetch", x: 400, y: 20, width: 200, height: 100 }],
    edges: [{ id: "e", fromNode: "a", toNode: "b", label: "depends", color: "2", customEdge: "keep" }],
  });
  const parsed = parseCanvas(source);
  assert.equal(parsed.nodes[0].file, "src/app.ts");
  assert.equal(parsed.nodes[0].customNode.keep, true);
  assert.equal(parsed.edges[0].label, "depends");
  const roundTrip = parseCanvas(serializeCanvas(parsed));
  assert.deepEqual(roundTrip, parsed);
  assert.match(canvasToSearchableMarkdown(parsed, "map.canvas"), /src\/app\.ts/);
});

test("graph selection exports code locator as an Obsidian-safe extension", () => {
  const canvas = exportGraphSelectionToCanvas({
    nodes: [{ id: "symbol-1", title: "run", filePath: "src/app.ts", locator: { revisionId: "snap-1", startLine: 7 } }],
    edges: [{ fromNode: "symbol-1", toNode: "symbol-1", label: "self" }],
  });
  assert.equal(canvas.nodes[0].file, "src/app.ts");
  assert.deepEqual(canvas.nodes[0]["penguin-locator"], { revisionId: "snap-1", startLine: 7 });
  assert.equal(canvas.edges[0].label, "self");
  assert.doesNotThrow(() => parseCanvas(serializeCanvas(canvas)));
});

test("invalid Canvas is rejected without executing embedded content", () => {
  assert.throws(() => parseCanvas('{"nodes":[],"edges":['), /CANVAS_INVALID_JSON/);
});
