# Retry / DLQ message contract (observed)

Source: local Pulsar 4.2.4 (container `pulsar`, standalone), `cargo run --bin
broker_sim -- pulsar://localhost:6650` (`src-tauri/src/bin/broker_sim.rs`),
2026-09-15.

Resolves V-B7: the bundled `pulsar-client` CLI has no nack/DLQ flags, so
these names had never been observed on the wire before this task. Everything
below comes from one real run, read back via Admin REST peek — nothing here
is copied from Apache Pulsar's documentation.

## What actually happens (client-side redirect, not a broker feature)

The `pulsar` Rust crate 6.9.0 implements dead-lettering entirely in the
client. There is no separate "retry topic" hop (unlike the Java client's
`RetryTopic` feature): the consumer negative-acks a message, the broker
redelivers it on the **same** subscription with an incremented
`redelivery_count` on the envelope, and once the local `ConsumerEngine` (in
the crate, `src/consumer/engine.rs`) sees `redelivery_count >=
max_redeliver_count`, it produces the message onto the configured
`dead_letter_topic` itself and acks the original. So "the broker's own
retry/DLQ properties" is somewhat of a misnomer — what actually gets
attached is two properties the *client library* adds via
`entry(..).or_insert_with(..)` (i.e. only if not already present), so they
never clobber the producer's own keys.

## Observed run

1. Produced one message to `persistent://public/default/broker-sim-source`
   via `binary::produce_one`, with properties `correlationId=sim-corr-1`,
   `traceId=sim-trace-1`. Message id: `261:0`.
2. Consumer `sim-sub` (Shared) with `DeadLetterPolicy { max_redeliver_count:
   2, dead_letter_topic: "persistent://public/default/broker-sim-source-DLQ"
   }`. Nacked the message on delivery #1 and #2; delivery #3 (redelivery_count
   == 2) triggered the client-side DLQ redirect instead of being handed to
   `consumer.next()` — the simulator's receive loop then timed out (10s) with
   nothing left to read, exactly as expected once the source-topic message is
   acked.
3. Peeked position 1 of a fresh subscription (`insp`) on the DLQ topic:

   ```
   PUT  /admin/v2/persistent/public/default/broker-sim-source-DLQ/subscription/insp  {"ledgerId":-1,"entryId":-1}
   -> 204

   GET  /admin/v2/persistent/public/default/broker-sim-source-DLQ/subscription/insp/position/1
   -> 200
   X-Pulsar-Message-ID: 262:0
   X-Pulsar-PROPERTY: {"traceId":"sim-trace-1","REAL_TOPIC":"persistent://public/default/broker-sim-source","ORIGIN_MESSAGE_ID":"261:0:-1","correlationId":"sim-corr-1"}
   X-Pulsar-publish-time: 2026-09-15T16:51:11.802Z
   X-Pulsar-Is-Encrypted: false
   X-Pulsar-producer-name: standalone-242-12
   X-Pulsar-sequence-id: 0
   X-Pulsar-Base64-schema-version:
   X-Pulsar-txn-uncommitted: false
   ```

   (Header order above is verbatim from the response; `X-Pulsar-PROPERTY`'s
   JSON key order is whatever the broker/client serialized, not something to
   read meaning into.)

## Table: properties inside `X-Pulsar-PROPERTY` on a dead-lettered message

| Property key | Example value | Meaning | Observed |
|---|---|---|---|
| `correlationId` | `sim-corr-1` | Original producer property, untouched by the DLQ hop. | ✅ |
| `traceId` | `sim-trace-1` | Original producer property, untouched by the DLQ hop. | ✅ |
| `REAL_TOPIC` | `persistent://public/default/broker-sim-source` | Added by the **client library** (not the broker) when it redirects to the DLQ: the source topic the message originally failed on. Only added if a property of that name wasn't already present (`entry().or_insert_with()`). | ✅ |
| `ORIGIN_MESSAGE_ID` | `261:0:-1` | Added by the **client library**: `ledgerId:entryId:partition` of the message on the source topic (batched messages get a fourth `:batchIndex` segment — not observed here since this message was not batched). | ✅ |
| `RECONSUMETIMES` | — | A Java-client retry-topic property (`RetryTopic` feature). This Rust crate (6.9.0) has no retry-topic concept — it redelivers on the same subscription and jumps straight to the DLQ — so this property does not exist in this pipeline. | not observed |
| `DELAY_TIME` | — | Same Java-client retry-topic feature as above; not implemented by this crate. | not observed |
| `REAL_SUBSCRIPTION` | — | Sometimes documented for retry-topic setups elsewhere; not part of this crate's DLQ code path (`src/consumer/engine.rs` only sets `REAL_TOPIC` and `ORIGIN_MESSAGE_ID`). | not observed |

Original producer properties (`correlationId`, `traceId`) survived the DLQ
hop: **yes** — both were present, unchanged, in the peeked DLQ message.

## Other headers seen on the peek response (not properties, listed for completeness)

`X-Pulsar-Message-ID`, `X-Pulsar-publish-time`, `X-Pulsar-Is-Encrypted`,
`X-Pulsar-producer-name`, `X-Pulsar-sequence-id`,
`X-Pulsar-Base64-schema-version`, `X-Pulsar-txn-uncommitted`. These are
standard Admin REST peek envelope headers on *every* peeked message
(confirmed in Task 5's spike against `broker-sim-source` too), not
DLQ-specific — they are not part of this contract and Phase B/D must not
read retry/DLQ meaning into them.

## Rules for Phase B and D

- Only keys marked ✅ above may be read from `X-Pulsar-PROPERTY` when
  reconstructing a message's retry/DLQ history. Anything else — including
  `RECONSUMETIMES` and `DELAY_TIME`, which do not exist in this pipeline —
  is `Unknown` in the UI, not a value to guess at.
- There is no separate "retry topic": redelivery happens on the source
  topic's own subscription, tracked by the broker's `redelivery_count`,
  which is not itself exposed as an `X-Pulsar-PROPERTY` key — only the two
  client-added keys are.
- `REAL_TOPIC` and `ORIGIN_MESSAGE_ID` are added with "insert if absent"
  semantics, so a producer that already set a property with either of those
  exact names would have its own value survive instead of the DLQ metadata.
  Phase B/D should treat that as a possible (if unlikely) collision, not
  assume `REAL_TOPIC`/`ORIGIN_MESSAGE_ID` always mean what this doc says.
- Re-run the simulator whenever the broker version or the `pulsar` crate
  version changes — this contract is pinned to Pulsar 4.2.4 and
  `pulsar` 6.9.0.
