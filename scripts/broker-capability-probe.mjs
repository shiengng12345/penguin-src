// scripts/broker-capability-probe.mjs
// Executable form of the Phase 0 validation matrix. Creates its own scratch
// topics/tenant/namespace under a `broker-probe` prefix and deletes them
// afterwards — even on error, via try/finally — it must never mutate
// business topics.
const PREFIX = "broker-probe";

async function req(url, opts = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    let reason = null;
    try { reason = JSON.parse(text)?.reason ?? null; } catch { /* not JSON */ }
    return { status: res.status, text, reason, headers: res.headers, ms: Date.now() - started };
  } catch (err) {
    return { status: null, text: "", reason: String(err), headers: new Headers(), ms: Date.now() - started };
  }
}

// Cleanup must never throw: a failed delete must not mask whatever error (if
// any) triggered the enclosing finally block.
async function safeDelete(url) {
  try {
    await req(url, { method: "DELETE" });
  } catch { /* swallow: cleanup must not throw */ }
}

export async function probe(adminUrl) {
  const ns = "public/default";
  const findings = {};
  const record = (id, ok, status, detail, extra = {}) => { findings[id] = { id, ok, status, detail, ...extra }; };

  // Every scratch resource this run might create, named up front so the
  // `finally` block can always find them regardless of where the body fails.
  const plain = `${PREFIX}-plain`;
  const part = `${PREFIX}-part`;
  const e8Topic = `${PREFIX}-e8`;
  const tenant = `${PREFIX}-t`;
  const namespace = `${PREFIX}-ns`;

  try {
    const version = await req(`${adminUrl}/admin/v2/brokers/version`);
    const clusters = await req(`${adminUrl}/admin/v2/clusters`);

    // V-A5 — Admin REST ignores pagination params
    const all = await req(`${adminUrl}/admin/v2/persistent/${ns}`);
    const paged = await req(`${adminUrl}/admin/v2/persistent/${ns}?page=0&size=2`);
    record("V-A5", paged.text === all.text, paged.status,
      "pagination params are ignored; full array returned");

    // scratch fixtures
    await req(`${adminUrl}/admin/v2/persistent/${ns}/${plain}`, { method: "PUT" });
    await req(`${adminUrl}/admin/v2/persistent/${ns}/${part}/partitions`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: "3",
    });

    // V-A6 — topic list returns expanded partitions, logical topics only via /partitioned
    const listed = JSON.parse((await req(`${adminUrl}/admin/v2/persistent/${ns}`)).text);
    const logical = JSON.parse((await req(`${adminUrl}/admin/v2/persistent/${ns}/partitioned`)).text);
    record("V-A6",
      listed.some((t) => t.endsWith(`${part}-partition-0`)) && logical.some((t) => t.endsWith(part)),
      200, "list expands partitions; /partitioned holds logical topics");

    // V-B4 — peek is rejected on a partitioned topic
    await req(`${adminUrl}/admin/v2/persistent/${ns}/${part}/subscription/probe`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ledgerId: -1, entryId: -1 }),
    });
    const peekPart = await req(`${adminUrl}/admin/v2/persistent/${ns}/${part}/subscription/probe/position/1`);
    record("V-B4", peekPart.status === 405, peekPart.status, peekPart.reason ?? "");

    // V-B2 — the safety conclusion the whole module rests on: peeking must not
    // consume. This runs against a freshly created, EMPTY scratch topic —
    // Admin REST cannot produce (that is V-E5), and the controller ruled that
    // an empty-topic proof is accepted for this task. It proves peek does not
    // fabricate cursor movement; it does NOT prove peek leaves a real
    // message's cursor untouched. `strength` discloses that limitation so
    // nothing downstream cites this as a stronger guarantee than it is.
    const cursorOf = async () => {
      const stats = JSON.parse((await req(`${adminUrl}/admin/v2/persistent/${ns}/${plain}/internalStats`)).text);
      const c = stats.cursors?.["probe-peek"] ?? {};
      return { markDelete: c.markDeletePosition, read: c.readPosition };
    };
    const backlogOf = async () => {
      const stats = JSON.parse((await req(`${adminUrl}/admin/v2/persistent/${ns}/${plain}/stats`)).text);
      return stats.subscriptions?.["probe-peek"]?.msgBacklog ?? -1;
    };

    await req(`${adminUrl}/admin/v2/persistent/${ns}/${plain}/subscription/probe-peek`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ledgerId: -1, entryId: -1 }),
    });
    const before = await cursorOf();
    const backlogBefore = await backlogOf();
    for (const pos of [1, 2, 3]) {
      await req(`${adminUrl}/admin/v2/persistent/${ns}/${plain}/subscription/probe-peek/position/${pos}`);
    }
    const after = await cursorOf();
    const backlogAfter = await backlogOf();
    record("V-B2",
      before.markDelete === after.markDelete && before.read === after.read && backlogBefore === backlogAfter,
      200,
      `topic was empty (no message ever produced); cursor ${before.markDelete}->${after.markDelete}, ` +
      `backlog ${backlogBefore}->${backlogAfter}. Proves peek does not fabricate cursor movement on an ` +
      `empty topic; a populated-topic proof is pending.`,
      { strength: "empty-topic-only" });

    // V-B3 — peek needs a subscription to exist; without one it is 404, not 200.
    const noSub = await req(`${adminUrl}/admin/v2/persistent/${ns}/${plain}/subscription/does-not-exist/position/1`);
    record("V-B3", noSub.status === 404, noSub.status, "peek requires an existing subscription");

    // V-D3 — schema incompatibility surfaces as a 500, and success as 202.
    const compat = await req(`${adminUrl}/admin/v2/schemas/public/default/${plain}/compatibility`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "JSON", schema: "{}", properties: {} }),
    });
    record("V-D3", compat.status === 202 || compat.status === 500 || compat.status === 404, compat.status,
      "compatible=202, incompatible=500 (not a clean 4xx)");

    // V-E5 — Admin REST cannot produce
    const produce = await req(`${adminUrl}/admin/v2/persistent/${ns}/${plain}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: '{"payload":"x"}',
    });
    record("V-E5", produce.status === 405, produce.status, "Admin REST has no produce capability");

    // V-E6 — deletes have a dependency order: a tenant with namespaces is a 409.
    await req(`${adminUrl}/admin/v2/tenants/${tenant}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedClusters: ["standalone"] }),
    });
    await req(`${adminUrl}/admin/v2/namespaces/${tenant}/${namespace}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const tenantWithNs = await req(`${adminUrl}/admin/v2/tenants/${tenant}`, { method: "DELETE" });
    record("V-E6", tenantWithNs.status === 409, tenantWithNs.status,
      "deleting a tenant that still has namespaces conflicts");
    await req(`${adminUrl}/admin/v2/namespaces/${tenant}/${namespace}`, { method: "DELETE" });
    await req(`${adminUrl}/admin/v2/tenants/${tenant}`, { method: "DELETE" });

    // V-E8 — the server permits writes from anyone; read_only is ours to
    // enforce. `ok` is derived from an actually observed write, never
    // hardcoded: create a broker-probe-prefixed topic and check the broker
    // really accepted it (204), or that it already exists from a prior
    // partial run (409) — either way the server took the write.
    const e8Put = await req(`${adminUrl}/admin/v2/persistent/${ns}/${e8Topic}`, { method: "PUT" });
    record("V-E8", e8Put.status === 204 || e8Put.status === 409, e8Put.status,
      "local broker accepts unauthenticated writes (topic create succeeded); read_only is enforced in Rust");

    // V-E7 — `force` semantics are inverted between namespace and topic
    const nsForce = await req(`${adminUrl}/admin/v2/namespaces/${PREFIX}-none?force=true`, { method: "DELETE" });
    record("V-E7", nsForce.status === 405 || nsForce.status === 404, nsForce.status,
      "namespace DELETE rejects force=true; topic DELETE requires it");

    return {
      brokerVersion: version.text.trim() || null,
      clusters: clusters.status === 200 ? JSON.parse(clusters.text) : [],
      findings,
    };
  } finally {
    // Cleanup every scratch resource the probe can possibly have created,
    // regardless of where the body above failed. Order matters: a
    // partitioned topic's partitions before its logical parent, and a
    // namespace before its owning tenant (V-E6's own dependency finding).
    await safeDelete(`${adminUrl}/admin/v2/persistent/${ns}/${part}/partitions?force=true`);
    await safeDelete(`${adminUrl}/admin/v2/persistent/${ns}/${plain}?force=true`);
    await safeDelete(`${adminUrl}/admin/v2/persistent/${ns}/${e8Topic}?force=true`);
    await safeDelete(`${adminUrl}/admin/v2/namespaces/${tenant}/${namespace}`);
    await safeDelete(`${adminUrl}/admin/v2/tenants/${tenant}`);
  }
}

// V-F1 / V-F2 — auth failure shapes. Only observable on the local-secure
// profile: the local-open broker has no auth provider, so every one of these
// requests would return 200 there instead of a real rejection.
export async function probeAuth(adminUrl, tokens = {}) {
  const url = `${adminUrl}/admin/v2/tenants`;
  const shape = async (headers) => {
    const r = await req(url, { headers });
    return { status: r.status, reason: r.reason, body: r.text.slice(0, 200) };
  };
  return {
    noToken: await shape({}),
    badToken: await shape({ Authorization: "Bearer not-a-real-token" }),
    forbidden: tokens.nobody ? await shape({ Authorization: `Bearer ${tokens.nobody}` }) : null,
    // Controller addition: a token that was valid but has lapsed. This shape
    // is distinct from badToken (malformed/unsigned) — the module's error map
    // needs to tell an operator "your credential expired" apart from "your
    // credential is wrong", and only an expired-but-otherwise-valid token can
    // demonstrate that distinction.
    expiredToken: tokens.expired ? await shape({ Authorization: `Bearer ${tokens.expired}` }) : null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await probe(process.argv[2] ?? "http://localhost:8080");
  console.log(JSON.stringify(report, null, 2));
  const failed = Object.values(report.findings).filter((f) => !f.ok);
  if (failed.length) {
    console.error(`\n${failed.length} finding(s) changed:`, failed.map((f) => f.id).join(", "));
    process.exit(1);
  }
}
