// packages/broker-contracts/src/capability.ts
import type { BrokerSource } from "./envelope.js";

export interface EndpointProbe {
  path: string;
  method: string;
  status: number | null;
  ok: boolean;
  latencyMs: number | null;
  reason: string | null;
}

/** Most flags here are measured per-connection, never configured, and each
 *  traces to a validation ID in the spec. Five are the exception —
 *  `canPeek`, `peekRequiresSubscription`, `peekOnPartitionedAllowed`,
 *  `webSocketEnabled`, and `batchFrameSeen` — the Rust side
 *  (`src-tauri/src/broker/capability.rs`) currently sends these as
 *  constants derived from a one-time measurement against local Pulsar
 *  4.2.4, not a live probe of each connection; they're marked below. That's
 *  fine today (nothing renders them yet), but Phase B must start probing
 *  them per-connection before any caller may treat them as measured facts. */
export interface CapabilitySnapshot {
  probedAt: number;
  brokerVersion: string | null;
  clusters: string[];
  endpoints: Record<string, EndpointProbe>;
  canPeek: boolean;                  // V-B1 — constant today (measured once against 4.2.4), not yet probed per connection
  peekRequiresSubscription: boolean; // V-B3 — constant today (measured once against 4.2.4), not yet probed per connection
  peekOnPartitionedAllowed: boolean; // V-B4 — false on 4.2.4; constant today, not yet probed per connection
  batchFrameSeen: boolean;           // V-B5 — constant today (not yet observed by Phase B), not yet probed per connection
  binaryProtocolReachable: boolean;  // V-C3 — probed per connection
  webSocketEnabled: boolean;         // V-C1 — informational only, not a code path; constant today, not yet probed per connection
  canProduce: boolean;               // V-E5 — only ever via binary; probed per connection
  canWrite: boolean;                 // V-E8 — what the server allows; inferred, never probed by an actual write (Stage 0 Task 2)
  /** True only when a read-only admin call came back 401/403 — a refusal IS
   *  a measurement: a credential that cannot even read certainly cannot
   *  write. False in every other case, including a successful read: a
   *  successful read is NOT evidence of write access. This stage never
   *  attempts an actual write to find out either way (see
   *  `src-tauri/src/broker/capability.rs`'s `probe_write` removal — B-07,
   *  §11.9, §14.3 all forbid it). A UI reading `canWriteProbed: false` must
   *  render "not measured", never "cannot write". */
  canWriteProbed: boolean;
  hasMetrics: boolean;
  warnings: string[];
  source: BrokerSource;
}
