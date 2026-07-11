// tests/frontend-grpc-wrapper.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifiedMethodsFromSource } from "../packages/knowledge-indexer/dist/frontend-grpc-client.js";

test("collects sole-forward methods; rejects rename/batch", async () => {
  const src = `
    class NtSkinFragmentService {
      static claimDailyFragment = (r) => this._net.claimDailyFragment(r)
      static getInviteLink = async (r) => { return this._net.getInviteLink(r) }
      static renamed = (r) => this._net.somethingElse(r)
      static batched = (r) => { this._net.a(r); return this._net.claimGift(r) }
    }`;
  const s = await verifiedMethodsFromSource("tsx", src, "NtSkinFragmentService");
  assert.ok(s.has("claimDailyFragment"));
  assert.ok(s.has("getInviteLink"));
  assert.ok(!s.has("renamed"));
  assert.ok(!s.has("batched"));
});
