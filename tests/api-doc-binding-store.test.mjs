import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LarkDocumentBindingStore } from "../packages/knowledge-cli/dist/index.js";

test("Lark binding requires explicit node identity and preserves multi-repo revisions", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-binding-")); const store = new LarkDocumentBindingStore(join(dir, "bindings.json")); assert.throws(() => store.bind({ documentKey: "doc", nodeToken: "", documentId: "d", revisionId: 1, sourceRevisions: {}, sourceRevisionSetHash: "h", verifiedAt: new Date().toISOString() }), /nodeToken/);
  const binding = store.bind({ documentKey: "doc", nodeToken: "wikcnBoundNode", documentId: "d", revisionId: 3, sourceRevisions: { auth: "a2", fpmsnt: "f7" }, sourceRevisionSetHash: "hash", verifiedAt: new Date().toISOString() }); assert.deepEqual(binding.sourceRevisions, { auth: "a2", fpmsnt: "f7" }); assert.equal(store.resolve("doc").nodeToken, "wikcnBoundNode"); assert.throws(() => store.bind({ ...binding, nodeToken: "wikcnOther", revisionId: 4, sourceRevisionSetHash: "hash2" }), /document key already bound/); assert.equal(store.listCandidates([{ nodeToken: "a", documentId: "1", title: "same", revisionId: 1 }, { nodeToken: "b", documentId: "2", title: "same", revisionId: 1 }]).length, 2);
});
