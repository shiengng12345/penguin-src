// packages/broker-contracts/src/topology.ts

/** A tenant as the broker reports it. Pulsar returns bare strings; we wrap
 *  them so later phases can attach policy or permission data without
 *  reshaping every caller. */
export interface TenantSummary {
  name: string;
}

/** A namespace. Pulsar's list endpoint returns "tenant/namespace" strings;
 *  we split them once here rather than at every call site, and keep `full`
 *  because that is the form the topic endpoints take. */
export interface NamespaceSummary {
  tenant: string;
  name: string;
  full: string;
}
