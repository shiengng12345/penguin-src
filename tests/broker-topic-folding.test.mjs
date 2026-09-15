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
