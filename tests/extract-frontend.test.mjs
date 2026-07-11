import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSymbols } from "../packages/knowledge-indexer/dist/extract.js";

const CFG = { dispatcher: "requestApi",
  serviceEnumMap: { "NT_SERVICE_INTERFACE.SKINFRAGMENT": "SkinFragment" },
  wrappers: { "SkinFragment": "NtSkinFragmentService" } };

test("call attributed to enclosing fn", async () => {
  const src = `export function useSF() {
  async function claim() {
    return WebServices.requestApi({ service: NT_SERVICE_INTERFACE.SKINFRAGMENT, functionName: 'claimDailyFragment' })
  }
  return { claim }
}`;
  const out = await extractSymbols({ lang: "tsx", source: src, relPath: "vm.tsx", frontendGrpcConfig: CFG });
  assert.equal(out.frontendGrpcCalls.length, 1);
  assert.equal(out.frontendGrpcCalls[0].functionName, "claimDailyFragment");
  assert.ok(out.frontendGrpcCalls[0].enclosingQualifiedName?.endsWith("claim"));
});

test("wrapper file yields verified methods", async () => {
  const src = `class NtSkinFragmentService { static claimDailyFragment = (r) => this._net.claimDailyFragment(r) }`;
  const out = await extractSymbols({ lang: "ts", source: src, relPath: "w.ts", frontendGrpcConfig: CFG });
  assert.deepEqual(out.wrapperVerified["NtSkinFragmentService"], ["claimDailyFragment"]);
});
