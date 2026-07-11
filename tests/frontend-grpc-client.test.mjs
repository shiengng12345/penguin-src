// tests/frontend-grpc-client.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFrontendCallsFromSource } from "../packages/knowledge-indexer/dist/frontend-grpc-client.js";

const CFG = { dispatcher: "requestApi",
  serviceEnumMap: { "NT_SERVICE_INTERFACE.SKINFRAGMENT": "SkinFragment" }, wrappers: {} };

test("extracts a real requestApi call (functionName + requestParam)", async () => {
  const src = `
    const res = await WebServices.requestApi({
      service: NT_SERVICE_INTERFACE.SKINFRAGMENT,
      functionName: 'claimDailyFragment',
      requestParam: { linkCode },
    })`;
  const calls = await extractFrontendCallsFromSource("tsx", src, CFG);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].service, "SkinFragment");
  assert.equal(calls[0].functionName, "claimDailyFragment");
});

test("skips unmapped enum and computed functionName", async () => {
  const a = await extractFrontendCallsFromSource("tsx",
    `WebServices.requestApi({ service: NT_SERVICE_INTERFACE.OTHER, functionName: 'x' })`, CFG);
  const b = await extractFrontendCallsFromSource("tsx",
    `WebServices.requestApi({ service: NT_SERVICE_INTERFACE.SKINFRAGMENT, functionName: fn })`, CFG);
  assert.equal(a.length, 0);
  assert.equal(b.length, 0);
});
