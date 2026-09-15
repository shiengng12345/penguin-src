// Proves the one line that keeps a broker token out of the persisted
// connection record: `broker-client.ts`'s `upsertConnection` sends `secret`
// only as its own dedicated invoke argument, never inside the `draft`
// object that gets serialized into the connection row. Checks the
// serialised payload rather than just the top-level `secret` key, so a
// nested copy (e.g. accidentally spread back into the draft) would be
// caught too, not just a literal `draft.secret` property.
import { describe, expect, it, vi } from "vitest";
import type { BrokerConnectionDraft } from "@penguin/broker-contracts";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const { upsertConnection } = await import("../broker-client");

const draft: BrokerConnectionDraft = {
  kind: "pulsar",
  name: "Secure",
  color: "blue",
  adminUrl: "http://localhost:8081",
  brokerUrl: "pulsar://localhost:6651",
  authType: "jwt",
  secretHandleId: null,
  defaultTenant: "public",
  defaultNamespace: "default",
  readOnly: true,
  tlsVerify: true,
  timeoutMs: 10_000,
  secret: "super-secret",
};

describe("upsertConnection", () => {
  it("sends the token only in the dedicated secret argument, never inside the draft", async () => {
    invokeMock.mockResolvedValueOnce({ id: "conn-1" });

    await upsertConnection("conn-1", draft);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMock.mock.calls[0] as [string, { draft: unknown; secret: unknown }];

    expect(command).toBe("broker_upsert_connection");
    // Present in the dedicated field...
    expect(args.secret).toBe("super-secret");
    // ...and genuinely absent from the draft — as a top-level key...
    expect(args.draft).not.toHaveProperty("secret");
    // ...and absent from the draft's serialised form, so a nested copy
    // anywhere inside it would be caught too, not just a missing top-level key.
    expect(JSON.stringify(args.draft)).not.toContain("super-secret");
  });

  it("keeps the existing keychain handle (does not invent or clear one) when no secret is typed", async () => {
    invokeMock.mockResolvedValueOnce({ id: "conn-1" });
    const { secret: _secret, ...draftWithoutSecret } = draft;

    await upsertConnection("conn-1", draftWithoutSecret);

    const [, args] = invokeMock.mock.calls[0] as [string, { draft: unknown; secret: unknown }];
    expect(args.secret).toBeNull();
    expect(JSON.stringify(args.draft)).not.toContain("super-secret");
  });
});
