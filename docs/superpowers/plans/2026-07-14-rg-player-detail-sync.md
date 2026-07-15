# RG Player Detail Redis Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize `playerDetail:{platformId}:{name}` immediately after Risk-Control commits a cooling-off or self-exclusion lifecycle change, without adding a duplicate Player→Risk mutation API.

**Architecture:** Keep Risk-Control as the owner of RG lifecycle state and its `lifecycle:{playerId}` cache. After the proposal executor successfully persists the lifecycle, publish a versioned `rg.lifecycle.changed` Pulsar event containing player identity and lifecycle timestamps. Auth consumes that event and invokes the existing BP player-detail writer, which performs the CPMS Redis HSET. The existing `StartCoolingOff` and `StartSelfExclusion` APIs remain the mutation entry points.

**Tech Stack:** NestJS, TypeScript, gRPC/protobuf, Risk-Control proposal executor, Pulsar producer/consumer, CPMS Redis, Jest.

---

### Task 1: Freeze the current contract and observable timing

**Files:**
- Read: `/Users/shieng/Desktop/Projects/risk/src/responsibleGaming/service/rg-lifecycle.service.ts`
- Read: `/Users/shieng/Desktop/Projects/risk/src/responsibleGaming/executor/rg-proposal.executor.ts`
- Read: `/Users/shieng/Desktop/Projects/auth/libs/tools/src/spi/player-details/sites/bp/bp-player-details.provider.ts`
- Test: `/Users/shieng/Desktop/Projects/risk/src/responsibleGaming/service/rg-lifecycle.service.spec.ts`

- [ ] **Step 1: Record the existing state transitions.**

  Confirm these facts in tests and source:

  ```text
  StartCoolingOff/StartSelfExclusion
    → createRgProposal
    → proposal approval/executor
    → writeLifecycle
    → stateRepository.upsertLifecycle
    → RiskControlRedisService.setLifecycle
  ```

- [ ] **Step 2: Add a failing timing test.**

  In `rg-proposal.executor.spec.ts`, assert that the lifecycle-change notification is emitted only after `writeLifecycle` has completed, not when the proposal is merely created.

- [ ] **Step 3: Run the focused Risk-Control test.**

  ```bash
  cd /Users/shieng/Desktop/Projects/risk
  pnpm exec jest --runInBand src/responsibleGaming/executor/rg-proposal.executor.spec.ts
  ```

  Expected: the new assertion fails because no lifecycle-change event exists yet.

---

### Task 2: Define the lifecycle-change event contract

**Files:**
- Create: `/Users/shieng/Desktop/Projects/risk/src/responsibleGaming/events/rg-lifecycle-changed.event.ts`
- Create: `/Users/shieng/Desktop/Projects/risk/src/responsibleGaming/events/rg-lifecycle-changed.publisher.ts`
- Modify: `/Users/shieng/Desktop/Projects/risk/src/responsibleGaming/responsible-gaming.module.ts`
- Test: `/Users/shieng/Desktop/Projects/risk/src/responsibleGaming/events/rg-lifecycle-changed.event.spec.ts`

- [ ] **Step 1: Define the payload.**

  ```ts
  export const RG_LIFECYCLE_CHANGED = 'rg.lifecycle.changed' as const;

  export interface RgLifecycleChangedEvent {
    eventName: typeof RG_LIFECYCLE_CHANGED;
    eventVersion: 1;
    occurredAt: string;
    playerId: string;
    playerName: string;
    platformId: string;
    status: 'COOLING_OFF' | 'SELF_EXCLUDED_TEMP' | 'SELF_EXCLUDED_PERM' | 'CLOSED' | 'ACTIVE';
    effectiveTime: string;
    expireTime: string;
  }
  ```

  The event must contain no CPF, token, email, or other PII.

- [ ] **Step 2: Test serialization and required fields.**

  Assert that cooling-off and temporary/permanent self-exclusion produce the same stable shape, with an empty `expireTime` only for permanent states.

- [ ] **Step 3: Run the event contract test.**

  ```bash
  cd /Users/shieng/Desktop/Projects/risk
  pnpm exec jest --runInBand src/responsibleGaming/events/rg-lifecycle-changed.event.spec.ts
  ```

---

### Task 3: Publish after Risk-Control commits lifecycle state

**Files:**
- Modify: `/Users/shieng/Desktop/Projects/risk/src/responsibleGaming/executor/rg-proposal.executor.ts`
- Modify: `/Users/shieng/Desktop/Projects/risk/src/responsibleGaming/executor/rg-proposal-executor.module.ts`
- Test: `/Users/shieng/Desktop/Projects/risk/src/responsibleGaming/executor/rg-proposal.executor.spec.ts`

- [ ] **Step 1: Add a Risk-Control Pulsar producer using the same vault connection family as `rg-deposit-accumulate` and `rg-limit-hit`.**

  Use a dedicated topic, `rg_lifecycle_changed`, and a durable subscription name owned by Auth. Do not reuse the player push-notification channel: that channel is for frontend delivery, not durable service-to-service replay.

- [ ] **Step 2: Emit only after all three writes succeed.**

  The order must remain:

  ```text
  stateRepository.upsertLifecycle
  → risk Redis setLifecycle
  → snapshotRepository.upsertFields
  → publish rg.lifecycle.changed
  ```

  If any write fails, do not publish a success event. Log the failure with `playerId`, `platformId`, lifecycle status, and stage.

- [ ] **Step 3: Make duplicate delivery safe.**

  Include `occurredAt` and the lifecycle timestamps. Consumers must treat the event as idempotent and may safely re-run the player-detail HSET.

- [ ] **Step 4: Run the executor tests.**

  ```bash
  cd /Users/shieng/Desktop/Projects/risk
  pnpm exec jest --runInBand src/responsibleGaming/executor/rg-proposal.executor.spec.ts src/responsibleGaming/service/rg-lifecycle.service.spec.ts
  ```

  Expected: all existing tests plus the new “publish after commit” tests pass.

---

### Task 4: Add an Auth consumer that refreshes CPMS playerDetail

**Files:**
- Create: `/Users/shieng/Desktop/Projects/auth/libs/tools/src/services/rg-lifecycle-sync/rg-lifecycle-sync.service.ts`
- Create: `/Users/shieng/Desktop/Projects/auth/libs/tools/src/services/rg-lifecycle-sync/rg-lifecycle-sync.module.ts`
- Create: `/Users/shieng/Desktop/Projects/auth/libs/tools/src/services/rg-lifecycle-sync/rg-lifecycle-sync.consumer.ts`
- Modify: `/Users/shieng/Desktop/Projects/auth/apps/auth/src/auth/auth.module.ts`
- Test: `/Users/shieng/Desktop/Projects/auth/apps/auth/test/unit/services/rg-lifecycle-sync/rg-lifecycle-sync.service.spec.ts`

- [ ] **Step 1: Write the consumer test first.**

  Given an event with `{ playerId, playerName, platformId, status, effectiveTime, expireTime }`, assert that the service calls the existing `PlayerDetailsSpiBase.writePlayerDetails` with:

  ```ts
  {
    playerId: event.playerId,
    platformId: event.platformId,
    name: event.playerName,
  }
  ```

  Assert that malformed events, missing identity, and unsupported event versions are rejected without Redis writes.

- [ ] **Step 2: Implement the consumer with idempotent handling.**

  The consumer must:

  - validate `eventName` and `eventVersion`;
  - require non-empty `playerId`, `playerName`, and `platformId`;
  - call the existing site-aware writer, preserving BP/BASE behavior;
  - log received, skipped, completed, and failed stages with `playerId`, `platformId`, and status;
  - never log CPF, email, access tokens, or full request payloads.

- [ ] **Step 3: Register the consumer in the Auth module.**

  Ensure the module starts a durable Pulsar consumer for `rg_lifecycle_changed` and does not create a second CPMS Redis client.

- [ ] **Step 4: Run the consumer tests.**

  ```bash
  cd /Users/shieng/Desktop/Projects/auth
  pnpm auth:test --runInBand apps/auth/test/unit/services/rg-lifecycle-sync/rg-lifecycle-sync.service.spec.ts
  ```

---

### Task 5: Verify the existing mutation APIs remain unchanged

**Files:**
- Read/Test: `/Users/shieng/Desktop/Projects/risk/src/responsibleGaming/responsible-gaming.controller.ts`
- Test: `/Users/shieng/Desktop/Projects/risk/src/responsibleGaming/responsible-gaming.controller.spec.ts`

- [ ] **Step 1: Keep these APIs as the only player mutation entry points.**

  ```text
  FrontendResponsibleGamingService.StartCoolingOff
  FrontendResponsibleGamingService.StartSelfExclusion
  ```

- [ ] **Step 2: Do not add a duplicate Player→Risk `SetCoolingOff` or `SetSelfExclusion` API.**

  The existing Risk-Control endpoints already create the proposal and calculate effective/expire times.

- [ ] **Step 3: Add an integration assertion.**

  After the frontend mutation returns success, the test must model executor completion and assert that the event—not a second mutation API—causes the CPMS writer call.

---

### Task 6: End-to-end verification in UAT

**Files:**
- Create: `/Users/shieng/Desktop/Pengvi/.codex/rg-player-detail-sync-uat.md`

- [ ] **Step 1: Start a cooling-off test.**

  Record:

  ```text
  playerId
  playerName
  platformId
  proposalId
  request traceId
  ```

- [ ] **Step 2: Verify Risk-Control state.**

  Call `GetLifecycleState` and confirm:

  ```text
  status = RG_COOLING_OFF
  effectiveTime is non-empty
  expireTime is non-empty
  ```

- [ ] **Step 3: Verify event delivery.**

  Search logs for:

  ```text
  rg.lifecycle.changed
  playerId
  platformId
  status
  ```

- [ ] **Step 4: Verify CPMS Redis.**

  Query the exact key:

  ```text
  playerDetail:{platformId}:{playerName}
  ```

  Expected cooling-off fields:

  ```text
  status = 3
  suspensionPeriod > 0
  suspensionStartAt = effectiveTime
  exclusionStartAt absent
  ```

- [ ] **Step 5: Repeat for temporary and permanent self-exclusion.**

  Expected:

  ```text
  status = 4 or 5
  exclusionStartAt = effectiveTime
  suspensionStartAt absent
  ```

- [ ] **Step 6: Verify failure behavior.**

  Simulate a Redis write failure and confirm:

  - Risk-Control lifecycle state remains committed;
  - the event is still observable for retry/replay;
  - Auth logs the exact `write-player-detail-redis` failure stage;
  - no sensitive payload is logged.

---

### Task 7: Build and release gate

- [ ] Run Risk-Control tests and build:

  ```bash
  cd /Users/shieng/Desktop/Projects/risk
  pnpm test
  pnpm build
  ```

- [ ] Run Auth focused tests and build:

  ```bash
  cd /Users/shieng/Desktop/Projects/auth
  pnpm tools:test --runInBand
  pnpm auth:test --runInBand
  pnpm auth:build
  ```

- [ ] Run formatting and diff checks:

  ```bash
  pnpm checkstyle
  git diff --check
  ```

- [ ] Do not release until both Redis paths are proven:

  ```text
  Risk-Control lifecycle:{playerId}
  CPMS playerDetail:{platformId}:{name}
  ```
