// tests/frontend-grpc-client.test.mjs
// Zero-config, dispatcher-agnostic call-site extraction: any call_expression
// whose first object-literal argument has functionName: '<literal>' where the
// literal is IN the caller-supplied verifiedMethods set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFunctionNameCallsFromSource } from "../packages/knowledge-indexer/dist/frontend-grpc-client.js";

test("extracts a call whose functionName literal is verified", async () => {
  const src = `
    const res = await WebServices.requestApi({
      service: NT_SERVICE_INTERFACE.SKINFRAGMENT,
      functionName: 'claimDailyFragment',
      requestParam: { linkCode },
    })`;
  const calls = await extractFunctionNameCallsFromSource("tsx", src, new Set(["claimDailyFragment"]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].functionName, "claimDailyFragment");
});

test("dispatcher-agnostic: any call shape qualifies, not just a named dispatcher method", async () => {
  const src = `const res = await someOtherThing.whateverItsCalled({ functionName: 'claimDailyFragment' })`;
  const calls = await extractFunctionNameCallsFromSource("tsx", src, new Set(["claimDailyFragment"]));
  assert.equal(calls.length, 1);
});

test("skips a functionName literal NOT in verifiedMethods", async () => {
  const src = `WebServices.requestApi({ functionName: 'notAWrapperMethod' })`;
  const calls = await extractFunctionNameCallsFromSource("tsx", src, new Set(["claimDailyFragment"]));
  assert.equal(calls.length, 0);
});

test("skips a computed (non-literal) functionName", async () => {
  const src = `WebServices.requestApi({ functionName: fn })`;
  const calls = await extractFunctionNameCallsFromSource("tsx", src, new Set(["fn"]));
  assert.equal(calls.length, 0);
});

test("empty verifiedMethods set → no calls extracted", async () => {
  const src = `WebServices.requestApi({ functionName: 'claimDailyFragment' })`;
  const calls = await extractFunctionNameCallsFromSource("tsx", src, new Set());
  assert.equal(calls.length, 0);
});
