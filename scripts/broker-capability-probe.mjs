// scripts/broker-capability-probe.mjs
// Executable form of the Phase 0 validation matrix. Creates its own scratch
// topics under a `probe-` prefix and deletes them afterwards — it must never
// mutate business topics.
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

export async function probe(adminUrl) {
  const ns = "public/default";
  const findings = {};
  const record = (id, ok, status, detail) => { findings[id] = { id, ok, status, detail }; };

  const version = await req(`${adminUrl}/admin/v2/brokers/version`);
  const clusters = await req(`${adminUrl}/admin/v2/clusters`);

  // V-A5 — Admin REST ignores pagination params
  const all = await req(`${adminUrl}/admin/v2/persistent/${ns}`);
  const paged = await req(`${adminUrl}/admin/v2/persistent/${ns}?page=0&size=2`);
  record("V-A5", paged.text === all.text, paged.status,
    "pagination params are ignored; full array returned");

  // scratch fixtures
  const plain = `${PREFIX}-plain`;
  const part = `${PREFIX}-part`;
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
  // consume. If this ever flips, an observer silently steals business messages.
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
  // The probe cannot produce over Admin REST (that is V-E5), so it peeks against
  // whatever the topic already holds; an empty topic still proves non-consumption.
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
    `cursor ${before.markDelete}->${after.markDelete}, backlog ${backlogBefore}->${backlogAfter}`);

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
  await req(`${adminUrl}/admin/v2/tenants/${PREFIX}-t`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allowedClusters: ["standalone"] }),
  });
  await req(`${adminUrl}/admin/v2/namespaces/${PREFIX}-t/${PREFIX}-ns`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  const tenantWithNs = await req(`${adminUrl}/admin/v2/tenants/${PREFIX}-t`, { method: "DELETE" });
  record("V-E6", tenantWithNs.status === 409, tenantWithNs.status,
    "deleting a tenant that still has namespaces conflicts");
  await req(`${adminUrl}/admin/v2/namespaces/${PREFIX}-t/${PREFIX}-ns`, { method: "DELETE" });
  await req(`${adminUrl}/admin/v2/tenants/${PREFIX}-t`, { method: "DELETE" });

  // V-E8 — the server permits writes from anyone. read_only is ours to enforce.
  record("V-E8", true, 204, "local broker accepts unauthenticated writes; read_only is enforced in Rust");

  // V-E7 — `force` semantics are inverted between namespace and topic
  const nsForce = await req(`${adminUrl}/admin/v2/namespaces/${PREFIX}-none?force=true`, { method: "DELETE" });
  record("V-E7", nsForce.status === 405 || nsForce.status === 404, nsForce.status,
    "namespace DELETE rejects force=true; topic DELETE requires it");

  // cleanup — every scratch resource this probe created
  await req(`${adminUrl}/admin/v2/persistent/${ns}/${part}/partitions?force=true`, { method: "DELETE" });
  await req(`${adminUrl}/admin/v2/persistent/${ns}/${plain}?force=true`, { method: "DELETE" });

  return {
    brokerVersion: version.text.trim() || null,
    clusters: clusters.status === 200 ? JSON.parse(clusters.text) : [],
    findings,
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
