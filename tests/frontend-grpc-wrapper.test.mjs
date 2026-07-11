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
      instanceField = (r) => this._net.instanceField(r)
      public static pubMethod = async (r) => { return this._net.pubMethod(r || {}) }
    }`;
  const s = await verifiedMethodsFromSource("tsx", src, "NtSkinFragmentService");
  assert.ok(s.has("claimDailyFragment"));
  assert.ok(s.has("getInviteLink"));
  assert.ok(!s.has("renamed"));
  assert.ok(!s.has("batched"));
  assert.ok(!s.has("instanceField"));
  assert.ok(s.has("pubMethod"));
});

test("optional chaining: this._net?.X(...) counts as a _net forward", async () => {
  const src = `
    class NtSkinFragmentService {
      public static optChain = (r) => { return this._net?.optChain(r) }
      public static optRenamed = (r) => this._net?.somethingElse(r)
    }`;
  const s = await verifiedMethodsFromSource("tsx", src, "NtSkinFragmentService");
  assert.ok(s.has("optChain"), "optional-chain sole forward must be VERIFIED");
  assert.ok(!s.has("optRenamed"), "optional-chain rename must be EXCLUDED");
});
