// packages/broker-contracts/src/connection.ts
import type { CapabilitySnapshot } from "./capability.js";

/** Only "pulsar" exists today. The union is here so adding a second kind
 *  does not require reshaping the table or the UI. */
export type BrokerKind = "pulsar";

export type ConnectionStatus =
  | "unknown" | "ok" | "unreachable" | "unauthorized" | "forbidden" | "tls_error";

export interface BrokerConnection {
  id: string;
  kind: BrokerKind;
  name: string;
  color: string;
  adminUrl: string;
  brokerUrl: string;
  authType: "none" | "jwt" | "oauth2" | "tls";
  /** Keychain-adapter reference (an opaque handle id), not the credential
   *  itself. The adapter's production implementation stores the plaintext
   *  in the app's own SQLite `app_kv` table, not an OS-level keychain —
   *  either way, the token itself never lives in this field or crosses
   *  back over IPC. */
  secretHandleId: string | null;
  defaultTenant: string;
  defaultNamespace: string;
  readOnly: boolean;
  tlsVerify: boolean;
  timeoutMs: number;
  lastStatus: ConnectionStatus;
  lastCheckedAt: number | null;
  brokerVersion: string | null;
  capabilities: CapabilitySnapshot | null;
  createdAt: number;
  updatedAt: number;
}

/** What the form collects. Excludes everything the backend owns. */
export type BrokerConnectionDraft = Omit<
  BrokerConnection,
  "id" | "lastStatus" | "lastCheckedAt" | "brokerVersion" | "capabilities" | "createdAt" | "updatedAt"
> & { secret?: string };
