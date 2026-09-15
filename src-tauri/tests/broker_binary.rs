//! Live integration test. Requires the local-open Pulsar profile (container
//! `pulsar`, ports 8080/6650):
//!   docker compose -f infra/broker/docker-compose.local.yml up -d
//!
//! Self-cleaning, following the pattern in `broker_topic_list.rs`: each test
//! produces into its own `broker-spike-` prefixed topic, wraps its
//! assertions in a `Result`-returning inner block, deletes that topic via
//! Admin REST (`?force=true`, since messages were produced into it)
//! unconditionally afterwards — on the failure path as well as the success
//! path — and only then surfaces the original assertion failure. It also
//! re-verifies the topic is actually gone rather than assuming the delete
//! call worked.
use penguin_lib::broker::adapters::pulsar::binary;

const BROKER: &str = "pulsar://localhost:6650";
const ADMIN: &str = "http://localhost:8080";
const TENANT: &str = "public";
const NAMESPACE: &str = "default";

/// DELETE .../{topic}?force=true — these topics have produced messages, so
/// a plain delete (no force) would be refused. Best-effort: called from a
/// cleanup path that must run even if an earlier assertion already failed.
async fn delete_topic(short_name: &str) {
    let http = reqwest::Client::new();
    let _ = http
        .delete(format!(
            "{ADMIN}/admin/v2/persistent/{TENANT}/{NAMESPACE}/{short_name}?force=true"
        ))
        .send()
        .await;
}

/// True if `full_name` still appears in the namespace's topic list — used
/// to confirm cleanup actually took effect rather than assuming the delete
/// call worked.
async fn topic_exists(full_name: &str) -> bool {
    let http = reqwest::Client::new();
    let res = http
        .get(format!(
            "{ADMIN}/admin/v2/persistent/{TENANT}/{NAMESPACE}"
        ))
        .send()
        .await
        .expect("list topics: request failed");
    let names: Vec<String> = res
        .json()
        .await
        .expect("list topics: failed to parse response");
    names.iter().any(|n| n == full_name)
}

#[tokio::test]
async fn produces_then_reads_back_without_acking() {
    let topic = "persistent://public/default/broker-spike-binary";
    let short_name = "broker-spike-binary";

    let result: Result<(), String> = async {
        let id = binary::produce_one(
            BROKER,
            topic,
            b"spike-payload".to_vec(),
            vec![("correlationId".into(), "spike-corr".into())],
        )
        .await
        .map_err(|e| format!("produce must succeed over the binary protocol: {e}"))?;
        if id.is_empty() {
            return Err("produce returns a message id".to_string());
        }

        let msgs = binary::read_without_ack(BROKER, topic, 1)
            .await
            .map_err(|e| {
                format!("reader must read without a subscription and without acking: {e}")
            })?;

        if msgs.len() != 1 {
            return Err(format!("expected 1 message, got {}", msgs.len()));
        }
        if msgs[0].payload != b"spike-payload" {
            return Err(format!(
                "expected payload b\"spike-payload\", got {:?}",
                msgs[0].payload
            ));
        }
        let corr = msgs[0]
            .properties
            .iter()
            .find(|(k, _)| k == "correlationId")
            .map(|(_, v)| v.as_str());
        if corr != Some("spike-corr") {
            return Err(format!(
                "correlation keys must survive the round trip, got {corr:?}"
            ));
        }
        Ok(())
    }
    .await;

    // Cleanup, unconditionally — runs whether the assertions above passed
    // or failed.
    delete_topic(short_name).await;

    result.expect("assertion failed (see message) — topic has already been cleaned up");

    assert!(
        !topic_exists(topic).await,
        "topic survived cleanup: {topic}"
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
    let short_name = "broker-spike-binary-readtwice";

    let result: Result<(), String> = async {
        binary::produce_one(
            BROKER,
            topic,
            b"readtwice-payload".to_vec(),
            vec![("correlationId".into(), "readtwice-corr".into())],
        )
        .await
        .map_err(|e| format!("seed produce must succeed: {e}"))?;

        let first = binary::read_without_ack(BROKER, topic, 1)
            .await
            .map_err(|e| format!("first read: {e}"))?;
        if first.is_empty() {
            return Err("first read must return the seeded message, not nothing".to_string());
        }

        let second = binary::read_without_ack(BROKER, topic, 1)
            .await
            .map_err(|e| format!("second read: {e}"))?;
        if second.is_empty() {
            return Err(
                "second read came back empty: the Reader acked and consumed the message on the \
                 first read, so the non-acking design assumption behind Phase C is false"
                    .to_string(),
            );
        }

        if first.len() != second.len() {
            return Err(format!(
                "reads must be repeatable: first.len()={} second.len()={}",
                first.len(),
                second.len()
            ));
        }
        if first[0].payload != b"readtwice-payload" {
            return Err(format!(
                "first read must return the content actually produced, got {:?}",
                first[0].payload
            ));
        }
        if second[0].payload != first[0].payload {
            return Err(format!(
                "second read must return the same content as the first: first={:?} second={:?}",
                first[0].payload, second[0].payload
            ));
        }

        Ok(())
    }
    .await;

    // Cleanup, unconditionally — runs whether the assertions above passed
    // or failed.
    delete_topic(short_name).await;

    result.expect("assertion failed (see message) — topic has already been cleaned up");

    assert!(
        !topic_exists(topic).await,
        "topic survived cleanup: {topic}"
    );
}
