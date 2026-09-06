import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  EmbeddingLifecycle,
  KnowledgeStore,
  createEmbeddingSpace,
  embeddingSpaceIdentity,
  listSemanticStatuses,
  persistSemanticChunks,
} from "../packages/knowledge-core/dist/index.js";

function openFixture(chunkCount = 4) {
  const directory = mkdtempSync(join(tmpdir(), "penguin-semantic-worker-"));
  const dbPath = join(directory, "knowledge.db");
  const ledgerPath = join(directory, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const chunks = Array.from({ length: chunkCount }, (_, index) => persistSemanticChunks(store, {
    text: `semantic worker fixture ${index}`,
    repoId: "repo",
    snapshotId: "snapshot",
    canonicalFilePath: `fixture-${index}.ts`,
    chunkerVersion: "v1",
  })[0]);
  const space = createEmbeddingSpace(store, embeddingSpaceIdentity({
    providerId: "fixture",
    modelId: "lease-tests",
    weightsDigest: "a".repeat(64),
    tokenizerDigest: "b".repeat(64),
    dimensions: 2,
    pooling: "mean",
    normalization: "none",
    chunkerVersion: "v1",
  }));
  const lifecycle = new EmbeddingLifecycle(store);
  const generation = lifecycle.createGeneration({
    spaceId: space.id,
    snapshotId: "snapshot",
    scopeKey: "repo:repo",
    expectedChunks: chunks.length,
  });
  for (const chunk of chunks) lifecycle.createJob({ generationId: generation.id, chunkId: chunk.id });
  return { directory, dbPath, ledgerPath, store, lifecycle, generation };
}

test("two workers atomically claim disjoint embedding jobs", () => {
  const fixture = openFixture();
  const secondStore = KnowledgeStore.open({ dbPath: fixture.dbPath, ledgerPath: fixture.ledgerPath });
  const secondLifecycle = new EmbeddingLifecycle(secondStore);
  const now = "2026-08-31T08:00:00.000Z";
  const leaseExpiresAt = "2026-08-31T08:02:00.000Z";

  const first = fixture.lifecycle.claimJobs({
    ownerId: "worker-a",
    generationId: fixture.generation.id,
    limit: 3,
    now,
    leaseExpiresAt,
  });
  const second = secondLifecycle.claimJobs({
    ownerId: "worker-b",
    generationId: fixture.generation.id,
    limit: 3,
    now,
    leaseExpiresAt,
  });

  assert.equal(first.length, 3);
  assert.equal(second.length, 1);
  assert.deepEqual(new Set([...first, ...second].map((job) => job.id)).size, 4);
  assert.equal(first.every((job) => job.leaseOwner === "worker-a" && job.attempts === 1), true);
  assert.equal(second.every((job) => job.leaseOwner === "worker-b" && job.attempts === 1), true);
  secondStore.close();
  fixture.store.close();
});

test("two independent processes racing at one barrier claim disjoint jobs", async () => {
  const fixture = openFixture();
  const barrier = join(fixture.directory, "claim.barrier");
  const ready = (ownerId) => join(fixture.directory, `claim.${ownerId}.ready`);
  const coreUrl = new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href;
  const childScript = (ownerId) => `
    import { existsSync, writeFileSync } from "node:fs";
    import { KnowledgeStore, EmbeddingLifecycle } from ${JSON.stringify(coreUrl)};
    writeFileSync(${JSON.stringify(ready(ownerId))}, "ready");
    while (!existsSync(${JSON.stringify(barrier)})) await new Promise((resolve) => setTimeout(resolve, 2));
    const store = KnowledgeStore.open({ dbPath: ${JSON.stringify(fixture.dbPath)}, ledgerPath: ${JSON.stringify(fixture.ledgerPath)} });
    const jobs = new EmbeddingLifecycle(store).claimJobs({ ownerId: ${JSON.stringify(ownerId)}, generationId: ${JSON.stringify(fixture.generation.id)}, limit: 3, now: "2026-08-31T08:00:00.000Z", leaseExpiresAt: "2026-08-31T08:02:00.000Z" });
    process.stdout.write(JSON.stringify(jobs.map((job) => job.id)));
    store.close();
  `;
  const run = (ownerId) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript(ownerId)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `child exited ${code}`)));
  });
  const first = run("process-a");
  const second = run("process-b");
  const readyDeadline = Date.now() + 5_000;
  while ((!existsSync(ready("process-a")) || !existsSync(ready("process-b"))) && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(existsSync(ready("process-a")), true, "process-a did not reach the barrier");
  assert.equal(existsSync(ready("process-b")), true, "process-b did not reach the barrier");
  assert.equal(existsSync(barrier), false);
  writeFileSync(barrier, "go");
  const [firstIds, secondIds] = await Promise.all([first, second]);
  assert.equal(firstIds.length + secondIds.length, 4);
  assert.equal(new Set([...firstIds, ...secondIds]).size, 4);
  fixture.store.close();
});

test("public transitionJob cannot claim work or persist a raw secret error", () => {
  const fixture = openFixture(2);
  const jobs = fixture.store.db.prepare("SELECT id FROM embedding_jobs ORDER BY id").all();
  assert.throws(
    () => fixture.lifecycle.transitionJob(jobs[0].id, "running"),
    /EMBEDDING_JOB_CLAIM_REQUIRED/,
  );
  fixture.store.db.prepare("UPDATE embedding_jobs SET status='running',attempts=1 WHERE id=?").run(jobs[0].id);
  assert.throws(
    () => fixture.lifecycle.transitionJob(jobs[0].id, "ready"),
    /EMBEDDING_JOB_OWNER_REQUIRED/,
  );
  const deleting = fixture.lifecycle.transitionJob(
    jobs[1].id,
    "deleting",
    "TOP_SECRET_SOURCE_TEXT token=abc123",
  );
  assert.equal(deleting.status, "deleting");
  assert.equal(deleting.error, null);
  fixture.store.close();
});

test("one live global worker lease wins and an expired lease can be taken over", () => {
  const fixture = openFixture(1);
  const secondStore = KnowledgeStore.open({ dbPath: fixture.dbPath, ledgerPath: fixture.ledgerPath });
  const secondLifecycle = new EmbeddingLifecycle(secondStore);
  assert.equal(fixture.lifecycle.acquireWorkerLease({
    ownerId: "worker-a",
    ownerPid: 101,
    buildId: "build-a",
    now: "2026-08-31T08:00:00.000Z",
    leaseExpiresAt: "2026-08-31T08:01:00.000Z",
  }), true);
  assert.equal(secondLifecycle.acquireWorkerLease({
    ownerId: "worker-b",
    ownerPid: 202,
    buildId: "build-a",
    now: "2026-08-31T08:00:30.000Z",
    leaseExpiresAt: "2026-08-31T08:01:30.000Z",
  }), false);
  assert.equal(secondLifecycle.acquireWorkerLease({
    ownerId: "worker-b",
    ownerPid: 202,
    buildId: "build-b",
    now: "2026-08-31T08:02:00.000Z",
    leaseExpiresAt: "2026-08-31T08:03:00.000Z",
  }), true);
  assert.equal(secondLifecycle.getWorkerLease().ownerId, "worker-b");
  secondStore.close();
  fixture.store.close();
});

test("only expired leases are reclaimed and a heartbeat extends ownership", () => {
  const fixture = openFixture(2);
  const claimed = fixture.lifecycle.claimJobs({
    ownerId: "worker-a",
    generationId: fixture.generation.id,
    limit: 2,
    now: "2026-08-31T08:00:00.000Z",
    leaseExpiresAt: "2026-08-31T08:01:00.000Z",
  });
  assert.equal(fixture.lifecycle.heartbeatJobs({
    ownerId: "worker-a",
    jobIds: [claimed[1].id],
    now: "2026-08-31T08:00:30.000Z",
    leaseExpiresAt: "2026-08-31T08:03:00.000Z",
  }), 1);

  assert.equal(fixture.lifecycle.reclaimExpiredJobs("2026-08-31T08:02:00.000Z"), 1);
  const rows = fixture.store.db.prepare(
    "SELECT id,status,lease_owner AS leaseOwner,error FROM embedding_jobs ORDER BY id",
  ).all();
  const expired = rows.find((row) => row.id === claimed[0].id);
  const live = rows.find((row) => row.id === claimed[1].id);
  assert.deepEqual(expired, {
    id: claimed[0].id,
    status: "pending",
    leaseOwner: null,
    error: "EMBEDDING_WORKER_LEASE_EXPIRED",
  });
  assert.equal(live.status, "running");
  assert.equal(live.leaseOwner, "worker-a");
  fixture.store.close();
});

test("an expired owner cannot complete or fail a claimed job", () => {
  const fixture = openFixture(2);
  const claimed = fixture.lifecycle.claimJobs({
    ownerId: "expired-worker",
    generationId: fixture.generation.id,
    limit: 2,
    now: "2026-08-31T08:00:00.000Z",
    leaseExpiresAt: "2026-08-31T08:01:00.000Z",
  });
  assert.throws(
    () => fixture.lifecycle.completeClaimedJob(claimed[0].id, "expired-worker", "2026-08-31T08:01:00.001Z"),
    /OWNERSHIP_LOST/,
  );
  assert.throws(
    () => fixture.lifecycle.failClaimedJob(claimed[1].id, "expired-worker", "late failure", "2026-08-31T08:01:00.001Z"),
    /OWNERSHIP_LOST/,
  );
  assert.equal(fixture.lifecycle.getJob(claimed[0].id).status, "running");
  assert.equal(fixture.lifecycle.getJob(claimed[1].id).status, "running");
  fixture.store.close();
});

test("pause blocks new claims and resume makes pending work claimable", () => {
  const fixture = openFixture(1);
  assert.equal(fixture.lifecycle.requestPause(fixture.generation.scopeKey).pauseRequested, true);
  assert.deepEqual(fixture.lifecycle.claimJobs({
    ownerId: "worker-a",
    generationId: fixture.generation.id,
    limit: 1,
    now: "2026-08-31T08:00:00.000Z",
    leaseExpiresAt: "2026-08-31T08:02:00.000Z",
  }), []);
  assert.equal(fixture.lifecycle.resumeScope(fixture.generation.scopeKey).pauseRequested, false);
  assert.equal(fixture.lifecycle.claimJobs({
    ownerId: "worker-a",
    generationId: fixture.generation.id,
    limit: 1,
    now: "2026-08-31T08:00:00.000Z",
    leaseExpiresAt: "2026-08-31T08:02:00.000Z",
  }).length, 1);
  fixture.store.close();
});

test("pause lets the current claimed batch finish but blocks the next claim", () => {
  const fixture = openFixture(2);
  const claimed = fixture.lifecycle.claimJobs({
    ownerId: "worker-a",
    generationId: fixture.generation.id,
    limit: 1,
    now: "2026-08-31T08:00:00.000Z",
    leaseExpiresAt: "2026-08-31T08:01:00.000Z",
  });
  fixture.lifecycle.requestPause(fixture.generation.scopeKey);
  assert.equal(
    fixture.lifecycle.completeClaimedJob(claimed[0].id, "worker-a", "2026-08-31T08:00:30.000Z").status,
    "ready",
  );
  assert.deepEqual(fixture.lifecycle.claimJobs({
    ownerId: "worker-a",
    generationId: fixture.generation.id,
    limit: 1,
    now: "2026-08-31T08:00:30.000Z",
    leaseExpiresAt: "2026-08-31T08:01:30.000Z",
  }), []);
  fixture.store.close();
});

test("automatic retries use 30-second exponential backoff and become stalled after five failures", () => {
  const fixture = openFixture(1);
  let nowMs = Date.parse("2026-08-31T08:00:00.000Z");
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const now = new Date(nowMs).toISOString();
    const claimed = fixture.lifecycle.claimJobs({
      ownerId: "worker-a",
      generationId: fixture.generation.id,
      limit: 1,
      now,
      leaseExpiresAt: new Date(nowMs + 60_000).toISOString(),
    });
    assert.equal(claimed.length, 1, `attempt ${attempt} must become claimable at its deadline`);
    const failed = fixture.lifecycle.failClaimedJob(
      claimed[0].id,
      "worker-a",
      "TOP_SECRET_SOURCE_TEXT token=abc123",
      now,
    );
    assert.equal(failed.attempts, attempt);
    assert.equal(failed.error.includes("TOP_SECRET_SOURCE_TEXT"), false);
    assert.equal(failed.error.includes("abc123"), false);
    if (attempt < 5) {
      const delayMs = Math.min(30 * 60_000, 30_000 * 2 ** (attempt - 1));
      assert.equal(failed.nextAttemptAt, new Date(nowMs + delayMs).toISOString());
      assert.deepEqual(fixture.lifecycle.claimJobs({
        ownerId: "worker-b",
        generationId: fixture.generation.id,
        limit: 1,
        now: new Date(nowMs + delayMs - 1).toISOString(),
        leaseExpiresAt: new Date(nowMs + delayMs + 59_999).toISOString(),
      }), []);
      nowMs += delayMs;
    } else {
      assert.equal(failed.nextAttemptAt, null);
    }
  }
  assert.equal(listSemanticStatuses(fixture.store, fixture.generation.scopeKey)[0].state, "stalled");
  fixture.store.close();
});

test("only allowlisted worker reasons persist verbatim while secret-looking machine tokens are hashed", () => {
  const fixture = openFixture(3);
  const now = "2026-08-31T08:00:00.000Z";
  const claimed = fixture.lifecycle.claimJobs({
    ownerId: "worker-a",
    generationId: fixture.generation.id,
    limit: 3,
    now,
    leaseExpiresAt: "2026-08-31T08:01:00.000Z",
  });
  assert.equal(claimed.length, 3);

  const awsSecret = fixture.lifecycle.failClaimedJob(
    claimed[0].id,
    "worker-a",
    "AKIAIOSFODNN7EXAMPLE",
    now,
  );
  const externalMachineLikeReason = fixture.lifecycle.failClaimedJob(
    claimed[1].id,
    "worker-a",
    "PROVIDER_DOWN",
    now,
  );
  const internalMachineReason = fixture.lifecycle.failClaimedJob(
    claimed[2].id,
    "worker-a",
    "EMBEDDING_RESPONSE_INVALID",
    now,
  );

  assert.match(awsSecret.error, /^EMBEDDING_FAILED_[A-F0-9]{12}$/);
  assert.equal(awsSecret.error.includes("AKIAIOSFODNN7EXAMPLE"), false);
  assert.match(externalMachineLikeReason.error, /^EMBEDDING_FAILED_[A-F0-9]{12}$/);
  assert.notEqual(externalMachineLikeReason.error, "PROVIDER_DOWN");
  assert.equal(internalMachineReason.error, "EMBEDDING_RESPONSE_INVALID");
  fixture.store.close();
});

test("manual retry resets failed jobs while preserving ready jobs", () => {
  const fixture = openFixture(2);
  const claimed = fixture.lifecycle.claimJobs({
    ownerId: "worker-a",
    generationId: fixture.generation.id,
    limit: 2,
    now: "2026-08-31T08:00:00.000Z",
    leaseExpiresAt: "2026-08-31T08:02:00.000Z",
  });
  fixture.lifecycle.failClaimedJob(claimed[0].id, "worker-a", "fixture failure", "2026-08-31T08:01:00.000Z");
  fixture.lifecycle.completeClaimedJob(claimed[1].id, "worker-a", "2026-08-31T08:01:00.000Z");
  fixture.store.db.prepare("UPDATE embedding_jobs SET attempts=5 WHERE id=?").run(claimed[0].id);

  assert.equal(fixture.lifecycle.retryFailures(fixture.generation.id), 1);
  const rows = fixture.store.db.prepare(
    "SELECT id,status,attempts,error FROM embedding_jobs ORDER BY id",
  ).all();
  assert.deepEqual(rows.find((row) => row.id === claimed[0].id), {
    id: claimed[0].id,
    status: "pending",
    attempts: 0,
    error: null,
  });
  assert.equal(rows.find((row) => row.id === claimed[1].id).status, "ready");
  fixture.store.close();
});

test("cancel fails only the selected staging generation", () => {
  const fixture = openFixture(1);
  fixture.store.db.prepare("UPDATE embedding_generations SET status='active',activated_at=? WHERE id=?").run(
    "2026-08-31T08:00:00.000Z",
    fixture.generation.id,
  );
  fixture.store.db.prepare(`
    INSERT INTO semantic_active_spaces(scope_key,generation_id,previous_generation_id,activated_at)
    VALUES (?,?,NULL,?)
  `).run(fixture.generation.scopeKey, fixture.generation.id, "2026-08-31T08:00:00.000Z");
  const staging = fixture.lifecycle.createGeneration({
    spaceId: fixture.generation.spaceId,
    snapshotId: "snapshot-next",
    scopeKey: fixture.generation.scopeKey,
    expectedChunks: 1,
  });
  const result = fixture.lifecycle.cancelGeneration(staging.id);
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "USER_CANCELLED");
  assert.equal(fixture.store.db.prepare("SELECT status FROM embedding_generations WHERE id=?").get(fixture.generation.id).status, "active");
  assert.equal(fixture.store.db.prepare("SELECT generation_id AS generationId FROM semantic_active_spaces WHERE scope_key=?").get(fixture.generation.scopeKey).generationId, fixture.generation.id);
  assert.equal(fixture.lifecycle.claimJobs({
    ownerId: "worker-a",
    generationId: staging.id,
    limit: 1,
    now: "2026-08-31T08:00:00.000Z",
    leaseExpiresAt: "2026-08-31T08:02:00.000Z",
  }).length, 0);
  fixture.store.close();
});

test("cancel and retry refuse an already-active target without changing its jobs", () => {
  const fixture = openFixture(1);
  const claimed = fixture.lifecycle.claimJobs({
    ownerId: "worker-a",
    generationId: fixture.generation.id,
    limit: 1,
    now: "2026-08-31T08:00:00.000Z",
    leaseExpiresAt: "2026-08-31T08:01:00.000Z",
  });
  fixture.lifecycle.completeClaimedJob(claimed[0].id, "worker-a", "2026-08-31T08:00:30.000Z");
  fixture.store.db.prepare("UPDATE embedding_generations SET status='active',activated_at=? WHERE id=? AND status='staging'").run(
    "2026-08-31T08:00:30.000Z",
    fixture.generation.id,
  );
  assert.throws(() => fixture.lifecycle.cancelGeneration(fixture.generation.id), /INVALID_TRANSITION/);
  assert.throws(() => fixture.lifecycle.retryFailures(fixture.generation.id), /INVALID_TRANSITION/);
  assert.equal(fixture.lifecycle.getJob(claimed[0].id).status, "ready");
  assert.equal(fixture.lifecycle.getGeneration(fixture.generation.id).status, "active");
  fixture.store.close();
});
