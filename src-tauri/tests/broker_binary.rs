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
    //
    // Self-contained: this test produces its own message into its own
    // topic (distinct from `broker-spike-binary`, used by the other test)
    // so it passes whether run alone or alongside the other test, and in
    // either order. Each `read_without_ack` call below opens its own fresh
    // `Pulsar` client and its own fresh `Reader` end to end — nothing is
    // cached across the two calls — so this is a genuine repeat read, not
    // a re-use of one open stream.
    let topic = "persistent://public/default/broker-spike-binary-readtwice";

    binary::produce_one(
        BROKER,
        topic,
        b"readtwice-payload".to_vec(),
        vec![("correlationId".into(), "readtwice-corr".into())],
    )
    .await
    .expect("seed produce must succeed");

    let first = binary::read_without_ack(BROKER, topic, 1)
        .await
        .expect("first read");
    assert!(
        !first.is_empty(),
        "first read must return the seeded message, not nothing"
    );

    let second = binary::read_without_ack(BROKER, topic, 1)
        .await
        .expect("second read");
    assert!(
        !second.is_empty(),
        "second read came back empty: the Reader acked and consumed the \
         message on the first read, so the non-acking design assumption \
         behind Phase C is false"
    );

    assert_eq!(first.len(), second.len(), "reads must be repeatable");
    assert_eq!(
        first[0].payload, b"readtwice-payload",
        "first read must return the content actually produced"
    );
    assert_eq!(
        second[0].payload, first[0].payload,
        "second read must return the same content as the first"
    );
}
