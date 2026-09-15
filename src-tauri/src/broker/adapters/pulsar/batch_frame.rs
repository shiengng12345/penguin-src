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
///
/// All position arithmetic is `checked_*`: `meta` comes from a broker-supplied
/// frame, and a length-delimited (wire type 2) field's length is an
/// attacker-controlled varint, not something bounded by `meta.len()` the way a
/// `read_varint` result is. An unchecked `pos += len` can overflow `usize`.
fn payload_size_of(meta: &[u8]) -> Option<u64> {
    let mut pos = 0usize;
    while pos < meta.len() {
        let (tag, used) = read_varint(&meta[pos..])?;
        pos = pos.checked_add(used)?;
        let field = tag >> 3;
        let wire = tag & 0x7;
        match wire {
            0 => {
                let (value, used) = read_varint(&meta[pos..])?;
                pos = pos.checked_add(used)?;
                if field == 3 {
                    return Some(value);
                }
            }
            2 => {
                let (len, used) = read_varint(&meta[pos..])?;
                pos = pos.checked_add(used)?;
                // `len` is u64; on a 32-bit target `len as usize` would
                // silently truncate a huge value into a small, wrong one.
                // Reject anything that doesn't fit instead.
                let len = usize::try_from(len).ok()?;
                pos = pos.checked_add(len)?;
            }
            5 => pos = pos.checked_add(4)?,
            1 => pos = pos.checked_add(8)?,
            _ => return None,
        }
    }
    None
}

pub fn parse_batch(payload: &[u8], num_messages: u32) -> Result<Vec<BatchedMessage>, BatchFrameError> {
    // The batch count comes from a broker-supplied header and is not trusted.
    // Growing the Vec is cheap; a huge pre-allocation is an uncatchable abort
    // (handle_alloc_error), not a panic we could catch.
    const MAX_PREALLOC: usize = 4096;
    let mut out = Vec::with_capacity((num_messages as usize).min(MAX_PREALLOC));
    let mut pos = 0usize;

    while pos < payload.len() && (out.len() as u32) < num_messages {
        // `pos <= payload.len()` is an invariant here, so bounds checks below
        // compare against the remaining length instead of adding to `pos` —
        // `pos + n > payload.len()` can overflow when `n` comes from
        // broker-supplied bytes (metadata length, payload size).
        let remaining = payload.len() - pos;
        if remaining < 4 {
            return Err(BatchFrameError::Truncated { offset: pos, needed: 4 - remaining });
        }
        let meta_len = u32::from_be_bytes([payload[pos], payload[pos + 1], payload[pos + 2], payload[pos + 3]]) as usize;
        pos += 4;

        let remaining = payload.len() - pos;
        if meta_len > remaining {
            return Err(BatchFrameError::Truncated { offset: pos, needed: meta_len - remaining });
        }
        let meta = &payload[pos..pos + meta_len];
        pos += meta_len;

        let size = payload_size_of(meta).ok_or(BatchFrameError::MalformedMetadata { offset: pos })?;
        let remaining = payload.len() - pos;
        // Compare as u64 BEFORE any downcast: `size` can be near u64::MAX
        // from a crafted varint, and `size as usize` on a 32-bit target would
        // truncate it into something a naive `pos + size` check could pass.
        if size > remaining as u64 {
            return Err(BatchFrameError::Truncated { offset: pos, needed: (size - remaining as u64) as usize });
        }
        // Safe: just proved size <= remaining <= payload.len(), which fits usize.
        let size = size as usize;

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

    /// Protobuf varint-encodes `value` (LEB128, matching `read_varint`'s
    /// decode) — used to build adversarial metadata with values `read_varint`
    /// cannot produce on its own from a short honest frame.
    fn varint_encode(mut value: u64) -> Vec<u8> {
        let mut buf = Vec::new();
        loop {
            let byte = (value & 0x7F) as u8;
            value >>= 7;
            if value != 0 {
                buf.push(byte | 0x80);
            } else {
                buf.push(byte);
                break;
            }
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
    /// peeked position 3 (2088-byte body). The probe topic was deleted
    /// immediately after capture — see task-4-report.md for the full
    /// transcript. The message count is parsed from the raw response headers
    /// captured alongside the fixture — NOT hardcoded — so this test proves
    /// parsing against the artifact's own claimed count, not a number a human
    /// transcribed by hand.
    #[test]
    fn parses_a_real_frame_captured_from_pulsar() {
        const FIXTURE: &[u8] = include_bytes!("../../../../tests/fixtures/broker/batch-frame.bin");
        const HEADERS: &str = include_str!("../../../../tests/fixtures/broker/batch-frame.headers.txt");

        let num_messages: u32 = HEADERS
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.trim()
                    .eq_ignore_ascii_case("X-Pulsar-num-batch-message")
                    .then(|| value.trim().to_string())
            })
            .expect("captured headers must include X-Pulsar-num-batch-message")
            .parse()
            .expect("X-Pulsar-num-batch-message must be a valid u32");

        let msgs = parse_batch(FIXTURE, num_messages).expect("real Pulsar frame should parse");
        assert_eq!(msgs.len(), num_messages as usize);
    }

    #[test]
    fn rejects_a_payload_size_near_u64_max_without_panicking() {
        // A crafted `payload_size` this large previously made `pos + size`
        // overflow usize: panics on a checked-arithmetic debug build, wraps
        // and silently passes the bounds check on release, then panics again
        // inside the `payload[pos..pos + size]` slice ("start > end"). The
        // frame is otherwise honest — 2-byte payload actually present — so a
        // pre-fix build never gets the chance to return Truncated cleanly.
        let mut meta = vec![0x18]; // field 3, wire 0 (varint)
        meta.extend(varint_encode(u64::MAX));
        let mut buf = Vec::new();
        buf.extend_from_slice(&(meta.len() as u32).to_be_bytes());
        buf.extend_from_slice(&meta);
        buf.extend_from_slice(b"hi");

        assert!(matches!(parse_batch(&buf, 1), Err(BatchFrameError::Truncated { .. })));
    }

    #[test]
    fn rejects_a_max_u32_message_count_without_aborting() {
        // Guards the MAX_PREALLOC cap: without it, `Vec::with_capacity(u32::MAX
        // as usize)` of BatchedMessage (well over 32 bytes each) requests tens
        // of GB up front and aborts the process via handle_alloc_error before
        // a single byte of the frame is even read — not a panic this test
        // could catch, the whole test process would die instead of failing.
        // `frame()` yields 2 messages, so u32::MAX can only ever mismatch.
        let result = parse_batch(&frame(), u32::MAX);
        assert!(matches!(result, Err(BatchFrameError::CountMismatch { expected: u32::MAX, actual: 2 })));
    }

    #[test]
    fn rejects_metadata_whose_wire_type_2_length_is_near_usize_max_without_panicking() {
        // field 1, wire type 2 (length-delimited) — never field 3, so this
        // must be skipped by the parser, not read as payload_size. Its
        // declared length is huge and no such bytes follow it in `meta`.
        // Pre-fix, `pos += used + len as usize` could overflow (checked
        // arithmetic panics in debug) or wrap into a small `pos` that then
        // reads unrelated bytes as if they were a valid tag (release).
        let mut meta = vec![0x0A];
        meta.extend(varint_encode(u64::MAX));
        let mut buf = Vec::new();
        buf.extend_from_slice(&(meta.len() as u32).to_be_bytes());
        buf.extend_from_slice(&meta);
        buf.extend_from_slice(b"hi");

        assert!(matches!(parse_batch(&buf, 1), Err(BatchFrameError::MalformedMetadata { .. })));
    }
}
