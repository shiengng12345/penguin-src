//! Phase 0 consumer simulator (V-B7).
//!
//! Exists for one reason: the bundled `pulsar-client` CLI has no nack/DLQ
//! flags, so the properties Pulsar attaches to retried and dead-lettered
//! messages cannot be observed without a real consumer. Run it, then read
//! the DLQ topic (`docs/broker/retry-dlq-contract.md` records the observed
//! keys) — never copy property names from documentation.
//!
//! API shapes here were confirmed against the vendored `pulsar` 6.9.0
//! source (`~/.cargo/registry/src/.../pulsar-6.9.0/src/consumer/`), not
//! assumed from the crate's docs:
//! - `DeadLetterPolicy` is exported at `pulsar::consumer::DeadLetterPolicy`,
//!   not at the crate root (unlike `ConsumerOptions`).
//! - `InitialPosition` likewise lives at `pulsar::consumer::InitialPosition`
//!   (see `broker/adapters/pulsar/binary.rs`, which uses the same path).
//! - The DLQ redirect is entirely client-side: `ConsumerEngine` (in
//!   `consumer/engine.rs`) inspects the broker-supplied `redelivery_count`
//!   on each delivery, and once it is `>= max_redeliver_count` the engine
//!   itself produces the message onto `dead_letter_topic` (via
//!   `self.client.send`) and acks the original — the broker has no DLQ
//!   feature of its own here. That send only *adds* two system properties
//!   with `entry(..).or_insert_with(..)` — `REAL_TOPIC` and
//!   `ORIGIN_MESSAGE_ID` — so any property already on the message
//!   (`correlationId`, `traceId`) survives untouched.
//!
//! Also seeds a second scratch topic (`broker-sim-peek-backlog`) with a real
//! backlog and a real subscription, for the strengthened V-B2 proof that
//! peeking never advances a subscription's cursor even on a populated topic
//! (Admin REST alone cannot produce, so this was not provable before).
//!
//! Usage: cargo run --bin broker_sim -- [broker_url] [admin_url]
//!   defaults: pulsar://localhost:6650, http://localhost:8080
use futures::StreamExt;
use penguin_lib::broker::adapters::pulsar::binary;
use pulsar::{
    consumer::{DeadLetterPolicy, InitialPosition},
    Consumer, ConsumerOptions, Pulsar, SubType, TokioExecutor,
};

const TOPIC: &str = "persistent://public/default/broker-sim-source";
const DLQ: &str = "persistent://public/default/broker-sim-source-DLQ";

// Second scratch topic, separate from the DLQ flow above: that flow's only
// message ends up acked (redirected to the DLQ), so it can't demonstrate a
// real backlog. This one is produced-to and left untouched by any consumer,
// so `tests/broker-dlq-properties.test.mjs` can peek it and prove peek does
// not move a real subscription's cursor on a populated topic (V-B2, strong
// — Admin REST alone cannot produce, so this is the first time that proof
// has been possible; see the controller's addendum in the Task 6 brief).
const BACKLOG_TOPIC: &str = "persistent://public/default/broker-sim-peek-backlog";
const BACKLOG_SUB: &str = "broker-sim-peek-sub";
const BACKLOG_COUNT: usize = 5;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "pulsar://localhost:6650".into());
    let admin_url = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "http://localhost:8080".into());

    // Produce one message carrying correlation keys via Task 5's binary
    // transport (Admin REST cannot produce — see binary.rs), so we can see
    // whether they survive the retry/DLQ hop.
    let id = binary::produce_one(
        &url,
        TOPIC,
        b"will-fail".to_vec(),
        vec![
            ("correlationId".to_string(), "sim-corr-1".to_string()),
            ("traceId".to_string(), "sim-trace-1".to_string()),
        ],
    )
    .await?;
    println!("produced message {id} to {TOPIC}");

    // Consume and nack every delivery so it exhausts redelivery and lands
    // in the DLQ. Needs the raw `pulsar` crate directly: nack/DLQ has no
    // wrapper in binary.rs (Task 5 only covered produce/read-without-ack).
    let pulsar: Pulsar<_> = Pulsar::builder(&url, TokioExecutor).build().await?;
    let mut consumer: Consumer<Vec<u8>, _> = pulsar
        .consumer()
        .with_topic(TOPIC)
        .with_subscription("sim-sub")
        .with_subscription_type(SubType::Shared)
        .with_dead_letter_policy(DeadLetterPolicy {
            max_redeliver_count: 2,
            dead_letter_topic: DLQ.to_string(),
        })
        .with_options(ConsumerOptions {
            initial_position: InitialPosition::Earliest,
            ..Default::default()
        })
        .build()
        .await?;

    let mut nacked = 0;
    while nacked < 4 {
        match tokio::time::timeout(std::time::Duration::from_secs(10), consumer.next()).await {
            Ok(Some(Ok(msg))) => {
                println!("nack #{} id={:?}", nacked + 1, msg.message_id());
                consumer.nack(&msg).await?;
                nacked += 1;
            }
            Ok(Some(Err(e))) => return Err(e.into()),
            // Timeout, or the stream ended (expected once the message has
            // been redirected to the DLQ and acked on the source topic —
            // there is nothing left to redeliver).
            Ok(None) | Err(_) => break,
        }
    }
    println!("nacked {nacked} deliveries; check {DLQ}");

    // Seed the backlog topic for the strong V-B2 (peek-never-advances-cursor)
    // proof. Admin REST cannot produce (V-E5), so these `BACKLOG_COUNT` real
    // messages exist only because this binary — the one thing in Phase 0
    // with a real producer — put them there. Nothing here ever consumes or
    // acks on `BACKLOG_SUB`, so its backlog stays at `BACKLOG_COUNT` for the
    // JS test to peek against.
    for i in 0..BACKLOG_COUNT {
        binary::produce_one(
            &url,
            BACKLOG_TOPIC,
            format!("backlog-msg-{i}").into_bytes(),
            vec![("seq".to_string(), i.to_string())],
        )
        .await?;
    }
    println!("produced {BACKLOG_COUNT} messages to {BACKLOG_TOPIC}");

    // Create the subscription at the earliest position via Admin REST, the
    // same mechanism `scripts/broker-capability-probe.mjs` uses for its
    // (empty-topic) V-B2 proof — this is what makes the subscription "real"
    // rather than an artifact of a consumer client's own bookkeeping.
    let http = reqwest::Client::new();
    let sub_url =
        format!("{admin_url}/admin/v2/persistent/public/default/broker-sim-peek-backlog/subscription/{BACKLOG_SUB}");
    let resp = http
        .put(&sub_url)
        .header("Content-Type", "application/json")
        .body(r#"{"ledgerId":-1,"entryId":-1}"#)
        .send()
        .await?;
    println!(
        "created subscription {BACKLOG_SUB} on {BACKLOG_TOPIC}: HTTP {}",
        resp.status()
    );

    Ok(())
}
