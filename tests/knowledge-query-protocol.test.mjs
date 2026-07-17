import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchQueryFrame, encodeFrame, parseFrame, queryHello } from "../packages/knowledge-cli/dist/query-protocol.js";
import { QueryExecutionQueue } from "../packages/knowledge-cli/dist/query-server.js";

test("query protocol is one JSON frame per line and has stable hello", async () => {
  const hello = queryHello(11);
  assert.equal(hello.protocolVersion, 1);
  assert.equal(JSON.parse(encodeFrame(hello)).schemaVersion, 11);
  assert.deepEqual(parseFrame('{"type":"request","id":"r1","capabilityId":"knowledge.search","input":{"query":"x"}}'), { type: "request", id: "r1", capabilityId: "knowledge.search", input: { query: "x" } });
  assert.throws(() => parseFrame("not-json"), /MALFORMED_FRAME/);
  assert.throws(() => parseFrame('{"type":"request","id":"r1","protocolVersion":99,"capabilityId":"knowledge.search","input":{}}'), /PROTOCOL_MAJOR_MISMATCH/);
});

test("query protocol isolates typed failures and cancellation", async () => {
  const cancelled = new Set();
  assert.equal(await dispatchQueryFrame({ type: "cancel", id: "r2" }, async () => null, cancelled), null);
  assert.equal((await dispatchQueryFrame({ type: "request", id: "r2", capabilityId: "x", input: {} }, async () => "bad", cancelled)).error.code, "CANCELLED");
  assert.equal((await dispatchQueryFrame({ type: "request", id: "r3", capabilityId: "x", input: {} }, async () => { throw Object.assign(new Error("no"), { code: "TEST_ERROR" }); }, cancelled)).error.code, "TEST_ERROR");
});

test("in-flight cancellation returns CANCELLED after the invocation observes the abort signal", async () => {
  const cancelled = new Set();
  const active = new Map();
  const pending = dispatchQueryFrame({ type: "request", id: "slow", capabilityId: "x", input: {} }, (_id, _input, signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve("late-result"), { once: true });
  }), cancelled, active);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await dispatchQueryFrame({ type: "cancel", id: "slow" }, async () => null, cancelled, active), null);
  assert.equal((await pending).error.code, "CANCELLED");
});

test("concurrent requests correlate by id and may complete out of order", async () => {
  const active = new Map();
  const pending = new Map();
  const invoke = (_capability, input) => new Promise((resolve) => {
    pending.set(input.id, resolve);
    active.set(input.id, true);
  });
  const first = dispatchQueryFrame({ type: "request", id: "slow", capabilityId: "x", input: { id: "slow" } }, invoke, new Set(), active);
  const second = dispatchQueryFrame({ type: "request", id: "fast", capabilityId: "x", input: { id: "fast" } }, invoke, new Set(), active);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active.size, 2);
  pending.get("fast")("fast-result");
  pending.get("slow")("slow-result");
  assert.deepEqual(await second, { type: "response", id: "fast", ok: true, result: "fast-result" });
  assert.deepEqual(await first, { type: "response", id: "slow", ok: true, result: "slow-result" });
});

test("execution queue serializes mutations while reads do not wait", async () => {
  const queue = new QueryExecutionQueue();
  const events = [];
  let releaseFirst;
  const first = queue.run(true, async () => {
    events.push("mutation-1-start");
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push("mutation-1-end");
    return 1;
  });
  const second = queue.run(true, async () => { events.push("mutation-2"); return 2; });
  const read = queue.run(false, async () => { events.push("read"); return 3; });
  await read;
  assert.deepEqual(new Set(events), new Set(["mutation-1-start", "read"]));
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.equal(events.at(-2), "mutation-1-end");
  assert.equal(events.at(-1), "mutation-2");
});
