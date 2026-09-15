// packages/broker-contracts/src/envelope.ts

/** Every broker result carries provenance. A bare value is never returned. */
export interface ResultEnvelope<T> {
  data?: T;
  source: BrokerSource;
  observedAt: string;
  freshnessMs: number;
  warnings: string[];
  error?: BrokerError;
}

/** Which transport produced this. Admin REST cannot produce; binary cannot list topics. */
export type BrokerSource = "pulsar-admin-rest" | "pulsar-binary" | "cache";

export interface BrokerError {
  code: BrokerErrorCode;
  message: string;
  retryable: boolean;
}

export type BrokerErrorCode =
  | "AUTHENTICATION_FAILED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "NOT_SUPPORTED_HERE"   // 405 — e.g. peek on a partitioned topic
  | "CONFLICT"             // 409 — e.g. delete tenant with namespaces present
  | "RATE_LIMITED"
  | "SCHEMA_INCOMPATIBLE"  // 500 carrying SchemaValidationException — a result, not a fault
  | "SOURCE_UNAVAILABLE"
  | "TIMEOUT"
  | "TLS_ERROR"
  | "MALFORMED_RESPONSE"
  | "READ_ONLY_BLOCKED";   // our own gate, never the server's
