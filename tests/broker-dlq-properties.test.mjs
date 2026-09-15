// tests/broker-dlq-properties.test.mjs
// Guards the retry/DLQ contract: if a broker upgrade renames these properties,
// this fails before Phase B's Message Inspector starts showing Unknown.
//
// Also carries the strengthened V-B2 proof (peeking never advances a
// subscription's cursor) against a POPULATED topic with a real backlog.
// `scripts/broker-capability-probe.mjs`'s own V-B2 check only has an empty
// scratch topic to work with (Admin REST cannot produce — V-E5), so it can
// only prove peek doesn't fabricate cursor movement, not that it leaves a
// real message's cursor untouched. `src-tauri/src/bin/broker_sim.rs` is the
// only thing in Phase 0 with a real producer, so it seeds
// `broker-sim-peek-backlog` with real messages and a real subscription,
// making the strong proof possible here for the first time. The existing
// empty-topic V-B2 assertion in the probe script is untouched — both stand.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const ADMIN = process.env.BROKER_ADMIN_URL ?? "http://localhost:8080";
const DLQ_PATH = "public/default/broker-sim-source-DLQ";
const BACKLOG_TOPIC = "persistent://public/default/broker-sim-peek-backlog";
const BACKLOG_TOPIC_PATH = "public/default/broker-sim-peek-backlog";
const BACKLOG_SUB = "broker-sim-peek-sub";

test("DLQ messages carry the documented properties", async (t) => {
  const res = await fetch(`${ADMIN}/admin/v2/persistent/${DLQ_PATH}/subscription/insp/position/1`);
  if (res.status === 404) {
    t.skip("run `cargo run --bin broker_sim` first to populate the DLQ");
    return;
  }
  assert.equal(res.status, 200);

  const props = JSON.parse(res.headers.get("x-pulsar-property") ?? "{}");
  const doc = await readFile(new URL("../docs/broker/retry-dlq-contract.md", import.meta.url), "utf8");

  for (const key of Object.keys(props)) {
    assert.ok(doc.includes(key), `property "${key}" appeared on the wire but is not in retry-dlq-contract.md`);
  }
  assert.ok(props.correlationId, "original correlation keys must survive the DLQ hop");
  assert.ok(props.traceId, "traceId must survive the DLQ hop");
  assert.ok(props.REAL_TOPIC, "client-added REAL_TOPIC must be present on a dead-lettered message");
  assert.ok(props.ORIGIN_MESSAGE_ID, "client-added ORIGIN_MESSAGE_ID must be present on a dead-lettered message");
});

test("peeking never advances the cursor on a populated topic (V-B2, strong)", async (t) => {
  // Read markDeletePosition / readPosition (internalStats) and msgBacklog
  // (stats) before touching anything.
  const statsUrl = `${ADMIN}/admin/v2/persistent/${BACKLOG_TOPIC_PATH}/stats`;
  const internalUrl = `${ADMIN}/admin/v2/persistent/${BACKLOG_TOPIC_PATH}/internalStats`;

  const beforeInternalRes = await fetch(internalUrl);
  if (beforeInternalRes.status === 404) {
    t.skip(`run \`cargo run --bin broker_sim\` first to populate ${BACKLOG_TOPIC} with a real backlog`);
    return;
  }
  assert.equal(beforeInternalRes.status, 200);
  const beforeInternal = await beforeInternalRes.json();
  const beforeCursor = beforeInternal.cursors?.[BACKLOG_SUB];
  assert.ok(beforeCursor, `subscription "${BACKLOG_SUB}" must exist on ${BACKLOG_TOPIC} — run broker_sim first`);

  const beforeStatsRes = await fetch(statsUrl);
  assert.equal(beforeStatsRes.status, 200);
  const beforeStats = await beforeStatsRes.json();
  const beforeBacklog = beforeStats.subscriptions?.[BACKLOG_SUB]?.msgBacklog;
  assert.ok(
    typeof beforeBacklog === "number" && beforeBacklog > 0,
    `expected a real backlog on ${BACKLOG_TOPIC}, got ${beforeBacklog} — this proof requires populated messages, ` +
      "not an empty topic (that weaker case is already covered by V-B2 in broker-capability-probe.mjs)"
  );

  // Peek several real messages through the Admin REST peek endpoint.
  for (const pos of [1, 2, 3]) {
    const peekRes = await fetch(
      `${ADMIN}/admin/v2/persistent/${BACKLOG_TOPIC_PATH}/subscription/${BACKLOG_SUB}/position/${pos}`
    );
    assert.equal(peekRes.status, 200, `peek at position ${pos} must succeed`);
  }

  // Re-read the same three values and assert every one is unchanged.
  const afterInternalRes = await fetch(internalUrl);
  assert.equal(afterInternalRes.status, 200);
  const afterInternal = await afterInternalRes.json();
  const afterCursor = afterInternal.cursors?.[BACKLOG_SUB];

  const afterStatsRes = await fetch(statsUrl);
  assert.equal(afterStatsRes.status, 200);
  const afterStats = await afterStatsRes.json();
  const afterBacklog = afterStats.subscriptions?.[BACKLOG_SUB]?.msgBacklog;

  assert.equal(
    afterCursor.markDeletePosition,
    beforeCursor.markDeletePosition,
    "peeking must not move markDeletePosition on a real, populated backlog"
  );
  assert.equal(
    afterCursor.readPosition,
    beforeCursor.readPosition,
    "peeking must not move readPosition on a real, populated backlog"
  );
  assert.equal(
    afterBacklog,
    beforeBacklog,
    "peeking must not drain msgBacklog on a real, populated backlog"
  );
});
