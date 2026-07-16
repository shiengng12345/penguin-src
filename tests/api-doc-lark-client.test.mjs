import assert from "node:assert/strict";
import { test } from "node:test";
import { LarkCliDocumentClient } from "../packages/knowledge-cli/dist/lark-document-client.js";

test("real Lark client uses argv arrays, bounded XML fetch, and stdin content", async () => {
  const calls = [];
  const runner = { run: async (argv, stdin) => {
    calls.push({ argv, stdin });
    if (argv[1] === "+fetch") return { code: 0, stdout: JSON.stringify({ ok: true, data: { document: { document_id: "doc-1", revision_id: 7, content: '<p id="blk-begin">PENGUIN_API_DOC_BEGIN:v1:doc:key:summary</p><p id="blk-content">old</p><p id="blk-end">PENGUIN_API_DOC_END:v1:doc:key:summary</p>' } } }), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ ok: true, data: { document: { revision_id: 8, document_id: "doc-1" } } }), stderr: "" };
  } };
  const client = new LarkCliDocumentClient(runner);
  const snapshot = await client.fetchFull("node;--danger", 7);
  assert.equal(snapshot.documentId, "doc-1");
  assert.equal(snapshot.blocks.length, 3);
  await client.replaceSection({ nodeToken: "node;--danger", sectionKey: "summary", xml: '<p style="color:#999999">PENGUIN_API_DOC_BEGIN:v1:doc:key:summary</p><p>new</p><p style="color:#999999">PENGUIN_API_DOC_END:v1:doc:key:summary</p>', revisionId: 7 });
  assert.ok(calls.every((call) => call.argv.includes("--as") && call.argv.includes("user")));
  assert.ok(calls.some((call) => call.argv.includes("--content") && call.stdin?.includes("<p>new</p>")));
  assert.ok(calls.every((call) => call.argv[0] === "docs"));
});

test("Lark confirmation-required responses remain explicit", async () => {
  const client = new LarkCliDocumentClient({ run: async () => ({ code: 10, stdout: JSON.stringify({ ok: false, error: { type: "confirmation_required", message: "confirm" } }), stderr: "" }) });
  await assert.rejects(() => client.fetchFull("node"), (error) => error.code === 10 && /confirm/.test(error.message));
});
