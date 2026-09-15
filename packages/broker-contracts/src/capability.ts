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

/** Measured, never configured. Each flag traces to a validation ID in the spec. */
export interface CapabilitySnapshot {
  probedAt: number;
  brokerVersion: string | null;
  clusters: string[];
  endpoints: Record<string, EndpointProbe>;
  canPeek: boolean;                  // V-B1
  peekRequiresSubscription: boolean; // V-B3
  peekOnPartitionedAllowed: boolean; // V-B4 — false on 4.2.4
  batchFrameSeen: boolean;           // V-B5
  binaryProtocolReachable: boolean;  // V-C3
  webSocketEnabled: boolean;         // V-C1 — informational only, not a code path
  canProduce: boolean;               // V-E5 — only ever via binary
  canWrite: boolean;                 // V-E8 — what the server allows
  hasMetrics: boolean;
  warnings: string[];
  source: BrokerSource;
}
