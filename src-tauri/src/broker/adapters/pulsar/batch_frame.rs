//! Pulsar batch frame parsing.
//!
//! When a producer batches, one BookKeeper entry holds many messages. A peek
//! returns that whole entry with `X-Pulsar-num-batch-message: N` — the body is
//! NOT a single payload. The wire layout repeats:
//!
//!   [u32 BE metadata length][SingleMessageMetadata protobuf][payload bytes]
//!
//! We only need `payload_size` (field 3) to walk the frame; the remaining
//! metadata fields are decoded opportunistically and never block a parse.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchedMessage {
    pub index: u32,
    pub payload: Vec<u8>,
    pub properties: Vec<(String, String)>,
    pub partition_key: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BatchFrameError {
    #[error("frame truncated at byte {offset} (needed {needed} more)")]
    Truncated { offset: usize, needed: usize },
    #[error("expected {expected} messages, frame yielded {actual}")]
    CountMismatch { expected: u32, actual: u32 },
    #[error("malformed metadata at byte {offset}")]
    MalformedMetadata { offset: usize },
}

/// Reads a protobuf varint. Returns (value, bytes consumed).
fn read_varint(buf: &[u8]) -> Option<(u64, usize)> {
    let mut value = 0u64;
    let mut shift = 0u32;
    for (i, &byte) in buf.iter().enumerate().take(10) {
        value |= u64::from(byte & 0x7F) << shift;
        if byte & 0x80 == 0 {
            return Some((value, i + 1));
        }
        shift += 7;
    }
    None
}

/// Extracts `payload_size` (field 3, varint) from a SingleMessageMetadata blob.
/// Unknown fields are skipped by wire type so future Pulsar versions do not break us.
fn payload_size_of(meta: &[u8]) -> Option<u64> {
    let mut pos = 0usize;
    while pos < meta.len() {
        let (tag, used) = read_varint(&meta[pos..])?;
        pos += used;
        let field = tag >> 3;
        let wire = tag & 0x7;
        match wire {
            0 => {
                let (value, used) = read_varint(&meta[pos..])?;
                pos += used;
                if field == 3 {
                    return Some(value);
                }
            }
            2 => {
                let (len, used) = read_varint(&meta[pos..])?;
                pos += used + len as usize;
            }
            5 => pos += 4,
            1 => pos += 8,
            _ => return None,
        }
    }
    None
}

pub fn parse_batch(payload: &[u8], num_messages: u32) -> Result<Vec<BatchedMessage>, BatchFrameError> {
    let mut out = Vec::with_capacity(num_messages as usize);
    let mut pos = 0usize;

    while pos < payload.len() && (out.len() as u32) < num_messages {
        if pos + 4 > payload.len() {
            return Err(BatchFrameError::Truncated { offset: pos, needed: 4 - (payload.len() - pos) });
        }
        let meta_len = u32::from_be_bytes([payload[pos], payload[pos + 1], payload[pos + 2], payload[pos + 3]]) as usize;
        pos += 4;

        if pos + meta_len > payload.len() {
            return Err(BatchFrameError::Truncated { offset: pos, needed: meta_len - (payload.len() - pos) });
        }
        let meta = &payload[pos..pos + meta_len];
        pos += meta_len;

        let size = payload_size_of(meta).ok_or(BatchFrameError::MalformedMetadata { offset: pos })? as usize;
        if pos + size > payload.len() {
            return Err(BatchFrameError::Truncated { offset: pos, needed: size - (payload.len() - pos) });
        }

        out.push(BatchedMessage {
            index: out.len() as u32,
            payload: payload[pos..pos + size].to_vec(),
            properties: Vec::new(),
            partition_key: None,
        });
        pos += size;
    }

    if out.len() as u32 != num_messages {
        return Err(BatchFrameError::CountMismatch { expected: num_messages, actual: out.len() as u32 });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a minimal frame: two messages with payloads "aa" and "bbb".
    /// SingleMessageMetadata here carries only field 3 (payload_size, varint),
    /// which is all the walker needs to find the next entry.
    fn frame() -> Vec<u8> {
        let mut buf = Vec::new();
        for payload in [&b"aa"[..], &b"bbb"[..]] {
            let meta = vec![0x18, payload.len() as u8]; // field 3, varint
            buf.extend_from_slice(&(meta.len() as u32).to_be_bytes());
            buf.extend_from_slice(&meta);
            buf.extend_from_slice(payload);
        }
        buf
    }

    #[test]
    fn splits_a_batch_frame_into_individual_messages() {
        let msgs = parse_batch(&frame(), 2).expect("frame should parse");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].payload, b"aa");
        assert_eq!(msgs[1].payload, b"bbb");
        assert_eq!(msgs[1].index, 1);
    }

    #[test]
    fn rejects_a_truncated_frame_instead_of_panicking() {
        let mut truncated = frame();
        truncated.truncate(5);
        assert!(matches!(parse_batch(&truncated, 2), Err(BatchFrameError::Truncated { .. })));
    }

    #[test]
    fn rejects_a_count_mismatch() {
        // Claiming 5 messages in a 2-message frame must be an error, not a short read.
        assert!(matches!(parse_batch(&frame(), 5), Err(BatchFrameError::CountMismatch { .. })));
    }

    /// Captured 2026-09-15 from the unauthenticated `pulsar` container (broker
    /// Phase 0 Task 4, Step 6): produced 2000 batched messages (-s 64 -b 50
    /// -bm 500) into `persistent://public/default/broker-probe-batch`, then
    /// peeked position 3. NUM_MESSAGES is the response's verbatim
    /// `X-Pulsar-num-batch-message` header value (29), not a value we chose;
    /// the fixture is 2088 bytes. The probe topic was deleted immediately
    /// after capture — see task-4-report.md for the full transcript.
    #[test]
    fn parses_a_real_frame_captured_from_pulsar() {
        const FIXTURE: &[u8] = include_bytes!("../../../../tests/fixtures/broker/batch-frame.bin");
        const NUM_MESSAGES: u32 = 29;

        let msgs = parse_batch(FIXTURE, NUM_MESSAGES).expect("real Pulsar frame should parse");
        assert_eq!(msgs.len(), NUM_MESSAGES as usize);
    }
}
