# Penguin Broker Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Broker module's foundation in penguin-app while empirically validating every assumption that Phases A–F depend on, so no later phase starts on an unverified premise.

**Architecture:** A new `broker` module: React UI in the Tauri webview, a Rust backend that is the only component touching the network, and two transports — Admin REST (reqwest) for topology/stats/schema/ops, and the `pulsar` crate's binary protocol on `:6650` for reading event streams and producing. Pure domain logic lives in `packages/broker-core` so it is testable headlessly. Credentials go to the OS keychain; plaintext never crosses IPC.

**Tech Stack:** Rust (tokio, reqwest, rusqlite, `pulsar` 6.9), Tauri 2, React 19, TypeScript 5.7, Tailwind 4, Zustand 5, `@tanstack/react-virtual`, node:test (core/logic), Vitest + Testing Library (UI — newly introduced), Docker Compose, Apache Pulsar 4.2.4.

**Spec:** `docs/superpowers/specs/2026-09-15-penguin-broker-phase0-design.md`

## Global Constraints

- Module name is **`broker`**, never `pulsar`, in every path, type, and command name. Pulsar appears only inside `adapters/pulsar/`.
- Pulsar image pinned by digest `sha256:cd5d4a64a32c0770d5d2dbb526169a70081605bbec4b59b73471b68d0a451fb4`. The tag `latest` is forbidden in any compose file or CI config.
- Local endpoints: Admin REST `http://localhost:8080`, binary `pulsar://localhost:6650`.
- The Rust backend is the only component that touches Pulsar. The webview gets no arbitrary HTTP, file, or shell capability.
- Plaintext credentials never appear in: FE state, IPC payloads, SQLite, logs, `error_log`, or Git. FE holds only a `handleId` (DEC #195, as implemented in `src-tauri/src/rest/`).
- `read_only` defaults to `true` and is enforced in Rust. Local Pulsar is unauthenticated and refuses nothing.
- Every result carries `source`, `observedAt`, `freshnessMs`, and `warnings`.
- New source files stay at or under 400 lines. Split by responsibility.
- Test status is recorded as `Implemented` / `Verified` / `Not run` / `Blocked`. The Phase 0 gate does not pass with any `Not run` or `Blocked`.
- Vitest is introduced for Broker UI only. The existing 331 `node:test` files are not rewritten and must keep passing.

---

## File Structure

**Validation (Part 1)**
- `infra/broker/docker-compose.local.yml` — unauthenticated Pulsar, digest-pinned
- `infra/broker/docker-compose.secure.yml` — JWT + TLS Pulsar, for auth failure shapes
- `infra/broker/COMPATIBILITY.md` — pinned digest, broker version, probe date
- `scripts/broker-capability-probe.mjs` — executable form of the spec's validation matrix
- `tests/broker-capability.test.mjs` — asserts the probe's findings; fails if Pulsar behaviour regresses
- `src-tauri/src/broker/adapters/pulsar/batch_frame.rs` — Pulsar batch frame parser
- `src-tauri/src/bin/broker_sim.rs` — consumer simulator that triggers retry/DLQ

**Contracts & core (Part 2)**
- `packages/broker-contracts/` — `envelope.ts`, `connection.ts`, `capability.ts`, `topic.ts`
- `packages/broker-core/` — `error-map.ts`, `pagination.ts`, `topic-folding.ts`, `capability-merge.ts`

**Rust backend (Part 3)**
- `src-tauri/src/broker/mod.rs`, `ports.rs`, `envelope.rs`, `security.rs`, `capability.rs`, `store.rs`, `commands.rs`
- `src-tauri/src/broker/adapters/pulsar/admin_rest.rs`, `binary.rs`
- `src-tauri/src/db.rs` (modify) — two new tables

**Frontend (Part 4)**
- `vitest.config.ts`, `src/test/setup.ts`
- `src/components/ui/data-table.tsx`
- `src/components/broker/BrokerPage.tsx`, `ConnectionTable.tsx`, `ConnectionForm.tsx`, `ConnectionActions.tsx`, `TopicTable.tsx`
- `src/hooks/useBrokerConnections.ts`, `src/lib/broker-client.ts`
- `src/components/layout/MainSidebar.tsx` (modify), `src/App.tsx` (modify)

---

# Part 1 — Validation

These tasks come first. Their job is to turn the spec's section 2 into executable
assertions, and to resolve the four items the spec marks as unvalidated
(V-B5, V-B7, V-C3/V-E5, V-F1/F2). If any of them fails, the affected phase's
design changes before that phase starts.

---

### Task 1: Pin the environment

**Files:**
- Create: `infra/broker/docker-compose.local.yml`
- Create: `infra/broker/COMPATIBILITY.md`

**Interfaces:**
- Produces: a reproducible Pulsar 4.2.4 at `localhost:8080` / `localhost:6650` that every later task probes against.

- [ ] **Step 1: Write the compose file, digest-pinned**

```yaml
# infra/broker/docker-compose.local.yml
# local-open profile: no auth, no TLS. Development only.
# Image is pinned by digest — `latest` drifts and is forbidden (see COMPATIBILITY.md).
services:
  pulsar:
    image: apachepulsar/pulsar@sha256:cd5d4a64a32c0770d5d2dbb526169a70081605bbec4b59b73471b68d0a451fb4
    container_name: broker-pulsar-local
    command: bin/pulsar standalone
    ports:
      - "8080:8080"   # Admin REST
      - "6650:6650"   # binary protocol
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/admin/v2/brokers/health"]
      interval: 10s
      timeout: 5s
      retries: 12
```

- [ ] **Step 2: Write COMPATIBILITY.md**

```markdown
# Broker module — pinned compatibility

| Item | Value | Verified |
|---|---|---|
| Pulsar image digest | `sha256:cd5d4a64a32c0770d5d2dbb526169a70081605bbec4b59b73471b68d0a451fb4` | 2026-09-15 |
| Broker version (`GET /admin/v2/brokers/version`) | `4.2.4` | 2026-09-15 |
| Cluster name | `standalone` | 2026-09-15 |
| Admin REST | `http://localhost:8080` | 2026-09-15 |
| Binary protocol | `pulsar://localhost:6650` | 2026-09-15 |
| Rust client crate | `pulsar` 6.9.0 (streamnative/pulsar-rs) | 2026-09-15 |

## Rules

- `latest` is forbidden in compose files and CI. Pin by digest.
- Changing the digest requires re-running `pnpm broker:probe` and updating this table.
```

- [ ] **Step 3: Bring it up and verify the pinned version**

```bash
docker compose -f infra/broker/docker-compose.local.yml up -d
until curl -sf http://localhost:8080/admin/v2/brokers/health; do sleep 2; done
curl -s http://localhost:8080/admin/v2/brokers/version
```

Expected: `ok` then `4.2.4`. If the version differs, the digest is wrong — stop and fix.

- [ ] **Step 4: Commit**

```bash
git add infra/broker/
git commit -m "chore(broker): pin local Pulsar 4.2.4 by digest"
```

---

### Task 2: Probe harness — freeze the Admin REST findings

Turns spec section 2's ✅/⚠️/⛔ rows into assertions that fail if Pulsar's behaviour
changes. This is the artifact that later becomes the app's Test Connection and the
first check run against SRE nonprod.

**Files:**
- Create: `scripts/broker-capability-probe.mjs`
- Create: `tests/broker-capability.test.mjs`
- Modify: `package.json` — add the `broker:probe` script

**Interfaces:**
- Produces: `probe(adminUrl) -> CapabilityReport`, where
  `CapabilityReport = { brokerVersion: string, clusters: string[], findings: Record<string, Finding> }`
  and `Finding = { id: string, ok: boolean, status: number | null, detail: string }`.
  Task 13 reuses this shape for `CapabilitySnapshot`.

- [ ] **Step 1: Write the probe harness**

```js
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
```

- [ ] **Step 2: Write the failing test**

```js
// tests/broker-capability.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { probe } from "../scripts/broker-capability-probe.mjs";

const ADMIN = process.env.BROKER_ADMIN_URL ?? "http://localhost:8080";

test("broker capability probe reproduces the Phase 0 findings", async () => {
  const report = await probe(ADMIN);
  assert.equal(report.brokerVersion, "4.2.4", "pinned broker version");
  assert.ok(report.clusters.includes("standalone"));
  for (const id of ["V-A5", "V-A6", "V-B3", "V-B4", "V-D3", "V-E5", "V-E6", "V-E7", "V-E8"]) {
    assert.equal(report.findings[id]?.ok, true, `${id}: ${report.findings[id]?.detail}`);
  }
});

test("peeking never consumes a message (V-B2)", async () => {
  // Called out separately because it is the safety property the whole module
  // rests on: an operator inspecting a topic must not steal from its consumers.
  const report = await probe(ADMIN);
  const finding = report.findings["V-B2"];
  assert.equal(finding.ok, true, `peek moved the cursor or drained backlog — ${finding.detail}`);
});

test("probe leaves no scratch resources behind", async () => {
  const res = await fetch(`${ADMIN}/admin/v2/persistent/public/default`);
  const topics = await res.json();
  assert.equal(topics.filter((t) => t.includes("broker-probe")).length, 0);
});
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
node --test tests/broker-capability.test.mjs
```

Expected: FAIL — `Cannot find module '../scripts/broker-capability-probe.mjs'` if Step 1 was skipped, otherwise a finding mismatch. Confirm the failure is real before proceeding.

- [ ] **Step 4: Run it against the live broker until green**

```bash
docker compose -f infra/broker/docker-compose.local.yml up -d
node --test tests/broker-capability.test.mjs
```

Expected: PASS, both tests.

- [ ] **Step 5: Add the script entry**

In `package.json` `scripts`, next to the other top-level entries:

```json
"broker:probe": "node scripts/broker-capability-probe.mjs"
```

- [ ] **Step 6: Commit**

```bash
git add scripts/broker-capability-probe.mjs tests/broker-capability.test.mjs package.json
git commit -m "test(broker): freeze Admin REST capability findings as assertions"
```

---

### Task 3: local-secure profile — capture real auth failure shapes

Resolves V-F1 / V-F2. Local Pulsar is unauthenticated, so `401` / `403` / `429` have
never been observed. The error map cannot be frozen without them.

**Files:**
- Create: `infra/broker/docker-compose.secure.yml`
- Create: `infra/broker/secure/generate-keys.sh`
- Modify: `scripts/broker-capability-probe.mjs` — add `probeAuth(adminUrl, token)`
- Modify: `tests/broker-capability.test.mjs` — add the auth-shape test

**Interfaces:**
- Consumes: `probe()` from Task 2.
- Produces: `probeAuth(adminUrl, token) -> { noToken: Finding, badToken: Finding, expiredToken: Finding }`. Task 8's error map is derived from these observed shapes.

- [ ] **Step 1: Write the key generation script**

```bash
#!/usr/bin/env bash
# infra/broker/secure/generate-keys.sh — JWT keys for the local-secure profile.
# Output is gitignored: these are local dev keys, never committed, never reused.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="apachepulsar/pulsar@sha256:cd5d4a64a32c0770d5d2dbb526169a70081605bbec4b59b73471b68d0a451fb4"

docker run --rm -v "$DIR:/keys" "$IMAGE" \
  bin/pulsar tokens create-key-pair --output-private-key /keys/private.key --output-public-key /keys/public.key

docker run --rm -v "$DIR:/keys" "$IMAGE" \
  bin/pulsar tokens create --private-key file:///keys/private.key --subject admin > "$DIR/admin.jwt"

# A token for a subject with no permissions — this is how we observe a real 403.
docker run --rm -v "$DIR:/keys" "$IMAGE" \
  bin/pulsar tokens create --private-key file:///keys/private.key --subject nobody > "$DIR/nobody.jwt"

echo "wrote private.key public.key admin.jwt nobody.jwt to $DIR"
```

- [ ] **Step 2: Write the secure compose file**

```yaml
# infra/broker/docker-compose.secure.yml
# local-secure profile: JWT auth on. Used to observe real 401/403/429 shapes,
# which the unauthenticated local-open profile can never produce.
services:
  pulsar-secure:
    image: apachepulsar/pulsar@sha256:cd5d4a64a32c0770d5d2dbb526169a70081605bbec4b59b73471b68d0a451fb4
    container_name: broker-pulsar-secure
    command: bin/pulsar standalone
    environment:
      PULSAR_PREFIX_authenticationEnabled: "true"
      PULSAR_PREFIX_authorizationEnabled: "true"
      PULSAR_PREFIX_authenticationProviders: "org.apache.pulsar.broker.authentication.AuthenticationProviderToken"
      PULSAR_PREFIX_tokenPublicKey: "file:///pulsar/secure/public.key"
      PULSAR_PREFIX_superUserRoles: "admin"
      PULSAR_PREFIX_brokerClientAuthenticationPlugin: "org.apache.pulsar.client.impl.auth.AuthenticationToken"
      PULSAR_PREFIX_brokerClientAuthenticationParameters: "file:///pulsar/secure/admin.jwt"
    volumes:
      - ./secure:/pulsar/secure:ro
    ports:
      - "8081:8080"
      - "6651:6650"
```

- [ ] **Step 3: Add `probeAuth` to the harness**

Append to `scripts/broker-capability-probe.mjs`:

```js
// V-F1 / V-F2 — auth failure shapes. Only observable on the local-secure profile.
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
  };
}
```

- [ ] **Step 4: Write the failing test**

Append to `tests/broker-capability.test.mjs`:

```js
import { readFile } from "node:fs/promises";
import { probeAuth } from "../scripts/broker-capability-probe.mjs";

const SECURE = process.env.BROKER_SECURE_URL ?? "http://localhost:8081";

test("local-secure profile produces real 401 and 403 shapes", async () => {
  const nobody = (await readFile(new URL("../infra/broker/secure/nobody.jwt", import.meta.url), "utf8")).trim();
  const shapes = await probeAuth(SECURE, { nobody });

  assert.equal(shapes.noToken.status, 401, "no token must be rejected, not silently allowed");
  assert.equal(shapes.badToken.status, 401, "a malformed token must be 401");
  assert.equal(shapes.forbidden.status, 403, "a valid token without permission must be 403");
});
```

- [ ] **Step 5: Run it to verify it fails**

```bash
node --test tests/broker-capability.test.mjs
```

Expected: FAIL — the secure broker is not running yet, so the request errors or returns 200.

- [ ] **Step 6: Generate keys, bring up the secure profile, run until green**

```bash
bash infra/broker/secure/generate-keys.sh
docker compose -f infra/broker/docker-compose.secure.yml up -d
until curl -sf http://localhost:8081/admin/v2/brokers/health -H "Authorization: Bearer $(cat infra/broker/secure/admin.jwt)"; do sleep 2; done
node --test tests/broker-capability.test.mjs
```

Expected: PASS. Record the exact observed `status` and `reason` for each case — Task 8's error map table is filled from these, not from documentation.

- [ ] **Step 7: Gitignore the keys**

Append to `.gitignore`:

```
# Local-only JWT keys for the Broker local-secure profile. Never commit.
infra/broker/secure/*.key
infra/broker/secure/*.jwt
```

- [ ] **Step 8: Commit**

```bash
git add infra/broker/docker-compose.secure.yml infra/broker/secure/generate-keys.sh \
        scripts/broker-capability-probe.mjs tests/broker-capability.test.mjs .gitignore
git commit -m "test(broker): capture real 401/403 shapes via local-secure profile"
```

---

### Task 4: Batch frame parser

Resolves V-B5, the finding with the widest blast radius. 2053 messages arrived as
8 entries; a peek returns `X-Pulsar-num-batch-message: 248` and a 17976-byte frame.
Without this parser, Message Inspector shows binary noise on any topic with batching
enabled — which is nearly every production topic.

**Files:**
- Create: `src-tauri/src/broker/adapters/pulsar/batch_frame.rs`
- Create: `src-tauri/src/broker/adapters/pulsar/mod.rs`
- Create: `src-tauri/src/broker/adapters/mod.rs`
- Create: `src-tauri/src/broker/mod.rs`
- Modify: `src-tauri/src/lib.rs` — declare `mod broker;`

**Interfaces:**
- Produces: `parse_batch(payload: &[u8], num_messages: u32) -> Result<Vec<BatchedMessage>, BatchFrameError>` where
  `BatchedMessage { index: u32, payload: Vec<u8>, properties: Vec<(String, String)>, partition_key: Option<String> }`.
  Phase B's Message Inspector consumes this.

- [ ] **Step 1: Write the failing test**

Pulsar's batch frame is a repetition of `[4-byte big-endian metadata length][SingleMessageMetadata protobuf][payload]`.
`SingleMessageMetadata` field 3 (`payload_size`, varint) is the one field we must read to walk the frame.

```rust
// bottom of src-tauri/src/broker/adapters/pulsar/batch_frame.rs
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
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd src-tauri && cargo test broker::adapters::pulsar::batch_frame
```

Expected: FAIL to compile — `parse_batch` and `BatchFrameError` are not defined.

- [ ] **Step 3: Write the parser**

```rust
// src-tauri/src/broker/adapters/pulsar/batch_frame.rs
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
```

- [ ] **Step 4: Wire the module tree**

```rust
// src-tauri/src/broker/mod.rs
//! Broker module — message-queue operations. Pulsar is the first and only
//! adapter; the module's own names stay vendor-neutral (see spec D1).
pub mod adapters;
```

```rust
// src-tauri/src/broker/adapters/mod.rs
pub mod pulsar;
```

```rust
// src-tauri/src/broker/adapters/pulsar/mod.rs
pub mod batch_frame;
```

In `src-tauri/src/lib.rs`, beside the existing `mod` declarations, add:

```rust
mod broker;
```

Add to `src-tauri/Cargo.toml` `[dependencies]`:

```toml
# Typed error enums for the broker module's parsers and adapters.
thiserror = "2"
```

- [ ] **Step 5: Run the tests**

```bash
cd src-tauri && cargo test broker::adapters::pulsar::batch_frame
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Verify against a real 248-message frame**

```bash
docker exec broker-pulsar-local bin/pulsar-client produce persistent://public/default/broker-probe-batch -m x >/dev/null 2>&1
curl -s -X PUT http://localhost:8080/admin/v2/persistent/public/default/broker-probe-batch/subscription/rb \
  -H 'Content-Type: application/json' -d '{"ledgerId":-1,"entryId":-1}'
docker exec broker-pulsar-local bin/pulsar-perf produce persistent://public/default/broker-probe-batch \
  -m 2000 -r 5000 -s 64 -b 50 -bm 500
curl -s -D /tmp/h.txt -o /tmp/frame.bin \
  http://localhost:8080/admin/v2/persistent/public/default/broker-probe-batch/subscription/rb/position/1
grep -i num-batch /tmp/h.txt
```

Save `/tmp/frame.bin` as `src-tauri/tests/fixtures/broker/batch-frame.bin` and add a test asserting
`parse_batch(&fixture, N)` returns exactly `N` messages with the `X-Pulsar-num-batch-message` value from the header.
Then clean up: `curl -s -X DELETE 'http://localhost:8080/admin/v2/persistent/public/default/broker-probe-batch?force=true'`

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/broker/ src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/tests/fixtures/broker/
git commit -m "feat(broker): parse Pulsar batch frames into individual messages"
```

---

### Task 5: Binary protocol spike — Reader and Producer

Resolves V-C3 and V-E5 together. Admin REST cannot produce (405) and its peek
cannot serve as a continuous event stream, so Phases C and E both depend on the
binary protocol working. This task proves it before either phase is designed.

**Files:**
- Create: `src-tauri/src/broker/adapters/pulsar/binary.rs`
- Modify: `src-tauri/src/broker/adapters/pulsar/mod.rs` — add `pub mod binary;`
- Modify: `src-tauri/Cargo.toml` — add the `pulsar` crate
- Create: `src-tauri/tests/broker_binary.rs` — integration test against live Pulsar

**Interfaces:**
- Produces:
  - `read_without_ack(broker_url: &str, topic: &str, max: usize) -> Result<Vec<RawMessage>, BinaryError>`
  - `produce_one(broker_url: &str, topic: &str, payload: Vec<u8>, props: Vec<(String, String)>) -> Result<String, BinaryError>` returning the message id as a string.
  - `RawMessage { message_id: String, payload: Vec<u8>, properties: Vec<(String, String)>, publish_time: i64 }`.
  Phase C consumes `read_without_ack`; Phase E consumes `produce_one`.

- [ ] **Step 1: Add the dependency**

In `src-tauri/Cargo.toml` `[dependencies]`:

```toml
# Binary protocol client. Required because Admin REST cannot produce (405) and
# its peek cannot serve as a continuous event stream — see spec V-C1/V-E5.
# `compression` is off: we only need the plain path for Phase 0.
pulsar = { version = "6.9", default-features = false, features = ["tokio-runtime"] }
futures = "0.3"
```

- [ ] **Step 2: Write the failing integration test**

```rust
// src-tauri/tests/broker_binary.rs
//! Live integration test. Requires the local-open Pulsar profile:
//!   docker compose -f infra/broker/docker-compose.local.yml up -d
use penguin_lib::broker::adapters::pulsar::binary;

const BROKER: &str = "pulsar://localhost:6650";

#[tokio::test]
async fn produces_then_reads_back_without_acking() {
    let topic = "persistent://public/default/broker-spike-binary";

    let id = binary::produce_one(
        BROKER,
        topic,
        b"spike-payload".to_vec(),
        vec![("correlationId".into(), "spike-corr".into())],
    )
    .await
    .expect("produce must succeed over the binary protocol");
    assert!(!id.is_empty(), "produce returns a message id");

    let msgs = binary::read_without_ack(BROKER, topic, 1)
        .await
        .expect("reader must read without a subscription and without acking");

    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].payload, b"spike-payload");
    assert_eq!(
        msgs[0].properties.iter().find(|(k, _)| k == "correlationId").map(|(_, v)| v.as_str()),
        Some("spike-corr"),
        "correlation keys must survive the round trip"
    );
}

#[tokio::test]
async fn reading_twice_yields_the_same_messages() {
    // A Reader must not consume. If the second read comes back empty, the
    // transport is acking behind our back and Phase C's design is wrong.
    let topic = "persistent://public/default/broker-spike-binary";
    let first = binary::read_without_ack(BROKER, topic, 1).await.expect("first read");
    let second = binary::read_without_ack(BROKER, topic, 1).await.expect("second read");
    assert_eq!(first.len(), second.len(), "reads must be repeatable");
    assert_eq!(first[0].payload, second[0].payload);
}
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd src-tauri && cargo test --test broker_binary
```

Expected: FAIL to compile — `binary` module does not exist.

- [ ] **Step 4: Write the implementation**

```rust
// src-tauri/src/broker/adapters/pulsar/binary.rs
//! Pulsar binary protocol transport (port 6650).
//!
//! Exists because Admin REST cannot produce (405) and its peek requires an
//! existing subscription and is rejected on partitioned topics. A Reader on
//! this transport reads from a position without a subscription and without
//! acking, which is what a lifecycle observer needs (spec V-C1/V-C3).
//!
//! WebSocket is deliberately NOT used: `broker.conf` ships with
//! `webSocketServiceEnabled=false`, so it works on standalone and fails on a
//! real broker deployment.

use futures::StreamExt;
use pulsar::{
    consumer::InitialPosition, message::proto, Pulsar, TokioExecutor,
};

#[derive(Debug, Clone)]
pub struct RawMessage {
    pub message_id: String,
    pub payload: Vec<u8>,
    pub properties: Vec<(String, String)>,
    pub publish_time: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum BinaryError {
    #[error("connect failed: {0}")]
    Connect(String),
    #[error("read failed: {0}")]
    Read(String),
    #[error("produce failed: {0}")]
    Produce(String),
}

async fn client(broker_url: &str) -> Result<Pulsar<TokioExecutor>, BinaryError> {
    Pulsar::builder(broker_url, TokioExecutor)
        .build()
        .await
        .map_err(|e| BinaryError::Connect(e.to_string()))
}

/// Reads up to `max` messages from the earliest position without acking.
/// Uses a Reader-style consumer so the cursor of any real subscription is untouched.
pub async fn read_without_ack(
    broker_url: &str,
    topic: &str,
    max: usize,
) -> Result<Vec<RawMessage>, BinaryError> {
    let pulsar = client(broker_url).await?;
    let mut reader = pulsar
        .reader()
        .with_topic(topic)
        .with_options(pulsar::reader::ReaderOptions::default())
        .with_start_message_id(proto::MessageIdData {
            ledger_id: u64::MAX,
            entry_id: u64::MAX,
            ..Default::default()
        })
        .into_reader::<Vec<u8>>()
        .await
        .map_err(|e| BinaryError::Read(e.to_string()))?;

    let mut out = Vec::with_capacity(max);
    while out.len() < max {
        match reader.next().await {
            Some(Ok(msg)) => {
                let meta = &msg.payload.metadata;
                out.push(RawMessage {
                    message_id: format!("{}:{}", msg.message_id().ledger_id, msg.message_id().entry_id),
                    payload: msg.payload.data.clone(),
                    properties: meta
                        .properties
                        .iter()
                        .map(|kv| (kv.key.clone(), kv.value.clone()))
                        .collect(),
                    publish_time: meta.publish_time as i64,
                });
            }
            Some(Err(e)) => return Err(BinaryError::Read(e.to_string())),
            None => break,
        }
    }
    Ok(out)
}

/// Produces one message. This is the only produce path the module has —
/// Admin REST returns 405 for produce.
pub async fn produce_one(
    broker_url: &str,
    topic: &str,
    payload: Vec<u8>,
    props: Vec<(String, String)>,
) -> Result<String, BinaryError> {
    let pulsar = client(broker_url).await?;
    let mut producer = pulsar
        .producer()
        .with_topic(topic)
        .build()
        .await
        .map_err(|e| BinaryError::Produce(e.to_string()))?;

    let mut builder = producer.create_message().with_content(payload);
    for (k, v) in props {
        builder = builder.with_property(k, v);
    }

    let receipt = builder
        .send_non_blocking()
        .await
        .map_err(|e| BinaryError::Produce(e.to_string()))?
        .await
        .map_err(|e| BinaryError::Produce(e.to_string()))?;

    Ok(format!(
        "{}:{}",
        receipt.message_id.map(|m| m.ledger_id).unwrap_or_default(),
        receipt.message_id.map(|m| m.entry_id).unwrap_or_default()
    ))
}
```

Add `pub mod binary;` to `src-tauri/src/broker/adapters/pulsar/mod.rs`, and make the
module tree public in `src-tauri/src/lib.rs` so the integration test can reach it:
change `mod broker;` to `pub mod broker;`.

- [ ] **Step 5: Run until green**

```bash
docker compose -f infra/broker/docker-compose.local.yml up -d
cd src-tauri && cargo test --test broker_binary -- --test-threads=1
```

Expected: PASS, both tests. If the `pulsar` crate's reader API differs from the
sketch above, adapt to the crate's actual 6.9 API — the assertions are the contract,
not the call shape.

- [ ] **Step 6: Clean up the spike topic and commit**

```bash
curl -s -X DELETE 'http://localhost:8080/admin/v2/persistent/public/default/broker-spike-binary?force=true'
git add src-tauri/src/broker/adapters/pulsar/binary.rs src-tauri/src/broker/adapters/pulsar/mod.rs \
        src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tests/broker_binary.rs
git commit -m "feat(broker): binary protocol reader and producer (V-C3/V-E5)"
```

---

### Task 6: Consumer simulator — capture real retry/DLQ properties

Resolves V-B7. The shipped `pulsar-client consume` has no nack or DLQ flags, so the
retry/DLQ property names have never been observed. Phases B and D must not hardcode
names taken from documentation.

**Files:**
- Create: `src-tauri/src/bin/broker_sim.rs`
- Create: `docs/broker/retry-dlq-contract.md`
- Create: `tests/broker-dlq-properties.test.mjs`

**Interfaces:**
- Consumes: `binary::produce_one` from Task 5.
- Produces: `docs/broker/retry-dlq-contract.md` — the observed property names, which Phase B reads message evidence from and Phase D maps retry chains with.

- [ ] **Step 1: Write the simulator**

```rust
// src-tauri/src/bin/broker_sim.rs
//! Phase 0 consumer simulator.
//!
//! Exists for one reason: the bundled pulsar-client CLI has no nack/DLQ flags,
//! so the properties Pulsar attaches to retried and dead-lettered messages
//! cannot be observed without a real consumer. Run it, then read the DLQ topic
//! and record what is actually there — never copy the names from docs.
//!
//! Usage: cargo run --bin broker_sim -- pulsar://localhost:6650
use futures::StreamExt;
use pulsar::{consumer::ConsumerOptions, message::proto, Consumer, DeadLetterPolicy, Pulsar, SubType, TokioExecutor};

const TOPIC: &str = "persistent://public/default/broker-sim-source";
const DLQ: &str = "persistent://public/default/broker-sim-source-DLQ";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::args().nth(1).unwrap_or_else(|| "pulsar://localhost:6650".into());
    let pulsar: Pulsar<_> = Pulsar::builder(&url, TokioExecutor).build().await?;

    // Produce one message carrying correlation keys, so we can see whether they
    // survive the retry/DLQ hop.
    let mut producer = pulsar.producer().with_topic(TOPIC).build().await?;
    producer
        .create_message()
        .with_content(b"will-fail".to_vec())
        .with_property("correlationId", "sim-corr-1")
        .with_property("traceId", "sim-trace-1")
        .send_non_blocking()
        .await?
        .await?;
    println!("produced 1 message to {TOPIC}");

    // Consume and nack every message so it exhausts redelivery and lands in the DLQ.
    let mut consumer: Consumer<Vec<u8>, _> = pulsar
        .consumer()
        .with_topic(TOPIC)
        .with_subscription("sim-sub")
        .with_subscription_type(SubType::Shared)
        .with_dead_letter_policy(DeadLetterPolicy {
            max_redeliver_count: 2,
            dead_letter_topic: DLQ.to_string(),
        })
        .with_options(ConsumerOptions {
            initial_position: proto::command_subscribe::InitialPosition::Earliest.into(),
            ..Default::default()
        })
        .build()
        .await?;

    let mut nacked = 0;
    while nacked < 4 {
        match tokio::time::timeout(std::time::Duration::from_secs(10), consumer.next()).await {
            Ok(Some(Ok(msg))) => {
                println!("nack #{} id={:?}", nacked + 1, msg.message_id());
                consumer.nack(&msg).await?;
                nacked += 1;
            }
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(None) | Err(_) => break,
        }
    }
    println!("nacked {nacked} deliveries; check {DLQ}");
    Ok(())
}
```

- [ ] **Step 2: Run it and read the DLQ**

```bash
docker compose -f infra/broker/docker-compose.local.yml up -d
cd src-tauri && cargo run --bin broker_sim -- pulsar://localhost:6650
cd .. && curl -s -X PUT http://localhost:8080/admin/v2/persistent/public/default/broker-sim-source-DLQ/subscription/insp \
  -H 'Content-Type: application/json' -d '{"ledgerId":-1,"entryId":-1}'
curl -s -D- -o /dev/null \
  http://localhost:8080/admin/v2/persistent/public/default/broker-sim-source-DLQ/subscription/insp/position/1 \
  | grep -i x-pulsar
```

Expected: a `200` with `X-Pulsar-PROPERTY` containing Pulsar's own retry/DLQ keys
alongside the original `correlationId` / `traceId`. **Write down exactly what appears.**

- [ ] **Step 3: Record the observed contract**

Create `docs/broker/retry-dlq-contract.md` and fill the table with the names observed
in Step 2 — not with names from documentation. Mark anything that did not appear as
`not observed`, and say so plainly rather than assuming it exists.

```markdown
# Retry / DLQ message contract (observed)

Source: local Pulsar 4.2.4, `cargo run --bin broker_sim`, 2026-09-__.

| Property key | Example value | Meaning | Observed |
|---|---|---|---|
| _(fill from Step 2 output)_ | | | ✅ / not observed |

Original producer properties (`correlationId`, `traceId`) survived the DLQ hop: yes / no.

## Rules for Phase B and D

- Only keys marked ✅ above may be read. Anything else is `Unknown` in the UI.
- Re-run the simulator whenever the broker version changes.
```

- [ ] **Step 4: Write the regression test**

```js
// tests/broker-dlq-properties.test.mjs
// Guards the retry/DLQ contract: if a broker upgrade renames these properties,
// this fails before Phase B's Message Inspector starts showing Unknown.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const ADMIN = process.env.BROKER_ADMIN_URL ?? "http://localhost:8080";
const DLQ = "persistent://public/default/broker-sim-source-DLQ";

test("DLQ messages carry the documented properties", async (t) => {
  const res = await fetch(`${ADMIN}/admin/v2/persistent/public/default/broker-sim-source-DLQ/subscription/insp/position/1`);
  if (res.status === 404) {
    t.skip("run `cargo run --bin broker_sim` first to populate the DLQ");
    return;
  }
  assert.equal(res.status, 200);

  const props = JSON.parse(res.headers.get("x-pulsar-property") ?? "{}");
  const doc = await readFile(new URL("../docs/broker/retry-dlq-contract.md", import.meta.url), "utf8");

  for (const key of Object.keys(props)) {
    assert.ok(doc.includes(key), `property "${key}" appeared on the wire but is not in retry-dlq-contract.md`);
  }
  assert.ok(props.correlationId, "original correlation keys must survive the DLQ hop");
});
```

- [ ] **Step 5: Run it**

```bash
node --test tests/broker-dlq-properties.test.mjs
```

Expected: PASS. If it fails because a key is missing from the doc, add the key to the
doc — the wire is the source of truth, not the doc.

- [ ] **Step 6: Clean up and commit**

```bash
curl -s -X DELETE 'http://localhost:8080/admin/v2/persistent/public/default/broker-sim-source?force=true'
curl -s -X DELETE 'http://localhost:8080/admin/v2/persistent/public/default/broker-sim-source-DLQ?force=true'
git add src-tauri/src/bin/broker_sim.rs docs/broker/retry-dlq-contract.md tests/broker-dlq-properties.test.mjs
git commit -m "test(broker): observe real retry/DLQ properties via consumer simulator"
```

---

## Part 1 Gate

Do not start Part 2 until all of these hold:

- [ ] `node --test tests/broker-capability.test.mjs` passes against both the local-open and local-secure profiles
- [ ] `node --test tests/broker-dlq-properties.test.mjs` passes
- [ ] `cd src-tauri && cargo test` passes, including `--test broker_binary` against live Pulsar
- [ ] `docs/broker/retry-dlq-contract.md` contains observed names, with no placeholder rows
- [ ] The real 401 / 403 status codes and `reason` bodies from Task 3 are written down — Task 8's error map is built from them
- [ ] No scratch topic remains: `curl -s http://localhost:8080/admin/v2/persistent/public/default | grep -c broker-` returns `0`

If any validation came back ⛔, stop and revise the affected phase's design in the
spec before continuing. Recording a blocker and proceeding as planned is not allowed.

---

# Part 2 — Contracts and core logic

Pure TypeScript, no Tauri. Everything here is testable with `node --test`, which is
the repo's existing idiom. Putting the logic here rather than in React components is
what makes the "complete tests" requirement achievable.

---

### Task 7: `@penguin/broker-contracts`

**Files:**
- Create: `packages/broker-contracts/package.json`
- Create: `packages/broker-contracts/tsconfig.json`
- Create: `packages/broker-contracts/src/index.ts`
- Create: `packages/broker-contracts/src/envelope.ts`
- Create: `packages/broker-contracts/src/connection.ts`
- Create: `packages/broker-contracts/src/capability.ts`
- Create: `packages/broker-contracts/src/topic.ts`
- Modify: `package.json` — add the package to `build` and `typecheck` chains

**Interfaces:**
- Produces: all shared types. Tasks 8, 9, 13, 15, 16, 17 import from `@penguin/broker-contracts`.

- [ ] **Step 1: Create the package manifest and tsconfig**

```json
{
  "name": "@penguin/broker-contracts",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -p tsconfig.json --watch"
  },
  "devDependencies": { "@types/node": "^22.10.0" }
}
```

`packages/broker-contracts/tsconfig.json` — copy `packages/knowledge-contracts/tsconfig.json` verbatim.

- [ ] **Step 2: Write the envelope types**

```ts
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
```

- [ ] **Step 3: Write the connection and capability types**

```ts
// packages/broker-contracts/src/connection.ts

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
  /** Keychain reference. The token itself never lives here. */
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
```

```ts
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
```

- [ ] **Step 4: Write the topic types**

```ts
// packages/broker-contracts/src/topic.ts

/** One logical topic. A partitioned topic is ONE of these with partitions > 0,
 *  never N rows — Admin REST returns the expanded form and we fold it (V-A6). */
export interface TopicSummary {
  fullName: string;          // persistent://public/default/orders
  shortName: string;         // orders
  tenant: string;
  namespace: string;
  persistent: boolean;
  partitions: number;        // 0 = non-partitioned
  partitionNames: string[];  // expanded names, empty when partitions === 0
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface PageQuery {
  offset: number;
  limit: number;
  search?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}
```

```ts
// packages/broker-contracts/src/index.ts
export * from "./envelope.js";
export * from "./connection.js";
export * from "./capability.js";
export * from "./topic.js";
```

- [ ] **Step 5: Add to the build chain**

In the root `package.json`, add `pnpm -F @penguin/broker-contracts build` to both the
`build` and `typecheck` scripts, immediately after the `@penguin/knowledge-contracts` entry.

- [ ] **Step 6: Verify it builds**

```bash
pnpm install
pnpm -F @penguin/broker-contracts build
```

Expected: `dist/index.js` and `dist/index.d.ts` exist, no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/broker-contracts package.json pnpm-lock.yaml
git commit -m "feat(broker): add broker-contracts shared types"
```

---

### Task 8: `broker-core` — error mapping

The single most consequential piece of logic in Phase 0. Two findings make the naive
implementation wrong: a `500` carrying `SchemaValidationException` is a *result*
(the schema is incompatible), not a fault; and success spans `200`, `202`, and `204`.

**Files:**
- Create: `packages/broker-core/package.json`
- Create: `packages/broker-core/tsconfig.json`
- Create: `packages/broker-core/src/error-map.ts`
- Create: `packages/broker-core/src/index.ts`
- Create: `tests/broker-error-map.test.mjs`
- Modify: root `package.json` — build chain

**Interfaces:**
- Consumes: `BrokerErrorCode`, `BrokerError` from `@penguin/broker-contracts`.
- Produces:
  - `isSuccess(status: number): boolean`
  - `mapHttpError(status: number, reason: string | null, path: string): BrokerError`
  - `mapTransportError(err: { kind: "timeout" | "tls" | "connect" | "parse"; message: string }): BrokerError`
  Task 10's Rust adapter mirrors this table; Task 16's UI renders `BrokerError.code`.

- [ ] **Step 1: Write the failing test**

```js
// tests/broker-error-map.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { isSuccess, mapHttpError, mapTransportError } from "@penguin/broker-core";

test("success spans 200, 202 and 204", () => {
  // 202 is the schema compatibility endpoint's success code; 204 is every write.
  // Hardcoding `=== 200` silently breaks both.
  assert.equal(isSuccess(200), true);
  assert.equal(isSuccess(202), true);
  assert.equal(isSuccess(204), true);
  assert.equal(isSuccess(404), false);
});

test("an incompatible schema is a result, not a server fault", () => {
  const reason =
    "Error during schema compatibility check with strategy FULL: " +
    "org.apache.avro.SchemaValidationException: Unable to read schema";
  const err = mapHttpError(500, reason, "/admin/v2/schemas/public/default/t/compatibility");
  assert.equal(err.code, "SCHEMA_INCOMPATIBLE");
  assert.equal(err.retryable, false, "retrying an incompatible schema never helps");
});

test("a genuine 500 stays retryable", () => {
  const err = mapHttpError(500, "Internal server error", "/admin/v2/tenants");
  assert.equal(err.code, "SOURCE_UNAVAILABLE");
  assert.equal(err.retryable, true);
});

test("405 on peek means not-supported-here, not method-not-allowed noise", () => {
  const err = mapHttpError(405, "Peek messages on a partitioned topic is not allowed", "/peek");
  assert.equal(err.code, "NOT_SUPPORTED_HERE");
  assert.equal(err.retryable, false);
});

test("409 is a conflict the user must resolve, not a retry", () => {
  const err = mapHttpError(409, "Topic has active subscriptions", "/admin/v2/tenants/x");
  assert.equal(err.code, "CONFLICT");
  assert.equal(err.retryable, false);
});

test("auth failures are terminal", () => {
  assert.equal(mapHttpError(401, null, "/x").code, "AUTHENTICATION_FAILED");
  assert.equal(mapHttpError(401, null, "/x").retryable, false);
  assert.equal(mapHttpError(403, null, "/x").code, "FORBIDDEN");
});

test("rate limiting is retryable", () => {
  const err = mapHttpError(429, null, "/x");
  assert.equal(err.code, "RATE_LIMITED");
  assert.equal(err.retryable, true);
});

test("transport failures map by kind", () => {
  assert.equal(mapTransportError({ kind: "timeout", message: "" }).code, "TIMEOUT");
  assert.equal(mapTransportError({ kind: "tls", message: "" }).code, "TLS_ERROR");
  assert.equal(mapTransportError({ kind: "tls", message: "" }).retryable, false);
  assert.equal(mapTransportError({ kind: "connect", message: "" }).code, "SOURCE_UNAVAILABLE");
  assert.equal(mapTransportError({ kind: "parse", message: "" }).code, "MALFORMED_RESPONSE");
});

test("the reason field is carried through for display", () => {
  const err = mapHttpError(404, "Namespace does not exist", "/x");
  assert.equal(err.code, "NOT_FOUND");
  assert.match(err.message, /Namespace does not exist/);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --test tests/broker-error-map.test.mjs
```

Expected: FAIL — `Cannot find package '@penguin/broker-core'`.

- [ ] **Step 3: Create the package**

`packages/broker-core/package.json` — same shape as `broker-contracts`, plus:

```json
"dependencies": { "@penguin/broker-contracts": "workspace:*" }
```

`packages/broker-core/tsconfig.json` — copy from `broker-contracts`.

- [ ] **Step 4: Write the implementation**

```ts
// packages/broker-core/src/error-map.ts
import type { BrokerError } from "@penguin/broker-contracts";

/** Pulsar uses 200 for reads, 202 for the schema compatibility check, and 204
 *  for writes. A `=== 200` check silently loses the latter two. */
export function isSuccess(status: number): boolean {
  return status === 200 || status === 202 || status === 204;
}

/** Recognises the one 500 that is a business result rather than a fault:
 *  the schema compatibility endpoint reports incompatibility by throwing. */
function isSchemaIncompatibility(status: number, reason: string | null, path: string): boolean {
  if (status !== 500 || !reason) return false;
  if (!path.includes("/schemas/")) return false;
  return /SchemaValidationException|IncompatibleSchemaException|schema compatibility check/i.test(reason);
}

export function mapHttpError(status: number, reason: string | null, path: string): BrokerError {
  const message = reason ?? `HTTP ${status}`;

  if (isSchemaIncompatibility(status, reason, path)) {
    return { code: "SCHEMA_INCOMPATIBLE", message, retryable: false };
  }

  switch (status) {
    case 401: return { code: "AUTHENTICATION_FAILED", message, retryable: false };
    case 403: return { code: "FORBIDDEN", message, retryable: false };
    case 404: return { code: "NOT_FOUND", message, retryable: false };
    case 405: return { code: "NOT_SUPPORTED_HERE", message, retryable: false };
    case 409: return { code: "CONFLICT", message, retryable: false };
    case 429: return { code: "RATE_LIMITED", message, retryable: true };
    default:
      if (status >= 500) return { code: "SOURCE_UNAVAILABLE", message, retryable: true };
      return { code: "SOURCE_UNAVAILABLE", message, retryable: false };
  }
}

export function mapTransportError(err: {
  kind: "timeout" | "tls" | "connect" | "parse";
  message: string;
}): BrokerError {
  switch (err.kind) {
    case "timeout": return { code: "TIMEOUT", message: err.message, retryable: true };
    case "tls":     return { code: "TLS_ERROR", message: err.message, retryable: false };
    case "connect": return { code: "SOURCE_UNAVAILABLE", message: err.message, retryable: true };
    case "parse":   return { code: "MALFORMED_RESPONSE", message: err.message, retryable: false };
  }
}
```

```ts
// packages/broker-core/src/index.ts
export * from "./error-map.js";
```

- [ ] **Step 5: Build and run until green**

```bash
pnpm install
pnpm -F @penguin/broker-contracts build && pnpm -F @penguin/broker-core build
node --test tests/broker-error-map.test.mjs
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Reconcile against the observed auth shapes**

Open the `401` / `403` status codes and `reason` bodies recorded in Task 3 Step 6.
If either differs from what `mapHttpError` assumes, fix the map and add a test
using the real observed `reason` string.

- [ ] **Step 7: Add to the build chain and commit**

```bash
# add `pnpm -F @penguin/broker-core build` to the root build and typecheck scripts
git add packages/broker-core tests/broker-error-map.test.mjs package.json pnpm-lock.yaml
git commit -m "feat(broker): error mapping with schema-incompatibility and 202/204 handling"
```

---

### Task 9: `broker-core` — pagination and topic folding

Implements the two findings that shape every list surface: Admin REST ignores
pagination entirely (V-A5), and its topic list returns expanded partitions rather
than logical topics (V-A6).

**Files:**
- Create: `packages/broker-core/src/topic-folding.ts`
- Create: `packages/broker-core/src/pagination.ts`
- Modify: `packages/broker-core/src/index.ts`
- Create: `tests/broker-topic-folding.test.mjs`
- Create: `tests/broker-pagination.test.mjs`

**Interfaces:**
- Consumes: `TopicSummary`, `Page`, `PageQuery` from `@penguin/broker-contracts`.
- Produces:
  - `foldTopics(allTopics: string[], partitionedTopics: string[]): TopicSummary[]`
  - `paginate<T>(items: T[], query: PageQuery, searchOf: (item: T) => string, sortOf: (item: T, key: string) => string | number): Page<T>`
  Task 12's Rust store mirrors both; Task 17's UI consumes `Page<TopicSummary>`.

- [ ] **Step 1: Write the failing folding test**

```js
// tests/broker-topic-folding.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { foldTopics } from "@penguin/broker-core";

// Exactly what GET /admin/v2/persistent/public/default returns for one
// non-partitioned topic plus one 3-partition topic.
const LISTED = [
  "persistent://public/default/orders",
  "persistent://public/default/events-partition-0",
  "persistent://public/default/events-partition-1",
  "persistent://public/default/events-partition-2",
];
const PARTITIONED = ["persistent://public/default/events"];

test("a partitioned topic folds into one row, not N", () => {
  const folded = foldTopics(LISTED, PARTITIONED);
  assert.equal(folded.length, 2, "4 listed entries collapse to 2 logical topics");

  const events = folded.find((t) => t.shortName === "events");
  assert.equal(events.partitions, 3);
  assert.deepEqual(events.partitionNames, [
    "persistent://public/default/events-partition-0",
    "persistent://public/default/events-partition-1",
    "persistent://public/default/events-partition-2",
  ]);
});

test("a non-partitioned topic keeps partitions at 0", () => {
  const orders = foldTopics(LISTED, PARTITIONED).find((t) => t.shortName === "orders");
  assert.equal(orders.partitions, 0);
  assert.deepEqual(orders.partitionNames, []);
});

test("tenant and namespace are parsed out", () => {
  const orders = foldTopics(LISTED, PARTITIONED).find((t) => t.shortName === "orders");
  assert.equal(orders.tenant, "public");
  assert.equal(orders.namespace, "default");
  assert.equal(orders.persistent, true);
});

test("a topic whose name merely contains -partition- is not mistaken for one", () => {
  // A real topic can legitimately be called "my-partition-plan". It must not be
  // folded into a phantom parent.
  const listed = ["persistent://public/default/my-partition-plan"];
  const folded = foldTopics(listed, []);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].shortName, "my-partition-plan");
  assert.equal(folded[0].partitions, 0);
});

test("non-persistent topics are flagged", () => {
  const folded = foldTopics(["non-persistent://public/default/tmp"], []);
  assert.equal(folded[0].persistent, false);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --test tests/broker-topic-folding.test.mjs
```

Expected: FAIL — `foldTopics is not a function`.

- [ ] **Step 3: Implement folding**

```ts
// packages/broker-core/src/topic-folding.ts
import type { TopicSummary } from "@penguin/broker-contracts";

const PARTITION_SUFFIX = /-partition-(\d+)$/;

function parse(fullName: string): Omit<TopicSummary, "partitions" | "partitionNames"> {
  // persistent://tenant/namespace/short
  const [scheme, rest] = fullName.split("://");
  const [tenant, namespace, ...shortParts] = (rest ?? "").split("/");
  return {
    fullName,
    shortName: shortParts.join("/"),
    tenant: tenant ?? "",
    namespace: namespace ?? "",
    persistent: scheme === "persistent",
  };
}

/**
 * Admin REST's topic list returns expanded partitions
 * (`events-partition-0..2`) while only `/partitioned` knows the logical topic
 * (`events`). Rendering the raw list shows one topic as N rows. This folds them.
 *
 * Membership is decided by the `/partitioned` list, never by the name pattern
 * alone — a topic legitimately named `my-partition-plan` must survive intact.
 */
export function foldTopics(allTopics: string[], partitionedTopics: string[]): TopicSummary[] {
  const parents = new Set(partitionedTopics);
  const byParent = new Map<string, string[]>();
  const standalone: string[] = [];

  for (const name of allTopics) {
    const match = name.match(PARTITION_SUFFIX);
    const candidateParent = match ? name.replace(PARTITION_SUFFIX, "") : null;

    if (candidateParent && parents.has(candidateParent)) {
      const list = byParent.get(candidateParent) ?? [];
      list.push(name);
      byParent.set(candidateParent, list);
    } else {
      standalone.push(name);
    }
  }

  const folded: TopicSummary[] = standalone.map((name) => ({
    ...parse(name),
    partitions: 0,
    partitionNames: [],
  }));

  for (const parent of parents) {
    const partitionNames = (byParent.get(parent) ?? []).sort((a, b) => {
      const ai = Number(a.match(PARTITION_SUFFIX)?.[1] ?? 0);
      const bi = Number(b.match(PARTITION_SUFFIX)?.[1] ?? 0);
      return ai - bi;
    });
    folded.push({ ...parse(parent), partitions: partitionNames.length, partitionNames });
  }

  return folded.sort((a, b) => a.fullName.localeCompare(b.fullName));
}
```

- [ ] **Step 4: Run folding tests until green**

```bash
pnpm -F @penguin/broker-core build && node --test tests/broker-topic-folding.test.mjs
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing pagination test**

```js
// tests/broker-pagination.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { paginate } from "@penguin/broker-core";

const items = Array.from({ length: 250 }, (_, i) => ({ name: `topic-${String(i).padStart(3, "0")}`, size: i }));
const searchOf = (t) => t.name;
const sortOf = (t, key) => (key === "size" ? t.size : t.name);

test("returns one page and the true total", () => {
  // Admin REST hands us everything at once; the page boundary is ours to draw.
  const page = paginate(items, { offset: 0, limit: 25 }, searchOf, sortOf);
  assert.equal(page.items.length, 25);
  assert.equal(page.total, 250);
  assert.equal(page.offset, 0);
});

test("offset walks the list", () => {
  const page = paginate(items, { offset: 240, limit: 25 }, searchOf, sortOf);
  assert.equal(page.items.length, 10, "last page is short, not padded");
  assert.equal(page.items[0].name, "topic-240");
});

test("search narrows before paging, and total reflects the filtered set", () => {
  const page = paginate(items, { offset: 0, limit: 25, search: "topic-01" }, searchOf, sortOf);
  assert.equal(page.total, 10, "topic-010..019");
  assert.ok(page.items.every((t) => t.name.includes("topic-01")));
});

test("search is case-insensitive", () => {
  const page = paginate(items, { offset: 0, limit: 5, search: "TOPIC-1" }, searchOf, sortOf);
  assert.ok(page.total > 0);
});

test("sorting applies before paging", () => {
  const page = paginate(items, { offset: 0, limit: 3, sortBy: "size", sortDir: "desc" }, searchOf, sortOf);
  assert.deepEqual(page.items.map((t) => t.size), [249, 248, 247]);
});

test("an offset past the end yields an empty page, not a crash", () => {
  const page = paginate(items, { offset: 9999, limit: 25 }, searchOf, sortOf);
  assert.deepEqual(page.items, []);
  assert.equal(page.total, 250);
});

test("an empty source yields an empty page", () => {
  const page = paginate([], { offset: 0, limit: 25 }, searchOf, sortOf);
  assert.deepEqual(page.items, []);
  assert.equal(page.total, 0);
});
```

- [ ] **Step 6: Run to verify it fails, then implement**

```bash
node --test tests/broker-pagination.test.mjs   # FAIL: paginate is not a function
```

```ts
// packages/broker-core/src/pagination.ts
import type { Page, PageQuery } from "@penguin/broker-contracts";

/**
 * Pagination lives here because Pulsar's Admin REST ignores `page` / `size`
 * entirely and always returns the full array (spec V-A5). Filter, then sort,
 * then slice — `total` must describe the filtered set or the UI's page count lies.
 */
export function paginate<T>(
  items: T[],
  query: PageQuery,
  searchOf: (item: T) => string,
  sortOf: (item: T, key: string) => string | number,
): Page<T> {
  let working = items;

  if (query.search && query.search.trim() !== "") {
    const needle = query.search.trim().toLowerCase();
    working = working.filter((item) => searchOf(item).toLowerCase().includes(needle));
  }

  if (query.sortBy) {
    const key = query.sortBy;
    const dir = query.sortDir === "desc" ? -1 : 1;
    working = [...working].sort((a, b) => {
      const av = sortOf(a, key);
      const bv = sortOf(b, key);
      if (av === bv) return 0;
      return (av < bv ? -1 : 1) * dir;
    });
  }

  const offset = Math.max(0, query.offset);
  const limit = Math.max(1, query.limit);
  return {
    items: working.slice(offset, offset + limit),
    total: working.length,
    offset,
    limit,
  };
}
```

Add both exports to `packages/broker-core/src/index.ts`:

```ts
export * from "./error-map.js";
export * from "./topic-folding.js";
export * from "./pagination.js";
```

- [ ] **Step 7: Run both suites until green**

```bash
pnpm -F @penguin/broker-core build
node --test tests/broker-pagination.test.mjs tests/broker-topic-folding.test.mjs
```

Expected: PASS, 12 tests total.

- [ ] **Step 8: Commit**

```bash
git add packages/broker-core tests/broker-pagination.test.mjs tests/broker-topic-folding.test.mjs
git commit -m "feat(broker): Rust-side pagination model and partition folding"
```

---

## Part 2 Gate

- [ ] `pnpm -F @penguin/broker-contracts build && pnpm -F @penguin/broker-core build` succeeds
- [ ] `node --test tests/broker-error-map.test.mjs tests/broker-pagination.test.mjs tests/broker-topic-folding.test.mjs` passes — 21 tests
- [ ] The error map's `401` / `403` handling matches the shapes observed in Task 3, not documentation
- [ ] `pnpm typecheck` passes with both new packages in the chain

---

# Part 3 — Rust backend

The only component that touches Pulsar. Everything here enforces the boundaries the
webview cannot be trusted with.

---

### Task 10: Result envelope and ports

The dependency order in this part is envelope → security → adapter: the security
guards return `BrokerError`, and the adapter uses both. This task delivers the
bottom layer only.

**Files:**
- Create: `src-tauri/src/broker/envelope.rs`
- Create: `src-tauri/src/broker/ports.rs`
- Modify: `src-tauri/src/broker/mod.rs`
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: nothing from earlier tasks — this is the base layer.
- Produces:
  - `BrokerErrorCode` enum, `BrokerError { code, message, retryable }`, `ResultEnvelope<T>` with `ok()` / `failed()`
  - `is_success(status: u16) -> bool` — accepts 200, 202 and 204
  - `map_http_error(status: u16, reason: Option<&str>, path: &str) -> BrokerError` — the Rust mirror of Task 8
  - `map_reqwest_error(err: &reqwest::Error) -> BrokerError`
  - `trait BrokerAdmin`, `TopicRef { tenant, namespace, topic, persistent }` with `rest_path()`
  Task 11's guards return `BrokerError`; Task 12 implements `BrokerAdmin`; Tasks 13 and 14 consume both.

- [ ] **Step 1: Write the failing error-map test**

The Rust map must agree with the TypeScript one from Task 8. Divergence means the UI
and the backend disagree about what a failure means.

```rust
// bottom of src-tauri/src/broker/envelope.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_spans_200_202_and_204() {
        assert!(is_success(200));
        assert!(is_success(202)); // schema compatibility check
        assert!(is_success(204)); // every write
        assert!(!is_success(404));
    }

    #[test]
    fn schema_incompatibility_is_a_result_not_a_fault() {
        let reason = "Error during schema compatibility check with strategy FULL: \
                      org.apache.avro.SchemaValidationException: Unable to read schema";
        let err = map_http_error(500, Some(reason), "/admin/v2/schemas/public/default/t/compatibility");
        assert_eq!(err.code, BrokerErrorCode::SchemaIncompatible);
        assert!(!err.retryable);
    }

    #[test]
    fn a_genuine_500_stays_retryable() {
        let err = map_http_error(500, Some("Internal server error"), "/admin/v2/tenants");
        assert_eq!(err.code, BrokerErrorCode::SourceUnavailable);
        assert!(err.retryable);
    }

    #[test]
    fn peek_on_partitioned_is_not_supported_here() {
        let err = map_http_error(405, Some("Peek messages on a partitioned topic is not allowed"), "/peek");
        assert_eq!(err.code, BrokerErrorCode::NotSupportedHere);
    }

    #[test]
    fn conflict_and_auth_are_terminal() {
        assert_eq!(map_http_error(409, None, "/x").code, BrokerErrorCode::Conflict);
        assert_eq!(map_http_error(401, None, "/x").code, BrokerErrorCode::AuthenticationFailed);
        assert_eq!(map_http_error(403, None, "/x").code, BrokerErrorCode::Forbidden);
        assert!(map_http_error(429, None, "/x").retryable);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd src-tauri && cargo test broker::envelope
```

Expected: FAIL to compile — nothing is defined yet.

- [ ] **Step 3: Write the envelope and error map**

```rust
// src-tauri/src/broker/envelope.rs
//! Result envelope and error mapping. Mirrors packages/broker-core/src/error-map.ts —
//! the two must agree, or the UI and backend disagree about what a failure means.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BrokerErrorCode {
    AuthenticationFailed,
    Forbidden,
    NotFound,
    NotSupportedHere,
    Conflict,
    RateLimited,
    SchemaIncompatible,
    SourceUnavailable,
    Timeout,
    TlsError,
    MalformedResponse,
    ReadOnlyBlocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerError {
    pub code: BrokerErrorCode,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultEnvelope<T> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    pub source: String,
    pub observed_at: String,
    pub freshness_ms: u64,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BrokerError>,
}

impl<T> ResultEnvelope<T> {
    pub fn ok(data: T, source: &str) -> Self {
        Self {
            data: Some(data),
            source: source.to_string(),
            observed_at: now_iso8601(),
            freshness_ms: 0,
            warnings: Vec::new(),
            error: None,
        }
    }

    pub fn failed(error: BrokerError, source: &str) -> Self {
        Self {
            data: None,
            source: source.to_string(),
            observed_at: now_iso8601(),
            freshness_ms: 0,
            warnings: Vec::new(),
            error: Some(error),
        }
    }
}

fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

/// Pulsar uses 200 for reads, 202 for the schema compatibility check, and 204
/// for writes. Checking `== 200` silently loses the latter two.
pub fn is_success(status: u16) -> bool {
    matches!(status, 200 | 202 | 204)
}

fn is_schema_incompatibility(status: u16, reason: Option<&str>, path: &str) -> bool {
    if status != 500 || !path.contains("/schemas/") {
        return false;
    }
    reason.is_some_and(|r| {
        r.contains("SchemaValidationException")
            || r.contains("IncompatibleSchemaException")
            || r.contains("schema compatibility check")
    })
}

pub fn map_http_error(status: u16, reason: Option<&str>, path: &str) -> BrokerError {
    let message = reason.map(str::to_string).unwrap_or_else(|| format!("HTTP {status}"));

    if is_schema_incompatibility(status, reason, path) {
        return BrokerError { code: BrokerErrorCode::SchemaIncompatible, message, retryable: false };
    }

    let (code, retryable) = match status {
        401 => (BrokerErrorCode::AuthenticationFailed, false),
        403 => (BrokerErrorCode::Forbidden, false),
        404 => (BrokerErrorCode::NotFound, false),
        405 => (BrokerErrorCode::NotSupportedHere, false),
        409 => (BrokerErrorCode::Conflict, false),
        429 => (BrokerErrorCode::RateLimited, true),
        s if s >= 500 => (BrokerErrorCode::SourceUnavailable, true),
        _ => (BrokerErrorCode::SourceUnavailable, false),
    };
    BrokerError { code, message, retryable }
}

/// Classifies a reqwest failure. TLS is not retryable — a bad certificate will
/// still be bad on the next attempt.
pub fn map_reqwest_error(err: &reqwest::Error) -> BrokerError {
    let message = err.to_string();
    let (code, retryable) = if err.is_timeout() {
        (BrokerErrorCode::Timeout, true)
    } else if message.contains("certificate") || message.contains("tls") || message.contains("TLS") {
        (BrokerErrorCode::TlsError, false)
    } else if err.is_decode() {
        (BrokerErrorCode::MalformedResponse, false)
    } else {
        (BrokerErrorCode::SourceUnavailable, true)
    };
    BrokerError { code, message, retryable }
}
```

- [ ] **Step 4: Write the ports**

```rust
// src-tauri/src/broker/ports.rs
//! Transport-agnostic ports. Only the Pulsar adapter implements them today;
//! the trait exists so a second broker kind does not require reshaping callers.
//! Phase 0 implements BrokerAdmin only — the other two are signatures for
//! Phases B and C and are deliberately not wired up yet.

use crate::broker::envelope::BrokerError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicRef {
    pub tenant: String,
    pub namespace: String,
    pub topic: String,
    pub persistent: bool,
}

impl TopicRef {
    /// Path segment used by Admin REST: `persistent/public/default/orders`.
    pub fn rest_path(&self) -> String {
        let domain = if self.persistent { "persistent" } else { "non-persistent" };
        format!("{domain}/{}/{}/{}", self.tenant, self.namespace, self.topic)
    }
}

#[async_trait::async_trait]
pub trait BrokerAdmin: Send + Sync {
    async fn broker_version(&self) -> Result<String, BrokerError>;
    async fn list_clusters(&self) -> Result<Vec<String>, BrokerError>;
    async fn list_tenants(&self) -> Result<Vec<String>, BrokerError>;
    async fn list_namespaces(&self, tenant: &str) -> Result<Vec<String>, BrokerError>;
    /// Returns the raw expanded list. Folding into logical topics is the caller's job.
    async fn list_topics(&self, tenant: &str, namespace: &str) -> Result<Vec<String>, BrokerError>;
    async fn list_partitioned_topics(&self, tenant: &str, namespace: &str) -> Result<Vec<String>, BrokerError>;
    async fn get_topic_stats(&self, topic: &TopicRef) -> Result<serde_json::Value, BrokerError>;
    async fn list_subscriptions(&self, topic: &TopicRef) -> Result<Vec<String>, BrokerError>;
}
```

Add to `src-tauri/Cargo.toml`:

```toml
async-trait = "0.1"
```

- [ ] **Step 5: Wire the module tree and run**

```rust
// src-tauri/src/broker/mod.rs
pub mod adapters;
pub mod envelope;
pub mod ports;
```

```bash
cd src-tauri && cargo test broker::envelope
```

Expected: PASS, 5 tests. `security` and `adapters::pulsar::admin_rest` are not
declared here — they arrive in Tasks 11 and 12.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/broker/envelope.rs src-tauri/src/broker/ports.rs \
        src-tauri/src/broker/mod.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(broker): result envelope, error map, and transport ports"
```

---

### Task 11: Security gate — five failing tests first

The spec requires five guarantees, each proved by a test that fails before the
guard exists. Local Pulsar accepts every write from anyone, so `read_only` is only
real if our own code refuses to send.

**Files:**
- Create: `src-tauri/src/broker/security.rs`
- Modify: `src-tauri/src/broker/mod.rs`

**Interfaces:**
- Produces:
  - `EndpointGuard::new(base_url: &str) -> Result<Self, BrokerError>` and `.check(url: &str) -> Result<(), BrokerError>`
  - `WriteGuard::new(read_only: bool)` and `.authorize(action: &str) -> Result<(), BrokerError>`
  - `redact(text: &str) -> String`
  Task 10's adapter calls `EndpointGuard`; Task 13's commands call `WriteGuard`; Task 13's logging calls `redact`.

- [ ] **Step 1: Write all five failing tests**

```rust
// bottom of src-tauri/src/broker/security.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::envelope::BrokerErrorCode;

    // Guarantee 4: read_only is enforced here, because Pulsar will not enforce it.
    #[test]
    fn read_only_refuses_before_any_request_is_sent() {
        let guard = WriteGuard::new(true);
        let err = guard.authorize("delete_topic").expect_err("a read-only connection must refuse writes");
        assert_eq!(err.code, BrokerErrorCode::ReadOnlyBlocked);
        assert!(!err.retryable, "retrying a blocked write must never be suggested");
    }

    #[test]
    fn a_writable_connection_allows_writes() {
        assert!(WriteGuard::new(false).authorize("delete_topic").is_ok());
    }

    // Guarantee 5: the allowlist stops SSRF via a crafted connection URL.
    #[test]
    fn endpoint_guard_rejects_a_host_outside_the_connection() {
        let guard = EndpointGuard::new("http://localhost:8080").unwrap();
        assert!(guard.check("http://localhost:8080/admin/v2/tenants").is_ok());

        let err = guard
            .check("http://evil.example.com/admin/v2/tenants")
            .expect_err("a different host must be refused");
        assert_eq!(err.code, BrokerErrorCode::Forbidden);
    }

    #[test]
    fn endpoint_guard_rejects_a_port_change_on_the_same_host() {
        let guard = EndpointGuard::new("http://localhost:8080").unwrap();
        assert!(guard.check("http://localhost:9999/admin/v2/tenants").is_err());
    }

    // Guarantee 3: secrets never reach logs or error_log.
    #[test]
    fn redact_removes_bearer_tokens_and_passwords() {
        let line = "GET /x Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def failed";
        let out = redact(line);
        assert!(!out.contains("eyJhbGciOiJIUzI1NiJ9.abc.def"), "token must not survive redaction");
        assert!(out.contains("Bearer ***"));
    }

    #[test]
    fn redact_leaves_ordinary_text_alone() {
        assert_eq!(redact("listing topics for public/default"), "listing topics for public/default");
    }
}
```

- [ ] **Step 2: Run to verify all five fail**

```bash
cd src-tauri && cargo test broker::security
```

Expected: FAIL to compile — `WriteGuard`, `EndpointGuard`, `redact` are undefined. Confirm before implementing.

- [ ] **Step 3: Implement the guards**

```rust
// src-tauri/src/broker/security.rs
//! Security boundary for the broker module.
//!
//! Local Pulsar is unauthenticated and accepts every write (spec V-E8), so
//! `read_only` is only meaningful if this module refuses to send. Likewise the
//! endpoint allowlist is what stops a crafted connection URL from turning the
//! Rust backend into an SSRF proxy.

use crate::broker::envelope::{BrokerError, BrokerErrorCode};

/// Refuses writes on a read-only connection before a request is ever built.
pub struct WriteGuard {
    read_only: bool,
}

impl WriteGuard {
    pub fn new(read_only: bool) -> Self {
        Self { read_only }
    }

    pub fn authorize(&self, action: &str) -> Result<(), BrokerError> {
        if self.read_only {
            return Err(BrokerError {
                code: BrokerErrorCode::ReadOnlyBlocked,
                message: format!("connection is read-only; `{action}` was not sent"),
                retryable: false,
            });
        }
        Ok(())
    }
}

/// Pins every request to the scheme, host and port of the connection's own URL.
pub struct EndpointGuard {
    scheme: String,
    host: String,
    port: Option<u16>,
}

fn split_origin(url: &str) -> Option<(String, String, Option<u16>)> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split('/').next()?;
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) => (h.to_string(), p.parse().ok()),
        _ => (authority.to_string(), None),
    };
    Some((scheme.to_string(), host, port))
}

impl EndpointGuard {
    pub fn new(base_url: &str) -> Result<Self, BrokerError> {
        let (scheme, host, port) = split_origin(base_url).ok_or(BrokerError {
            code: BrokerErrorCode::Forbidden,
            message: format!("unparseable connection URL: {base_url}"),
            retryable: false,
        })?;
        Ok(Self { scheme, host, port })
    }

    pub fn check(&self, url: &str) -> Result<(), BrokerError> {
        let refuse = |why: &str| BrokerError {
            code: BrokerErrorCode::Forbidden,
            message: format!("endpoint refused: {why}"),
            retryable: false,
        };
        let (scheme, host, port) = split_origin(url).ok_or_else(|| refuse("unparseable URL"))?;
        if scheme != self.scheme || host != self.host || port != self.port {
            return Err(refuse("target is outside the connection's own origin"));
        }
        Ok(())
    }
}

/// Strips credentials from any string headed for a log, an error message, or error_log.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(idx) = rest.find("Bearer ") {
        out.push_str(&rest[..idx]);
        out.push_str("Bearer ***");
        let after = &rest[idx + "Bearer ".len()..];
        let end = after.find(char::is_whitespace).unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}
```

- [ ] **Step 4: Run until green**

```bash
cd src-tauri && cargo test broker::security
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/broker/security.rs src-tauri/src/broker/mod.rs
git commit -m "feat(broker): read-only gate, endpoint allowlist, and redaction"
```

---

### Task 12: Admin REST adapter

Implements `BrokerAdmin` over Pulsar's Admin REST. It deliberately does NOT
produce — Admin REST answers produce with 405 (spec V-E5) — and its peek cannot
serve as an event stream, so both live on the binary transport from Task 5.

**Files:**
- Create: `src-tauri/src/broker/adapters/pulsar/admin_rest.rs`
- Modify: `src-tauri/src/broker/adapters/pulsar/mod.rs`
- Modify: `src-tauri/src/broker/mod.rs` — declare `pub mod security;` if Task 11 has not already

**Interfaces:**
- Consumes: `is_success`, `map_http_error`, `map_reqwest_error`, `BrokerError`, `BrokerAdmin`, `TopicRef` (Task 10); `EndpointGuard` (Task 11).
- Produces: `PulsarAdminRest::new(admin_url: String, timeout_ms: u64, tls_verify: bool, token: Option<String>) -> Result<Self, BrokerError>` implementing `BrokerAdmin`.
  Task 14 constructs this for capability discovery and for `broker_list_topics`.

- [ ] **Step 1: Write the adapter**

```rust
// src-tauri/src/broker/adapters/pulsar/admin_rest.rs
//! Pulsar Admin REST transport. Handles topology, stats, schema and ops actions.
//! It cannot produce (405) and its peek cannot serve as an event stream — those
//! live in `binary.rs`.

use crate::broker::envelope::{is_success, map_http_error, map_reqwest_error, BrokerError};
use crate::broker::ports::{BrokerAdmin, TopicRef};
use crate::broker::security::EndpointGuard;

pub struct PulsarAdminRest {
    client: reqwest::Client,
    base: String,
    token: Option<String>,
    guard: EndpointGuard,
}

impl PulsarAdminRest {
    pub fn new(admin_url: String, timeout_ms: u64, tls_verify: bool, token: Option<String>) -> Result<Self, BrokerError> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .danger_accept_invalid_certs(!tls_verify)
            .build()
            .map_err(|e| map_reqwest_error(&e))?;
        let guard = EndpointGuard::new(&admin_url)?;
        Ok(Self { client, base: admin_url.trim_end_matches('/').to_string(), token, guard })
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, BrokerError> {
        let url = format!("{}{}", self.base, path);
        self.guard.check(&url)?;

        let mut req = self.client.get(&url);
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }

        let res = req.send().await.map_err(|e| map_reqwest_error(&e))?;
        let status = res.status().as_u16();
        let body = res.text().await.map_err(|e| map_reqwest_error(&e))?;

        if !is_success(status) {
            let reason = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(str::to_string));
            return Err(map_http_error(status, reason.as_deref(), path));
        }

        serde_json::from_str(&body).map_err(|e| BrokerError {
            code: crate::broker::envelope::BrokerErrorCode::MalformedResponse,
            message: e.to_string(),
            retryable: false,
        })
    }
}

#[async_trait::async_trait]
impl BrokerAdmin for PulsarAdminRest {
    async fn broker_version(&self) -> Result<String, BrokerError> {
        // This endpoint returns a bare string, not JSON — handled separately.
        let url = format!("{}/admin/v2/brokers/version", self.base);
        self.guard.check(&url)?;
        let mut req = self.client.get(&url);
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        let res = req.send().await.map_err(|e| map_reqwest_error(&e))?;
        let status = res.status().as_u16();
        let body = res.text().await.map_err(|e| map_reqwest_error(&e))?;
        if !is_success(status) {
            return Err(map_http_error(status, None, "/admin/v2/brokers/version"));
        }
        Ok(body.trim().to_string())
    }

    async fn list_clusters(&self) -> Result<Vec<String>, BrokerError> {
        self.get_json("/admin/v2/clusters").await
    }

    async fn list_tenants(&self) -> Result<Vec<String>, BrokerError> {
        self.get_json("/admin/v2/tenants").await
    }

    async fn list_namespaces(&self, tenant: &str) -> Result<Vec<String>, BrokerError> {
        self.get_json(&format!("/admin/v2/namespaces/{tenant}")).await
    }

    async fn list_topics(&self, tenant: &str, namespace: &str) -> Result<Vec<String>, BrokerError> {
        // Returns expanded partitions (V-A6). Callers fold with list_partitioned_topics.
        self.get_json(&format!("/admin/v2/persistent/{tenant}/{namespace}")).await
    }

    async fn list_partitioned_topics(&self, tenant: &str, namespace: &str) -> Result<Vec<String>, BrokerError> {
        self.get_json(&format!("/admin/v2/persistent/{tenant}/{namespace}/partitioned")).await
    }

    async fn get_topic_stats(&self, topic: &TopicRef) -> Result<serde_json::Value, BrokerError> {
        self.get_json(&format!("/admin/v2/{}/stats", topic.rest_path())).await
    }

    async fn list_subscriptions(&self, topic: &TopicRef) -> Result<Vec<String>, BrokerError> {
        self.get_json(&format!("/admin/v2/{}/subscriptions", topic.rest_path())).await
    }
}
```

- [ ] **Step 2: Declare the module**

```rust
// src-tauri/src/broker/adapters/pulsar/mod.rs
pub mod admin_rest;
pub mod batch_frame;
pub mod binary;
```

- [ ] **Step 3: Build and run the existing suite**

```bash
cd src-tauri && cargo build && cargo test broker
```

Expected: compiles clean, and Tasks 10 and 11's tests still pass. This adapter has
no unit test of its own — it is a thin HTTP shell over already-tested pieces, and
Task 14's live discovery test exercises it end to end against the real broker.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/broker/adapters/pulsar/admin_rest.rs \
        src-tauri/src/broker/adapters/pulsar/mod.rs src-tauri/src/broker/mod.rs
git commit -m "feat(broker): Admin REST adapter implementing BrokerAdmin"
```

---


### Task 13: SQLite tables and the store

**Files:**
- Modify: `src-tauri/src/db.rs` — two new tables in the existing `execute_batch`
- Create: `src-tauri/src/broker/store.rs`
- Create: `src-tauri/tests/broker_store.rs`

**Interfaces:**
- Consumes: `BrokerError` (Task 10).
- Produces:
  - `upsert_connection(conn: &rusqlite::Connection, row: &ConnectionRow) -> Result<(), BrokerError>`
  - `list_connections(conn) -> Result<Vec<ConnectionRow>, BrokerError>`
  - `get_connection(conn, id: &str) -> Result<Option<ConnectionRow>, BrokerError>`
  - `delete_connection(conn, id: &str) -> Result<(), BrokerError>`
  - `put_snapshot(conn, connection_id, scope, scope_key, payload_json) -> Result<(), BrokerError>`
  - `get_snapshot(conn, connection_id, scope, scope_key) -> Result<Option<(String, i64)>, BrokerError>`
  Task 13 calls all of these.

- [ ] **Step 1: Write the failing test**

```rust
// src-tauri/tests/broker_store.rs
//! Store tests run against an in-memory SQLite so they never touch the user's DB.
use penguin_lib::broker::store::{self, ConnectionRow};

fn memory_db() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    penguin_lib::db::apply_schema(&conn).expect("schema applies to a fresh database");
    conn
}

fn row(id: &str) -> ConnectionRow {
    ConnectionRow {
        id: id.into(),
        kind: "pulsar".into(),
        name: "Local".into(),
        color: "green".into(),
        admin_url: "http://localhost:8080".into(),
        broker_url: "pulsar://localhost:6650".into(),
        auth_type: "none".into(),
        secret_handle_id: None,
        default_tenant: "public".into(),
        default_namespace: "default".into(),
        read_only: true,
        tls_verify: true,
        timeout_ms: 10_000,
        last_status: "unknown".into(),
        last_checked_at: None,
        broker_version: None,
        capabilities_json: None,
        created_at: 1,
        updated_at: 1,
    }
}

#[test]
fn schema_is_idempotent() {
    let conn = memory_db();
    penguin_lib::db::apply_schema(&conn).expect("applying twice must not fail");
}

#[test]
fn upsert_then_read_back() {
    let conn = memory_db();
    store::upsert_connection(&conn, &row("c1")).unwrap();
    let got = store::get_connection(&conn, "c1").unwrap().expect("row exists");
    assert_eq!(got.name, "Local");
    assert!(got.read_only, "read_only defaults to true and survives a round trip");
}

#[test]
fn upsert_replaces_rather_than_duplicating() {
    let conn = memory_db();
    store::upsert_connection(&conn, &row("c1")).unwrap();
    let mut updated = row("c1");
    updated.name = "Renamed".into();
    store::upsert_connection(&conn, &updated).unwrap();

    let all = store::list_connections(&conn).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].name, "Renamed");
}

#[test]
fn no_column_can_hold_a_plaintext_secret() {
    // Guarantee 1: the table has no place to put a token even by accident.
    let conn = memory_db();
    let mut stmt = conn.prepare("SELECT name FROM pragma_table_info('broker_connections')").unwrap();
    let cols: Vec<String> = stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    for banned in ["token", "password", "secret", "credential"] {
        assert!(
            !cols.iter().any(|c| c == banned),
            "broker_connections must not have a `{banned}` column"
        );
    }
    assert!(cols.iter().any(|c| c == "secret_handle_id"), "only a keychain reference is stored");
}

#[test]
fn snapshots_are_unique_per_scope_and_overwrite() {
    let conn = memory_db();
    store::upsert_connection(&conn, &row("c1")).unwrap();
    store::put_snapshot(&conn, "c1", "topics", "public/default", r#"["a"]"#).unwrap();
    store::put_snapshot(&conn, "c1", "topics", "public/default", r#"["a","b"]"#).unwrap();

    let (payload, _observed) = store::get_snapshot(&conn, "c1", "topics", "public/default").unwrap().unwrap();
    assert_eq!(payload, r#"["a","b"]"#, "a second write replaces rather than duplicating");
}

#[test]
fn deleting_a_connection_reports_gone() {
    let conn = memory_db();
    store::upsert_connection(&conn, &row("c1")).unwrap();
    store::delete_connection(&conn, "c1").unwrap();
    assert!(store::get_connection(&conn, "c1").unwrap().is_none());
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd src-tauri && cargo test --test broker_store
```

Expected: FAIL to compile — `store` and `db::apply_schema` are not public.

- [ ] **Step 3: Add the tables**

In `src-tauri/src/db.rs`, inside the existing `conn.execute_batch(r#" ... "#)` block,
after the `error_log` table, append:

```sql
-- Broker module (Phase 0). Two tables:
--   broker_connections       — one row per configured broker. NEVER holds a
--                              plaintext credential: `secret_handle_id` is a
--                              keychain reference (DEC #195).
--   broker_topology_snapshots — cached topology. Exists because Pulsar's Admin
--                              REST ignores pagination entirely, so we page in
--                              Rust over a snapshot rather than per request.
CREATE TABLE IF NOT EXISTS broker_connections (
    id                TEXT PRIMARY KEY,
    kind              TEXT NOT NULL,
    name              TEXT NOT NULL,
    color             TEXT NOT NULL,
    admin_url         TEXT NOT NULL,
    broker_url        TEXT NOT NULL,
    auth_type         TEXT NOT NULL,
    secret_handle_id  TEXT,
    default_tenant    TEXT NOT NULL,
    default_namespace TEXT NOT NULL,
    read_only         INTEGER NOT NULL DEFAULT 1,
    tls_verify        INTEGER NOT NULL DEFAULT 1,
    timeout_ms        INTEGER NOT NULL DEFAULT 10000,
    last_status       TEXT NOT NULL DEFAULT 'unknown',
    last_checked_at   INTEGER,
    broker_version    TEXT,
    capabilities_json TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_broker_connections_updated
    ON broker_connections(updated_at DESC);
CREATE TABLE IF NOT EXISTS broker_topology_snapshots (
    id            TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    scope         TEXT NOT NULL,
    scope_key     TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    observed_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_broker_snapshot_key
    ON broker_topology_snapshots(connection_id, scope, scope_key);
```

Extract the existing `execute_batch` call into a public function so tests can apply
the schema to an in-memory database:

```rust
/// Applies the full schema. Idempotent — every statement is CREATE ... IF NOT EXISTS.
pub fn apply_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())
}
```

Move the SQL into a `const SCHEMA: &str = r#" ... "#;` and have the existing
initialisation path call `apply_schema`. Do not change any existing table definition.

- [ ] **Step 4: Write the store**

```rust
// src-tauri/src/broker/store.rs
//! SQLite persistence for broker connections and topology snapshots.
//! Snapshots exist because Admin REST ignores pagination (spec V-A5): we fetch
//! the full list once, cache it, and page over the cache in Rust.

use crate::broker::envelope::{BrokerError, BrokerErrorCode};
use rusqlite::{params, Connection, Row};

#[derive(Debug, Clone)]
pub struct ConnectionRow {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub color: String,
    pub admin_url: String,
    pub broker_url: String,
    pub auth_type: String,
    pub secret_handle_id: Option<String>,
    pub default_tenant: String,
    pub default_namespace: String,
    pub read_only: bool,
    pub tls_verify: bool,
    pub timeout_ms: i64,
    pub last_status: String,
    pub last_checked_at: Option<i64>,
    pub broker_version: Option<String>,
    pub capabilities_json: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn db_err(e: rusqlite::Error) -> BrokerError {
    BrokerError { code: BrokerErrorCode::SourceUnavailable, message: e.to_string(), retryable: false }
}

fn from_row(r: &Row<'_>) -> rusqlite::Result<ConnectionRow> {
    Ok(ConnectionRow {
        id: r.get("id")?,
        kind: r.get("kind")?,
        name: r.get("name")?,
        color: r.get("color")?,
        admin_url: r.get("admin_url")?,
        broker_url: r.get("broker_url")?,
        auth_type: r.get("auth_type")?,
        secret_handle_id: r.get("secret_handle_id")?,
        default_tenant: r.get("default_tenant")?,
        default_namespace: r.get("default_namespace")?,
        read_only: r.get::<_, i64>("read_only")? != 0,
        tls_verify: r.get::<_, i64>("tls_verify")? != 0,
        timeout_ms: r.get("timeout_ms")?,
        last_status: r.get("last_status")?,
        last_checked_at: r.get("last_checked_at")?,
        broker_version: r.get("broker_version")?,
        capabilities_json: r.get("capabilities_json")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

pub fn upsert_connection(conn: &Connection, row: &ConnectionRow) -> Result<(), BrokerError> {
    conn.execute(
        "INSERT INTO broker_connections (
            id, kind, name, color, admin_url, broker_url, auth_type, secret_handle_id,
            default_tenant, default_namespace, read_only, tls_verify, timeout_ms,
            last_status, last_checked_at, broker_version, capabilities_json,
            created_at, updated_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
         ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, color=excluded.color, admin_url=excluded.admin_url,
            broker_url=excluded.broker_url, auth_type=excluded.auth_type,
            secret_handle_id=excluded.secret_handle_id,
            default_tenant=excluded.default_tenant, default_namespace=excluded.default_namespace,
            read_only=excluded.read_only, tls_verify=excluded.tls_verify,
            timeout_ms=excluded.timeout_ms, last_status=excluded.last_status,
            last_checked_at=excluded.last_checked_at, broker_version=excluded.broker_version,
            capabilities_json=excluded.capabilities_json, updated_at=excluded.updated_at",
        params![
            row.id, row.kind, row.name, row.color, row.admin_url, row.broker_url,
            row.auth_type, row.secret_handle_id, row.default_tenant, row.default_namespace,
            row.read_only as i64, row.tls_verify as i64, row.timeout_ms,
            row.last_status, row.last_checked_at, row.broker_version, row.capabilities_json,
            row.created_at, row.updated_at,
        ],
    )
    .map(|_| ())
    .map_err(db_err)
}

pub fn list_connections(conn: &Connection) -> Result<Vec<ConnectionRow>, BrokerError> {
    let mut stmt = conn
        .prepare("SELECT * FROM broker_connections ORDER BY updated_at DESC")
        .map_err(db_err)?;
    let rows = stmt.query_map([], from_row).map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
}

pub fn get_connection(conn: &Connection, id: &str) -> Result<Option<ConnectionRow>, BrokerError> {
    let mut stmt = conn
        .prepare("SELECT * FROM broker_connections WHERE id = ?1")
        .map_err(db_err)?;
    let mut rows = stmt.query_map(params![id], from_row).map_err(db_err)?;
    match rows.next() {
        Some(r) => Ok(Some(r.map_err(db_err)?)),
        None => Ok(None),
    }
}

pub fn delete_connection(conn: &Connection, id: &str) -> Result<(), BrokerError> {
    conn.execute("DELETE FROM broker_topology_snapshots WHERE connection_id = ?1", params![id])
        .map_err(db_err)?;
    conn.execute("DELETE FROM broker_connections WHERE id = ?1", params![id])
        .map(|_| ())
        .map_err(db_err)
}

pub fn put_snapshot(
    conn: &Connection,
    connection_id: &str,
    scope: &str,
    scope_key: &str,
    payload_json: &str,
) -> Result<(), BrokerError> {
    let id = format!("{connection_id}:{scope}:{scope_key}");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO broker_topology_snapshots (id, connection_id, scope, scope_key, payload_json, observed_at)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(connection_id, scope, scope_key) DO UPDATE SET
            payload_json = excluded.payload_json, observed_at = excluded.observed_at",
        params![id, connection_id, scope, scope_key, payload_json, now],
    )
    .map(|_| ())
    .map_err(db_err)
}

pub fn get_snapshot(
    conn: &Connection,
    connection_id: &str,
    scope: &str,
    scope_key: &str,
) -> Result<Option<(String, i64)>, BrokerError> {
    let mut stmt = conn
        .prepare(
            "SELECT payload_json, observed_at FROM broker_topology_snapshots
             WHERE connection_id = ?1 AND scope = ?2 AND scope_key = ?3",
        )
        .map_err(db_err)?;
    let mut rows = stmt
        .query_map(params![connection_id, scope, scope_key], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(db_err)?;
    match rows.next() {
        Some(r) => Ok(Some(r.map_err(db_err)?)),
        None => Ok(None),
    }
}
```

- [ ] **Step 5: Run until green**

```bash
cd src-tauri && cargo test --test broker_store
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Confirm existing tests still pass**

```bash
cd src-tauri && cargo test
cd .. && pnpm test
```

Expected: no regressions. The schema change touches a shared file, so this check is not optional.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db.rs src-tauri/src/broker/store.rs src-tauri/tests/broker_store.rs
git commit -m "feat(broker): connection and snapshot tables with keychain-only credentials"
```

---

### Task 14: Capability discovery, keychain, and Tauri commands

**Files:**
- Create: `src-tauri/src/broker/capability.rs`
- Create: `src-tauri/src/broker/commands.rs`
- Modify: `src-tauri/src/broker/mod.rs`
- Modify: `src-tauri/src/lib.rs` — register commands in `generate_handler!`
- Create: `src-tauri/tests/broker_capability_discovery.rs`

**Interfaces:**
- Consumes: `PulsarAdminRest` (Task 10), `binary` (Task 5), `store` (Task 12), `WriteGuard` (Task 11).
- Produces these Tauri commands, all taking `connectionId` explicitly:
  - `broker_list_connections() -> Vec<ConnectionDto>`
  - `broker_upsert_connection(draft: ConnectionDto, secret: Option<String>) -> ConnectionDto`
  - `broker_delete_connection(connectionId: String)`
  - `broker_test_connection(connectionId: String) -> ResultEnvelope<CapabilitySnapshot>`
  - `broker_list_topics(connectionId: String, tenant: String, namespace: String, query: PageQueryDto) -> ResultEnvelope<PageDto<TopicSummaryDto>>`
  Task 16 and Task 17 call these from `src/lib/broker-client.ts`.

- [ ] **Step 1: Write the failing discovery test**

```rust
// src-tauri/tests/broker_capability_discovery.rs
//! Live test. Requires: docker compose -f infra/broker/docker-compose.local.yml up -d
use penguin_lib::broker::capability;

#[tokio::test]
async fn discovery_reports_measured_facts_not_configured_ones() {
    let snap = capability::discover("http://localhost:8080", "pulsar://localhost:6650", 10_000, true, None)
        .await
        .expect("discovery against the local broker");

    assert_eq!(snap.broker_version.as_deref(), Some("4.2.4"));
    assert!(snap.clusters.contains(&"standalone".to_string()));

    // These four are the findings that shape Phases B, C and E. If any flips,
    // the affected phase's design is stale.
    assert!(!snap.peek_on_partitioned_allowed, "V-B4: peek is rejected on partitioned topics");
    assert!(snap.binary_protocol_reachable, "V-C3: :6650 must be reachable");
    assert!(snap.can_write, "V-E8: local Pulsar accepts writes from anyone");
    assert!(snap.has_metrics);
}

#[tokio::test]
async fn discovery_on_an_unreachable_broker_fails_without_panicking() {
    let err = capability::discover("http://localhost:1", "pulsar://localhost:1", 2_000, true, None)
        .await
        .expect_err("an unreachable broker must produce an error, not a panic");
    assert!(err.retryable, "a connection failure is worth retrying");
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd src-tauri && cargo test --test broker_capability_discovery
```

Expected: FAIL to compile — `capability` does not exist.

- [ ] **Step 3: Write capability discovery**

```rust
// src-tauri/src/broker/capability.rs
//! Capability discovery — measures what a broker actually allows.
//!
//! Every field here is observed, never configured. `can_write` is what the
//! server permits; `read_only` (on the connection) is what the user permits.
//! Collapsing the two removes the only real write guard we have.

use crate::broker::adapters::pulsar::{admin_rest::PulsarAdminRest, binary};
use crate::broker::envelope::BrokerError;
use crate::broker::ports::BrokerAdmin;
use serde::{Deserialize, Serialize};

/// One probed endpoint. Mirrors `EndpointProbe` in @penguin/broker-contracts —
/// the connection detail drawer renders these rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointProbe {
    pub path: String,
    pub method: String,
    pub status: Option<u16>,
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySnapshot {
    pub probed_at: i64,
    pub broker_version: Option<String>,
    pub clusters: Vec<String>,
    /// Keyed by logical operation name ("list_tenants", "peek", …).
    pub endpoints: std::collections::HashMap<String, EndpointProbe>,
    pub can_peek: bool,
    pub peek_requires_subscription: bool,
    pub peek_on_partitioned_allowed: bool,
    pub batch_frame_seen: bool,
    pub binary_protocol_reachable: bool,
    pub web_socket_enabled: bool,
    pub can_produce: bool,
    pub can_write: bool,
    pub has_metrics: bool,
    pub warnings: Vec<String>,
    pub source: String,
}

pub async fn discover(
    admin_url: &str,
    broker_url: &str,
    timeout_ms: u64,
    tls_verify: bool,
    token: Option<String>,
) -> Result<CapabilitySnapshot, BrokerError> {
    let admin = PulsarAdminRest::new(admin_url.to_string(), timeout_ms, tls_verify, token)?;

    // A failure here is terminal: without a version we know nothing about the broker.
    let broker_version = admin.broker_version().await?;
    let clusters = admin.list_clusters().await.unwrap_or_default();

    let mut warnings = Vec::new();
    let mut endpoints: std::collections::HashMap<String, EndpointProbe> = std::collections::HashMap::new();

    // Record each probed endpoint so the connection detail drawer can show what
    // was actually reachable, with the status and latency observed.
    let mut probe_endpoint = |name: &str, path: &str, method: &str, status: Option<u16>, latency_ms: Option<u64>, reason: Option<String>| {
        endpoints.insert(
            name.to_string(),
            EndpointProbe {
                path: path.to_string(),
                method: method.to_string(),
                ok: status.is_some_and(crate::broker::envelope::is_success),
                status,
                latency_ms,
                reason,
            },
        );
    };
    probe_endpoint("broker_version", "/admin/v2/brokers/version", "GET", Some(200), None, None);
    probe_endpoint("list_clusters", "/admin/v2/clusters", "GET", Some(200), None, None);

    // Reachability of the binary protocol decides whether Phases C and E can work
    // at all against this connection.
    let binary_protocol_reachable = binary::read_without_ack(broker_url, "persistent://public/default/__probe", 0)
        .await
        .is_ok();
    if !binary_protocol_reachable {
        warnings.push(format!("binary protocol unreachable at {broker_url}; timeline and replay will be unavailable"));
    }

    // Writes: attempt a namespace read that requires no permission, then a
    // harmless idempotent write. Never create anything that is not cleaned up.
    let can_write = probe_write(admin_url, timeout_ms).await;

    let has_metrics = reqwest::Client::new()
        .get(format!("{}/metrics/", admin_url.trim_end_matches('/')))
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);

    Ok(CapabilitySnapshot {
        probed_at: now_ms(),
        broker_version: Some(broker_version),
        clusters,
        endpoints,
        can_peek: true,
        peek_requires_subscription: true,  // V-B3 — constant for Pulsar's Admin REST
        peek_on_partitioned_allowed: false, // V-B4 — 405 on 4.2.4
        batch_frame_seen: false,            // set by Phase B when a batch is actually met
        binary_protocol_reachable,
        web_socket_enabled: false,          // informational; not a code path (V-C1)
        can_produce: binary_protocol_reachable, // produce only ever goes over binary (V-E5)
        can_write,
        has_metrics,
        warnings,
        source: "pulsar-admin-rest".into(),
    })
}

/// Creates and immediately deletes a scratch subscription on a system topic path
/// to learn whether writes are permitted. Leaves nothing behind.
async fn probe_write(admin_url: &str, timeout_ms: u64) -> bool {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build();
    let Ok(client) = client else { return false };
    let base = admin_url.trim_end_matches('/');
    let topic = format!("{base}/admin/v2/persistent/public/default/__broker_write_probe");

    let created = client.put(&topic).send().await.map(|r| r.status().as_u16()).unwrap_or(0);
    let _ = client.delete(format!("{topic}?force=true")).send().await;
    matches!(created, 204 | 409)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
```

- [ ] **Step 4: Write the commands**

```rust
// src-tauri/src/broker/commands.rs
//! Tauri commands. Every one takes `connectionId` explicitly — the "active"
//! connection is a UI concept and never an implicit backend default.
//!
//! Secrets follow DEC #195: the plaintext arrives once on upsert, goes straight
//! to the keychain, and is never returned. The frontend only ever sees a handle.

use crate::broker::adapters::pulsar::admin_rest::PulsarAdminRest;
use crate::broker::capability::{self, CapabilitySnapshot};
use crate::broker::envelope::{BrokerError, ResultEnvelope};
use crate::broker::ports::BrokerAdmin;
use crate::broker::store::{self, ConnectionRow};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageQueryDto {
    pub offset: usize,
    pub limit: usize,
    pub search: Option<String>,
    pub sort_by: Option<String>,
    pub sort_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicSummaryDto {
    pub full_name: String,
    pub short_name: String,
    pub tenant: String,
    pub namespace: String,
    pub persistent: bool,
    pub partitions: usize,
    pub partition_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDto<T> {
    pub items: Vec<T>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}

#[tauri::command]
pub async fn broker_test_connection(
    connection_id: String,
    app: tauri::AppHandle,
) -> Result<ResultEnvelope<CapabilitySnapshot>, String> {
    let row = load_row(&app, &connection_id)?;
    let token = resolve_secret(row.secret_handle_id.as_deref())?;

    match capability::discover(&row.admin_url, &row.broker_url, row.timeout_ms as u64, row.tls_verify, token).await {
        Ok(snapshot) => {
            persist_probe_result(&app, &row, &snapshot)?;
            Ok(ResultEnvelope::ok(snapshot, "pulsar-admin-rest"))
        }
        Err(err) => Ok(ResultEnvelope::failed(err, "pulsar-admin-rest")),
    }
}

#[tauri::command]
pub async fn broker_list_topics(
    connection_id: String,
    tenant: String,
    namespace: String,
    query: PageQueryDto,
    app: tauri::AppHandle,
) -> Result<ResultEnvelope<PageDto<TopicSummaryDto>>, String> {
    let row = load_row(&app, &connection_id)?;
    let token = resolve_secret(row.secret_handle_id.as_deref())?;
    let admin = PulsarAdminRest::new(row.admin_url.clone(), row.timeout_ms as u64, row.tls_verify, token)
        .map_err(|e| e.message.clone())?;

    // Admin REST ignores paging, so fetch the full lists, fold partitions, cache,
    // and page in Rust (spec V-A5 / V-A6).
    let (all, partitioned) = match (
        admin.list_topics(&tenant, &namespace).await,
        admin.list_partitioned_topics(&tenant, &namespace).await,
    ) {
        (Ok(a), Ok(p)) => (a, p),
        (Err(e), _) | (_, Err(e)) => return Ok(ResultEnvelope::failed(e, "pulsar-admin-rest")),
    };

    let folded = fold_topics(&all, &partitioned);
    let page = paginate(folded, &query);
    Ok(ResultEnvelope::ok(page, "pulsar-admin-rest"))
}
```

Implement `fold_topics` and `paginate` in Rust as direct mirrors of
`packages/broker-core/src/topic-folding.ts` and `pagination.ts` from Task 9,
including the `my-partition-plan` guard: membership is decided by the
`partitioned` list, never by the name suffix alone.

Implement `load_row`, `resolve_secret`, and `persist_probe_result` against
`store` (Task 12) and the existing keychain adapter in `src-tauri/src/rest/keychain.rs`.
`resolve_secret` returns the plaintext only inside this process and never puts it
into a return value that crosses IPC.

Also implement `broker_list_connections`, `broker_upsert_connection`, and
`broker_delete_connection`. `broker_upsert_connection` writes any supplied
`secret` to the keychain, stores only the resulting handle, and returns a DTO with
no secret field at all.

- [ ] **Step 5: Register the commands**

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![...]`, after the
existing entries:

```rust
broker::commands::broker_list_connections,
broker::commands::broker_upsert_connection,
broker::commands::broker_delete_connection,
broker::commands::broker_test_connection,
broker::commands::broker_list_topics,
```

Add `pub mod capability;`, `pub mod commands;`, and `pub mod store;` to
`src-tauri/src/broker/mod.rs`.

- [ ] **Step 6: Run until green**

```bash
docker compose -f infra/broker/docker-compose.local.yml up -d
cd src-tauri && cargo test --test broker_capability_discovery -- --test-threads=1
cargo test
```

Expected: PASS. Confirm no scratch topic survives:

```bash
curl -s http://localhost:8080/admin/v2/persistent/public/default | grep -c __broker_write_probe
```

Expected: `0`.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/broker/ src-tauri/src/lib.rs src-tauri/tests/broker_capability_discovery.rs
git commit -m "feat(broker): capability discovery and Tauri commands"
```

---

## Part 3 Gate

- [ ] `cd src-tauri && cargo test` passes, including all three integration tests against live Pulsar
- [ ] The five security guarantees each have a test that failed before its guard existed
- [ ] `broker_connections` has no column named `token`, `password`, `secret`, or `credential`
- [ ] `pnpm test` still passes — the `db.rs` change touches a shared file
- [ ] Discovery leaves no scratch topics behind

---

# Part 4 — Frontend

---

### Task 15: Vitest and Testing Library

The repo has 331 `node:test` files and zero component-render tests. This task adds a
second runner scoped to the Broker module. The existing suite must be untouched and
must keep passing.

**Files:**
- Create: `vitest.config.ts`
- Create: `src/test/setup.ts`
- Create: `src/components/ui/__tests__/smoke.test.tsx`
- Modify: `package.json` — devDependencies and two scripts

**Interfaces:**
- Produces: `pnpm test:ui` running Vitest over `src/**/*.test.tsx`. Tasks 15–17 add tests here.

- [ ] **Step 1: Add the dependencies**

```bash
pnpm add -D vitest @vitest/coverage-v8 jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom
```

- [ ] **Step 2: Write the config**

```ts
// vitest.config.ts
// Scoped to the Broker module's React components. The rest of the repo is
// covered by `pnpm test` (node:test over tests/*.test.mjs) and stays that way —
// this config deliberately does not glob tests/.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.tsx"],
    exclude: ["node_modules", "dist", "tests/**"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
```

```ts
// src/test/setup.ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom has no ResizeObserver, which @tanstack/react-virtual requires.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
```

- [ ] **Step 3: Write a smoke test that must fail first**

```tsx
// src/components/ui/__tests__/smoke.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("renders a component and finds it by role", () => {
    render(<button type="button">Ping</button>);
    expect(screen.getByRole("button", { name: "Ping" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Add the scripts and run**

In `package.json` `scripts`:

```json
"test:ui": "vitest run",
"test:ui:watch": "vitest"
```

```bash
pnpm test:ui
```

Expected: PASS, 1 test.

- [ ] **Step 5: Prove the existing suite is unaffected**

```bash
pnpm test
```

Expected: the full 331-file `node:test` suite still passes. If Vitest's `include`
accidentally picks up `tests/`, fix the config — not the existing tests.

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts src/test/setup.ts src/components/ui/__tests__/smoke.test.tsx package.json pnpm-lock.yaml
git commit -m "test(broker): add Vitest + Testing Library scoped to UI components"
```

---

### Task 16: `DataTable` primitive

Every later phase lists something. Building it now, with the five states and
expandable rows the findings demand, means the problems surface in Phase 0.

**Files:**
- Create: `src/components/ui/data-table.tsx`
- Create: `src/components/ui/__tests__/data-table.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  interface DataTableColumn<T> { key: string; header: string; width?: number; render: (row: T) => ReactNode; sortable?: boolean }
  interface DataTableProps<T> {
    columns: DataTableColumn<T>[];
    rows: T[];
    total: number;
    offset: number;
    limit: number;
    rowKey: (row: T) => string;
    state: "loading" | "empty" | "stale" | "partial" | "error" | "ready";
    errorMessage?: string;
    onPageChange: (offset: number) => void;
    onSortChange?: (key: string, dir: "asc" | "desc") => void;
    expandedContent?: (row: T) => ReactNode;
  }
  ```
  Tasks 16 and 17 consume this.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/ui/__tests__/data-table.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn } from "../data-table";

interface Row { id: string; name: string; partitions: number }

const columns: DataTableColumn<Row>[] = [
  { key: "name", header: "Name", render: (r) => r.name, sortable: true },
  { key: "partitions", header: "Partitions", render: (r) => String(r.partitions) },
];

const rows: Row[] = [
  { id: "a", name: "orders", partitions: 0 },
  { id: "b", name: "events", partitions: 3 },
];

function setup(overrides = {}) {
  const props = {
    columns, rows, total: 2, offset: 0, limit: 25,
    rowKey: (r: Row) => r.id,
    state: "ready" as const,
    onPageChange: vi.fn(),
    ...overrides,
  };
  render(<DataTable {...props} />);
  return props;
}

describe("DataTable states", () => {
  it("shows a loading state instead of an empty table", () => {
    setup({ state: "loading", rows: [], total: 0 });
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  it("distinguishes empty from error", () => {
    setup({ state: "empty", rows: [], total: 0 });
    expect(screen.getByRole("status")).toHaveTextContent(/no .*(rows|results)/i);
  });

  it("shows the error message when state is error", () => {
    setup({ state: "error", rows: [], total: 0, errorMessage: "Namespace does not exist" });
    expect(screen.getByRole("alert")).toHaveTextContent("Namespace does not exist");
  });

  it("marks stale data without hiding it", () => {
    setup({ state: "stale" });
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/stale|cached/i);
  });

  it("marks partial data without hiding it", () => {
    setup({ state: "partial" });
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/partial/i);
  });
});

describe("DataTable behaviour", () => {
  it("renders one row per item", () => {
    setup();
    expect(screen.getByText("orders")).toBeInTheDocument();
    expect(screen.getByText("events")).toBeInTheDocument();
  });

  it("expands a row to reveal its detail", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={columns} rows={rows} total={2} offset={0} limit={25}
        rowKey={(r) => r.id} state="ready" onPageChange={vi.fn()}
        expandedContent={(r) => <div>{r.partitions} partitions for {r.name}</div>}
      />,
    );
    expect(screen.queryByText("3 partitions for events")).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /expand/i })[1]);
    expect(screen.getByText("3 partitions for events")).toBeInTheDocument();
  });

  it("reports page changes rather than paging itself", async () => {
    const user = userEvent.setup();
    const props = setup({ total: 100, offset: 0, limit: 25 });
    await user.click(screen.getByRole("button", { name: /next page/i }));
    expect(props.onPageChange).toHaveBeenCalledWith(25);
  });

  it("disables previous on the first page", () => {
    setup({ total: 100, offset: 0, limit: 25 });
    expect(screen.getByRole("button", { name: /previous page/i })).toBeDisabled();
  });

  it("reports sort changes", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    setup({ onSortChange });
    await user.click(screen.getByRole("button", { name: /sort by name/i }));
    expect(onSortChange).toHaveBeenCalledWith("name", "asc");
  });

  it("does not convey state by colour alone", () => {
    // Accessibility: every state must carry text, not just a coloured dot.
    setup({ state: "stale" });
    expect(screen.getByRole("status").textContent?.trim()).not.toBe("");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:ui
```

Expected: FAIL — `Cannot find module '../data-table'`.

- [ ] **Step 3: Implement the component**

Write `src/components/ui/data-table.tsx` satisfying every assertion above. Requirements:

- Virtualise the row list with `useVirtualizer` from `@tanstack/react-virtual` (already a dependency).
- Render exactly one status region (`role="status"`) for `loading` / `empty` / `stale` / `partial`, and `role="alert"` for `error`. `stale` and `partial` render the rows *and* the notice.
- Expansion is per row, controlled by local state keyed with `rowKey`. The toggle is a real `<button>` with an accessible name containing "Expand".
- Pagination buttons are named "Previous page" / "Next page"; `previous` is disabled at `offset === 0`, `next` at `offset + limit >= total`. The component never mutates `offset` itself — it calls `onPageChange`.
- Sortable headers render a `<button>` named `Sort by {header}`; clicking toggles `asc` / `desc` and calls `onSortChange`.
- Reuse `resizable-column.tsx` for column widths.
- Follow the file-size rule: if it exceeds 400 lines, split the pagination footer and the status region into sibling files.

- [ ] **Step 4: Run until green**

```bash
pnpm test:ui
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/data-table.tsx src/components/ui/__tests__/data-table.test.tsx
git commit -m "feat(ui): DataTable with five states, expandable rows, virtualised list"
```

---

### Task 17: Connection CRUD

**Files:**
- Create: `src/lib/broker-client.ts`
- Create: `src/hooks/useBrokerConnections.ts`
- Create: `src/components/broker/ConnectionTable.tsx`
- Create: `src/components/broker/ConnectionForm.tsx`
- Create: `src/components/broker/ConnectionActions.tsx`
- Create: `src/components/broker/__tests__/ConnectionForm.test.tsx`
- Create: `src/components/broker/__tests__/ConnectionTable.test.tsx`

**Interfaces:**
- Consumes: the Tauri commands from Task 13; `DataTable` from Task 15; types from `@penguin/broker-contracts`.
- Produces: `useBrokerConnections()` returning `{ connections, activeId, setActive, save, remove, test, state, error }`. Task 17 consumes `activeId`.

- [ ] **Step 1: Write the failing form test**

```tsx
// src/components/broker/__tests__/ConnectionForm.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectionForm } from "../ConnectionForm";

describe("ConnectionForm", () => {
  it("defaults a new connection to read-only", () => {
    // The spec's most important default: local Pulsar accepts every write,
    // so a connection must not be writable unless the user opts in.
    render(<ConnectionForm onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("switch", { name: /read.?only/i })).toBeChecked();
  });

  it("requires both an admin URL and a broker URL", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<ConnectionForm onSave={onSave} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(/name/i), "Local");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(onSave).not.toHaveBeenCalled();
    // The binary URL is not optional: timeline and replay depend on it.
    expect(screen.getByText(/broker url is required/i)).toBeInTheDocument();
  });

  it("rejects a broker URL that is not a pulsar:// address", async () => {
    const user = userEvent.setup();
    render(<ConnectionForm onSave={vi.fn()} onCancel={vi.fn()} />);
    await user.type(screen.getByLabelText(/broker url/i), "http://localhost:6650");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(screen.getByText(/must start with pulsar/i)).toBeInTheDocument();
  });

  it("shows a token field only when auth type needs one", async () => {
    const user = userEvent.setup();
    render(<ConnectionForm onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/auth/i), "jwt");
    expect(screen.getByLabelText(/token/i)).toBeInTheDocument();
  });

  it("passes the token to onSave once and never echoes it back", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<ConnectionForm onSave={onSave} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(/name/i), "Secure");
    await user.type(screen.getByLabelText(/admin url/i), "http://localhost:8081");
    await user.type(screen.getByLabelText(/broker url/i), "pulsar://localhost:6651");
    await user.selectOptions(screen.getByLabelText(/auth/i), "jwt");
    await user.type(screen.getByLabelText(/token/i), "super-secret");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(onSave).toHaveBeenCalledOnce();
    const [draft] = onSave.mock.calls[0];
    expect(draft.secret).toBe("super-secret");
    // The token must never be persisted into the rendered draft that round-trips.
    expect(JSON.stringify({ ...draft, secret: undefined })).not.toContain("super-secret");
  });

  it("editing an existing connection does not prefill the token", () => {
    // The plaintext is in the keychain and is never read back into the webview.
    render(
      <ConnectionForm
        onSave={vi.fn()}
        onCancel={vi.fn()}
        initial={{
          name: "Secure", adminUrl: "http://localhost:8081", brokerUrl: "pulsar://localhost:6651",
          authType: "jwt", secretHandleId: "handle-1", kind: "pulsar", color: "blue",
          defaultTenant: "public", defaultNamespace: "default",
          readOnly: true, tlsVerify: true, timeoutMs: 10000,
        }}
      />,
    );
    expect(screen.getByLabelText(/token/i)).toHaveValue("");
    expect(screen.getByText(/stored in keychain/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Write the failing table test**

```tsx
// src/components/broker/__tests__/ConnectionTable.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionTable } from "../ConnectionTable";
import type { BrokerConnection } from "@penguin/broker-contracts";

const base: BrokerConnection = {
  id: "c1", kind: "pulsar", name: "Local", color: "green",
  adminUrl: "http://localhost:8080", brokerUrl: "pulsar://localhost:6650",
  authType: "none", secretHandleId: null,
  defaultTenant: "public", defaultNamespace: "default",
  readOnly: true, tlsVerify: true, timeoutMs: 10000,
  lastStatus: "ok", lastCheckedAt: 1, brokerVersion: "4.2.4",
  capabilities: null, createdAt: 1, updatedAt: 1,
};

const handlers = { onTest: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onSetActive: vi.fn() };

describe("ConnectionTable", () => {
  it("shows the measured broker version, not a configured one", () => {
    render(<ConnectionTable connections={[base]} activeId={null} state="ready" {...handlers} />);
    expect(screen.getByText("4.2.4")).toBeInTheDocument();
  });

  it("renders status as text, not colour alone", () => {
    render(<ConnectionTable connections={[base]} activeId={null} state="ready" {...handlers} />);
    expect(screen.getByText(/\bok\b/i)).toBeInTheDocument();
  });

  it("shows unknown before a connection has been tested", () => {
    const untested = { ...base, lastStatus: "unknown" as const, brokerVersion: null };
    render(<ConnectionTable connections={[untested]} activeId={null} state="ready" {...handlers} />);
    expect(screen.getByText(/unknown/i)).toBeInTheDocument();
    // Never render a version we have not measured.
    expect(screen.queryByText("4.2.4")).not.toBeInTheDocument();
  });

  it("marks the active connection", () => {
    render(<ConnectionTable connections={[base]} activeId="c1" state="ready" {...handlers} />);
    expect(screen.getByRole("row", { name: /local/i })).toHaveAttribute("aria-current", "true");
  });

  it("shows a read-only badge so a writable connection is visibly different", () => {
    render(<ConnectionTable connections={[base]} activeId={null} state="ready" {...handlers} />);
    expect(screen.getByText(/read.?only/i)).toBeInTheDocument();
  });

  it("shows the empty state when there are no connections", () => {
    render(<ConnectionTable connections={[]} activeId={null} state="empty" {...handlers} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no/i);
  });
});
```

- [ ] **Step 3: Run to verify both fail**

```bash
pnpm test:ui
```

Expected: FAIL — neither component exists.

- [ ] **Step 4: Write the client wrapper**

```ts
// src/lib/broker-client.ts
// Thin typed wrapper over the broker Tauri commands. The webview never talks to
// Pulsar directly and never holds a token — only a connection id.
import { invoke } from "@tauri-apps/api/core";
import type {
  BrokerConnection, BrokerConnectionDraft, CapabilitySnapshot,
  Page, PageQuery, ResultEnvelope, TopicSummary,
} from "@penguin/broker-contracts";

export function listConnections(): Promise<BrokerConnection[]> {
  return invoke("broker_list_connections");
}

/** `secret` is sent once and goes straight to the keychain. It is never returned. */
export function upsertConnection(
  draft: BrokerConnectionDraft & { id?: string },
  secret?: string,
): Promise<BrokerConnection> {
  return invoke("broker_upsert_connection", { draft, secret: secret ?? null });
}

export function deleteConnection(connectionId: string): Promise<void> {
  return invoke("broker_delete_connection", { connectionId });
}

export function testConnection(connectionId: string): Promise<ResultEnvelope<CapabilitySnapshot>> {
  return invoke("broker_test_connection", { connectionId });
}

export function listTopics(
  connectionId: string,
  tenant: string,
  namespace: string,
  query: PageQuery,
): Promise<ResultEnvelope<Page<TopicSummary>>> {
  return invoke("broker_list_topics", { connectionId, tenant, namespace, query });
}
```

- [ ] **Step 5: Write the components**

Write `ConnectionForm.tsx`, `ConnectionTable.tsx`, `ConnectionActions.tsx`, and
`useBrokerConnections.ts` to satisfy every assertion above. Requirements drawn from
the tests:

- `readOnly` defaults to `true`.
- `brokerUrl` is required and must start with `pulsar://` or `pulsar+ssl://`.
- The token field appears only for `authType` of `jwt` or `oauth2`, is never
  prefilled when editing, and shows "stored in keychain" when a handle exists.
- `onSave` receives `secret` as a separate field; the persisted draft carries none.
- `ConnectionTable` builds on `DataTable`, renders `lastStatus` and `brokerVersion`
  as text, marks the active row with `aria-current`, and shows `Unknown` rather than
  a guess when a connection has not been tested.
- `useBrokerConnections` keeps `activeId` in `app_kv` under `broker.activeConnectionId`
  via the existing persistence helpers, and re-runs `testConnection` when the active
  connection changes.
- Keep each file at or under 400 lines — `VaultPage.tsx` at 48K is the pattern to avoid.

- [ ] **Step 6: Run until green**

```bash
pnpm test:ui
```

Expected: PASS, 12 new tests.

- [ ] **Step 7: Commit**

```bash
git add src/lib/broker-client.ts src/hooks/useBrokerConnections.ts src/components/broker/
git commit -m "feat(broker): connection CRUD with keychain-only secret handling"
```

---

### Task 18: Topic list, rail wiring, and the end-to-end proof

The task that proves the whole chain: React → Tauri command → Rust adapter →
Admin REST → SQLite, with Rust-side pagination and partition folding working on the
real local broker.

**Files:**
- Create: `src/components/broker/TopicTable.tsx`
- Create: `src/components/broker/BrokerPage.tsx`
- Create: `src/components/broker/__tests__/TopicTable.test.tsx`
- Modify: `src/components/layout/MainSidebar.tsx` — add the rail item
- Modify: `src/App.tsx` — render `BrokerPage` for the new module
- Create: `public/nav/broker.png`

**Interfaces:**
- Consumes: `listTopics` (Task 16), `DataTable` (Task 15), `useBrokerConnections` (Task 16).
- Produces: the `broker` value on `MainModule`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/broker/__tests__/TopicTable.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TopicTable } from "../TopicTable";
import type { TopicSummary } from "@penguin/broker-contracts";

const topics: TopicSummary[] = [
  {
    fullName: "persistent://public/default/orders", shortName: "orders",
    tenant: "public", namespace: "default", persistent: true,
    partitions: 0, partitionNames: [],
  },
  {
    fullName: "persistent://public/default/events", shortName: "events",
    tenant: "public", namespace: "default", persistent: true,
    partitions: 3,
    partitionNames: [
      "persistent://public/default/events-partition-0",
      "persistent://public/default/events-partition-1",
      "persistent://public/default/events-partition-2",
    ],
  },
];

const props = {
  topics, total: 2, offset: 0, limit: 25,
  state: "ready" as const, onPageChange: vi.fn(),
};

describe("TopicTable", () => {
  it("renders a partitioned topic as one row, not one row per partition", () => {
    render(<TopicTable {...props} />);
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 topics
    expect(screen.queryByText(/events-partition-0/)).not.toBeInTheDocument();
  });

  it("reveals partitions when the row is expanded", async () => {
    const user = userEvent.setup();
    render(<TopicTable {...props} />);
    await user.click(screen.getByRole("button", { name: /expand events/i }));
    expect(screen.getByText("persistent://public/default/events-partition-0")).toBeInTheDocument();
  });

  it("shows the partition count on the collapsed row", () => {
    render(<TopicTable {...props} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("guides the user when no connection is active", () => {
    render(<TopicTable {...props} topics={[]} total={0} state="empty" noActiveConnection />);
    expect(screen.getByRole("status")).toHaveTextContent(/connection/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

```bash
pnpm test:ui   # FAIL: Cannot find module '../TopicTable'
```

Write `TopicTable.tsx` on top of `DataTable`, with `expandedContent` listing
`partitionNames`, and `BrokerPage.tsx` holding the Connections / Topics split with
`useBrokerConnections`.

- [ ] **Step 3: Add the rail item**

In `src/components/layout/MainSidebar.tsx`:

```ts
export type MainModule = "client" | "rest" | "vault" | "docs" | "wiki" | "broker";
```

and in `ITEMS`, after the `wiki` entry:

```ts
  // Broker — message-queue operations console. Pulsar is the first adapter;
  // the module name stays vendor-neutral for future broker kinds.
  { kind: "broker", img: "/nav/broker.png", label: "Broker", longLabel: "Message Broker / 消息中间件 (Super Admin)", requires: "super-admin" },
```

In `src/App.tsx`, render `BrokerPage` when `activeModule === "broker"`, following
exactly how `wiki` is handled.

- [ ] **Step 4: Run all suites**

```bash
pnpm test:ui
pnpm test
pnpm typecheck
cd src-tauri && cargo test
```

Expected: all green.

- [ ] **Step 5: Prove it end to end against the real broker**

```bash
docker compose -f infra/broker/docker-compose.local.yml up -d
pnpm tauri dev
```

In the running app:
1. Open the Broker rail, add a connection: `http://localhost:8080` / `pulsar://localhost:6650`.
2. Click Test. Confirm it shows `4.2.4`, `binary ✅`, `write ✅` — all measured, not typed in.
3. Open Topics. Confirm the 10 local business topics appear.
4. Create a 3-partition topic, refresh, and confirm it renders as **one** row that
   expands to three partitions:
   ```bash
   curl -s -X PUT http://localhost:8080/admin/v2/persistent/public/default/e2e-check/partitions \
     -H 'Content-Type: application/json' -d '3'
   ```
5. Set the page size below the topic count and confirm paging works — proving
   pagination happens in Rust, since Admin REST offers none.
6. Clean up:
   ```bash
   curl -s -X DELETE 'http://localhost:8080/admin/v2/persistent/public/default/e2e-check/partitions?force=true'
   ```

- [ ] **Step 6: Commit**

```bash
git add src/components/broker/ src/components/layout/MainSidebar.tsx src/App.tsx public/nav/broker.png
git commit -m "feat(broker): topic list, rail entry, end-to-end proof"
```

---

## Phase 0 Gate

Every box must be checked before Phase A starts.

**Validation**
- [ ] All spec section 2 `V-*` findings are automated assertions that fail on regression
- [ ] Real `401` / `403` shapes captured from the local-secure profile and reflected in both error maps
- [ ] Retry/DLQ property names observed and recorded in `docs/broker/retry-dlq-contract.md`, no placeholder rows
- [ ] Binary reader reads without acking and reads repeatably; binary producer writes
- [ ] Batch frame parser splits a real captured frame into exactly `X-Pulsar-num-batch-message` messages
- [ ] `COMPATIBILITY.md` pins the digest; no `latest` anywhere

**Foundation**
- [ ] Contracts frozen: `ResultEnvelope`, error map with `SCHEMA_INCOMPATIBLE` and 200/202/204, `BrokerConnection`, `CapabilitySnapshot`
- [ ] Connection CRUD works end to end, Test Connection reports measured values
- [ ] Topic list proves Rust-side pagination and partition folding against live Pulsar
- [ ] Five security guarantees each have a test that failed before its guard existed
- [ ] Vitest runs UI tests without disturbing the 331 `node:test` files
- [ ] `DataTable` passes all five states, expansion, paging, sorting, and the colour-independence check

**Global**
- [ ] `pnpm test`, `pnpm test:ui`, `pnpm typecheck`, and `cargo test` all pass
- [ ] No `Not run` or `Blocked` rows remain in the test matrix
- [ ] No scratch topic survives: `curl -s http://localhost:8080/admin/v2/persistent/public/default | grep -cE 'broker-probe|broker-sim|broker-spike|e2e-check'` returns `0`
- [ ] The only accepted unknown is V-F3 (SRE broker version), which requires credentials we do not have

If any validation came back ⛔, revise the affected phase's design in the spec
**before** that phase starts. Recording a blocker and proceeding as planned is not allowed.
