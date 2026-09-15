//! Live integration test. Requires the local-open Pulsar profile (container
//! `pulsar`, ports 8080/6650):
//!   docker compose -f infra/broker/docker-compose.local.yml up -d
use penguin_lib::broker::adapters::pulsar::binary;

const BROKER: &str = "pulsar://localhost:6650";

#[tokio::test]
async fn produces_then_reads_back_without_acking() {
    let topic = "persistent://public/default/broker-spike-binary";

    let id = binary::produce_one(
        BROKER,
        topic,
        b"spike-payload".to_vec(),
        vec![("correlationId".into(), "spike-corr".into())],
    )
    .await
    .expect("produce must succeed over the binary protocol");
    assert!(!id.is_empty(), "produce returns a message id");

    let msgs = binary::read_without_ack(BROKER, topic, 1)
        .await
        .expect("reader must read without a subscription and without acking");

    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].payload, b"spike-payload");
    assert_eq!(
        msgs[0]
            .properties
            .iter()
            .find(|(k, _)| k == "correlationId")
            .map(|(_, v)| v.as_str()),
        Some("spike-corr"),
        "correlation keys must survive the round trip"
    );
}

#[tokio::test]
async fn reading_twice_yields_the_same_messages() {
    // A Reader must not consume. If the second read comes back empty, the
    // transport is acking behind our back and Phase C's design is wrong.
    // Each call below opens its own client and its own reader end-to-end —
    // nothing is cached across the two calls — so this is a genuine repeat
    // read, not a re-use of one open stream.
    let topic = "persistent://public/default/broker-spike-binary";
    let first = binary::read_without_ack(BROKER, topic, 1)
        .await
        .expect("first read");
    let second = binary::read_without_ack(BROKER, topic, 1)
        .await
        .expect("second read");
    assert_eq!(first.len(), second.len(), "reads must be repeatable");
    assert_eq!(first[0].payload, second[0].payload);
}
