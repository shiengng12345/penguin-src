import assert from "node:assert/strict";
import { test } from "node:test";
import { foldTopics } from "@penguin/broker-core";

// Exactly what GET /admin/v2/persistent/public/default returns for one
// non-partitioned topic plus one 3-partition topic.
const LISTED = [
  "persistent://public/default/orders",
  "persistent://public/default/events-partition-0",
  "persistent://public/default/events-partition-1",
  "persistent://public/default/events-partition-2",
];
const PARTITIONED = ["persistent://public/default/events"];

test("a partitioned topic folds into one row, not N", () => {
  const folded = foldTopics(LISTED, PARTITIONED);
  assert.equal(folded.length, 2, "4 listed entries collapse to 2 logical topics");

  const events = folded.find((t) => t.shortName === "events");
  assert.equal(events.partitions, 3);
  assert.deepEqual(events.partitionNames, [
    "persistent://public/default/events-partition-0",
    "persistent://public/default/events-partition-1",
    "persistent://public/default/events-partition-2",
  ]);
});

test("a non-partitioned topic keeps partitions at 0", () => {
  const orders = foldTopics(LISTED, PARTITIONED).find((t) => t.shortName === "orders");
  assert.equal(orders.partitions, 0);
  assert.deepEqual(orders.partitionNames, []);
});

test("tenant and namespace are parsed out", () => {
  const orders = foldTopics(LISTED, PARTITIONED).find((t) => t.shortName === "orders");
  assert.equal(orders.tenant, "public");
  assert.equal(orders.namespace, "default");
  assert.equal(orders.persistent, true);
});

test("a topic whose name merely contains -partition- is not mistaken for one", () => {
  // A real topic can legitimately be called "my-partition-plan". It must not be
  // folded into a phantom parent.
  const listed = ["persistent://public/default/my-partition-plan"];
  const folded = foldTopics(listed, []);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].shortName, "my-partition-plan");
  assert.equal(folded[0].partitions, 0);
});

test("non-persistent topics are flagged", () => {
  const folded = foldTopics(["non-persistent://public/default/tmp"], []);
  assert.equal(folded[0].persistent, false);
});

test("an expanded partition whose parent is not in the partitioned list is not folded", () => {
  // This is the test that actually distinguishes "membership decided by the
  // /partitioned list" from "membership decided by the name pattern alone".
  // The name DOES match the -partition-N suffix, but its parent ("events")
  // is absent from partitionedTopics -- an implementation that folded purely
  // on the name pattern (ignoring partitionedTopics) would incorrectly
  // collapse this into a phantom "events" row. It must instead survive as a
  // standalone topic with its full name intact.
  const listed = ["persistent://public/default/events-partition-0"];
  const folded = foldTopics(listed, []);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].fullName, "persistent://public/default/events-partition-0");
  assert.equal(folded[0].shortName, "events-partition-0");
  assert.equal(folded[0].partitions, 0);
  assert.deepEqual(folded[0].partitionNames, []);
  assert.equal(folded.find((t) => t.shortName === "events"), undefined, "no phantom parent row");
});

test("a partitioned entry with no matching expanded partitions still gets a row, with partitions: 0", () => {
  // Pinning actual behaviour for the Rust port: if /partitioned names a
  // parent that never appears (expanded) in the topic list -- e.g. the two
  // admin calls raced, or scopes differed -- foldTopics still emits a row
  // for it rather than silently dropping the logical topic. This surfaces
  // the mismatch instead of hiding it.
  const folded = foldTopics([], ["persistent://public/default/events"]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].shortName, "events");
  assert.equal(folded[0].partitions, 0);
  assert.deepEqual(folded[0].partitionNames, []);
});
