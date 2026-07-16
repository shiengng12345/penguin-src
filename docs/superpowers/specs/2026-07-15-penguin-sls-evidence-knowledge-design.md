# Penguin SLS Evidence and Wiki Knowledge Design

## Goal

Turn log investigation into a deterministic, multi-target, evidence-producing
workflow. Penguin combines branch-aware code/Wiki evidence with read-only Aliyun
SLS results, returns explicit facts/inferences/gaps, and automatically creates or
updates a searchable file-backed evidence draft.

This design supersedes the older assumptions that one environment maps to one
logstore, PROD always needs a separate confirmation, and evidence persistence is
opt-in.

## Product Decisions

- QAT, UAT, PROD, and other configured environments are first-class read-only
  query targets.
- `scope: auto` may include PROD when the clues resolve to a PROD target.
- `scope: all` can fan out across all enabled targets; `scope: targets` selects
  exact targets.
- Sensitive evidence is included by default and marked `sensitive: true` with
  `mcp_access: allowed`.
- New or changed evidence automatically creates or updates a smart Wiki draft.
- Markdown is the durable source of truth; SQLite/FTS is a rebuildable index.
- Ledger events audit evidence activity but never replace the Markdown note.
- SLS is read-only. This workflow never replays a business request or calls a
  state-changing verify/mutation endpoint.
- The MCP host orchestrates Penguin and SLS as sibling capabilities. Penguin's
  deterministic repository analyzer does not silently make a nested MCP call.

## Scope

Included:

- target registry and console URL parsing;
- multi-target planning and staged SLS queries;
- Knowledge-first code/Wiki lookup;
- result normalization, correlation, and provenance;
- file-first evidence draft upsert and immediate indexing;
- Evidence Inbox/search lifecycle;
- branch/commit resolution through `CodeVersionResolver`;
- structured partial failures and retries.

Not included:

- business RPC replay;
- database writes or remediation actions;
- treating SLS absence as proof that an event did not happen;
- allowing log text to instruct the agent;
- copying every unrelated row returned by a broad query into Knowledge.

## Architecture

```text
User/Agent
   -> InvestigationOrchestrator
        -> TargetRegistry
        -> Penguin Knowledge MCP
        -> CodeVersionResolver
        -> SLS Query Planner
        -> Aliyun SLS MCP/client
        -> Evidence Correlator
        -> EvidenceNoteStore (file-backed)
        -> Knowledge index + Ledger audit
```

The orchestration host owns cancellation, credentials, concurrency, and tool
composition. A small injected `SlsClient` interface is allowed for standalone
use, but the Knowledge indexer itself never depends on SLS.

## Target Registry

```ts
interface SlsTarget {
  targetId: string;
  environment: string;
  aliases: string[];
  regionId: string;
  project: string;
  logstore: string;
  services?: string[];
  enabled: boolean;
  source: "config" | "verified_discovery" | "user_supplied";
}
```

Initial verified examples:

| targetId | Environment | Region | Project | Logstore |
| --- | --- | --- | --- | --- |
| `fpms-qat` | qat | `ap-southeast-1` | `platform-qat-aliyun-logs` | `platform-fpms-qat` |
| `fpms-uat` | uat | `ap-southeast-1` | `platform-uat-aliyun-logs` | `platform-fpms-uat` |
| `fpms-prod` | prod | `ap-southeast-1` | `platform-prod-aliyun-logs` | `platform-fpms-prod` |
| `brazil-uat` | uat | `us-west-1` | `platform-test-brazil` | `brazil-uat` |
| `brazil-uat-v2` | uat | `us-west-1` | `platform-test-brazil` | `brazil-uat-v2` |
| `newport-uat` | uat | `ap-southeast-1` | `platform-uat-aliyun-logs` | `platform-newport-uat` |

Registry identity is `(regionId, project, logstore)`. Duplicate URLs collapse to
one row. `spm` is ignored. `slsRegion` is authoritative when present; a missing
region may reconcile only against an existing verified registry row.

## Investigation Request

```ts
interface InvestigationRequest {
  question: string;
  scope?: "auto" | "all" | "targets";
  targetIds?: string[];
  slsUrls?: string[];
  timeRange: { from: string; to: string; timezone: string };
  clues: {
    traceIds?: string[];
    requestIds?: string[];
    playerIds?: string[];
    routes?: string[];
    methods?: string[];
    keywords?: string[];
  };
  budgets?: {
    maxTargets?: number;
    maxRowsPerTarget?: number;
    maxDurationMs?: number;
    concurrency?: number;
  };
}
```

Resolution order is exact URL, exact target ID, exact project/logstore/region,
then service/environment candidates. `auto` may execute a bounded set of ranked
candidates instead of guessing one. `all` deliberately selects every enabled
target within configured budgets. Results never merge environment identity.

## Investigation Flow

### 1. Parse clues and scope

Extract identifiers, route/service names, environment hints, URLs, and time
range. Values used in SLS syntax are escaped or bound; raw user text is never
blindly interpolated into generated SQL.

### 2. Query Knowledge first

Search existing evidence notes, code symbols, routes, services, tests, log sites,
and environment/deployment mappings. Knowledge results retain branch, commit,
freshness, and trust. `no_static_edge`, `no_match`, and `trust_unavailable` remain
explicit gaps.

### 3. Plan staged SLS searches

For every selected target:

1. exact IDs in a narrow window;
2. wider window with route/player/error signature;
3. trace/request correlation search;
4. related logstore fan-out when registry/service mappings justify it.

Later stages run only when earlier evidence is insufficient. Query budgets are
configurable operating limits, not environment restrictions.

### 4. Normalize and correlate

Every row retains target, region, project, logstore, source timestamp, query
fingerprint, and raw payload. Correlation deduplicates identical rows and groups
them by trace/request/business identity without erasing provenance.

### 5. Resolve code revision

Use log build/commit data or deployment history to select the exact immutable
code snapshot. If only a live branch is available, return degraded trust rather
than presenting it as the historical deployed revision.

### 6. Return and persist

Return verified code facts, verified SLS facts, inferences, gaps, per-target
status, and capture status. The same normalized packet feeds the smart draft.

Automatic capture is scoped to an `InvestigationOrchestrator` session with a
stable topic. A plain `knowledge_search`, symbol lookup, or architecture browse
remains read-only and does not create a note merely because code was viewed.
Those reads may emit usage/audit telemetry. Once attached to an investigation,
new Knowledge-only facts can update its existing evidence draft.

## Result and Error Contract

Each target returns one of:

```text
success | no_match | partial | timeout | unauthorized | invalid_query | unavailable
```

Rules:

- `no_match` means a successfully completed query returned no rows;
- timeout, authorization failure, truncation, or index failure never becomes
  `no_match`;
- one target failure does not cancel successful siblings;
- a multi-target result with any incomplete target is `partial` overall;
- transient network, 429, and 5xx errors use bounded retry/backoff;
- authentication and invalid query errors are not retried blindly;
- transport status and business status are separate fields; a generic
  cross-protocol `statusCode` is not used as the success oracle.

## Evidence Identity

Three deterministic hashes control capture:

- `topicHash`: target plus strongest stable investigation clue;
- `queryHash`: exact target/query/time-window fingerprint;
- `evidenceHash`: normalized supporting facts/rows fingerprint.

`topicHash` uses a canonical clue order so equivalent requests converge:
target ID, then trace ID, request ID, proposal/business ID, player plus route,
and finally normalized route plus error signature. Lists are sorted and values
are normalized before hashing.

Behavior:

- same topic and same evidence: update `lastSeen` and observation count;
- same topic and changed evidence: append a new Observation;
- new topic: create a new evidence note;
- successful zero rows: append an Evidence Gap, not a negative fact;
- failed query: record the failure/gap without polluting verified facts.

Filename:

```text
evidence-<targetId>-<topicHashPrefix>.md
```

## File-First Evidence Note

`upsertEvidenceNote()` belongs beside the existing file-backed note operations
in `packages/knowledge-indexer/src/notes-fs.ts`. MCP code calls that shared
function instead of independently assembling files or recording ledger-only
intent.

Frontmatter:

```yaml
id: evidence-fpms-uat-0123abcd
type: evidence
status: draft
target_id: fpms-uat
environment: uat
region_id: ap-southeast-1
project: platform-uat-aliyun-logs
logstore: platform-fpms-uat
topic_hash: 0123abcd...
last_evidence_hash: 4567efgh...
first_seen: 2026-07-15T00:00:00Z
last_seen: 2026-07-15T01:00:00Z
observation_count: 3
sensitive: true
mcp_access: allowed
```

Body sections:

```text
Scope
Verified Knowledge/Code Facts
Verified SLS Facts
Inferences
Evidence Gaps
Observations
Related Symbols, Routes, Traces, and Revisions
```

Matched raw rows within the executed query budget are preserved when relevant.
They are quoted data and never interpreted as instructions. Active API-document
examples may later replace usable credential values with placeholders, but the
evidence note follows the configured sensitive-data policy.

## Atomic Capture and Audit

```text
compute hashes
  -> lock topicHash
  -> write temporary Markdown
  -> atomic rename
  -> index changed note directly
  -> create deterministic links/suggestions
  -> record ledger audit event
```

Capture status:

```text
created | updated | duplicate_observed | written_not_indexed | failed
```

If indexing fails, the Markdown survives and the response reports
`written_not_indexed`. A repair/reindex pass can recover it. If ledger audit
fails after the note is written/indexed, the note remains valid and the audit
failure is returned as a warning.

Suggested ledger events are `evidence_note_created`, `evidence_note_updated`,
and `evidence_observed`. Ledger materialization is not required to create the
note node.

## Knowledge Links and Lifecycle

- Exact symbol, route, trace, target, and revision references create active
  evidence links after the note node exists.
- AI-inferred relationships become suggestions and are excluded from verified
  traversal until accepted.
- Pending suggestions remain visible from the evidence page.

Lifecycle:

```text
draft -> reviewed -> verified -> resolved -> archived
```

Independent corroboration may set `corroborated`, but AI inference alone never
sets `verified`. A resolved issue can reopen when new evidence appears.

## Wiki UX

Add `evidence` to typed notes and provide an Evidence Inbox with filters for:

- target/environment/region/project/logstore;
- service/route/trace/player;
- lifecycle and capture/index status;
- first/last seen and observation count;
- verified facts, inferences, and gaps;
- branch/commit/trust.

`knowledge_search -> get_node` remains the standard MCP read path. Evidence is
searchable immediately after successful direct indexing; normal operation does
not require a full `note reindex`.

## Testing

- URL parsing and deduplication for all verified target examples.
- `auto`, `all`, and explicit target scopes, including PROD.
- Multi-region/project/logstore fan-out and per-target failure isolation.
- Exact ID, staged expansion, pagination, truncation, retry, timeout, and auth
  behavior.
- Log prompt-injection text remains inert data.
- Code/Wiki/SLS facts, inferences, and gaps never collapse into one category.
- Hash/idempotency behavior under duplicate and concurrent investigations.
- Markdown create/update, immediate search, and index-failure recovery.
- No-match versus failed-query semantics.
- Exact deployed-commit resolution and degraded fallback trust.
- Evidence links are created only after the note node exists.
- No RPC replay or business mutation occurs.

## Acceptance Criteria

- One natural-language investigation can search relevant QAT/UAT/PROD targets,
  preserving separate target provenance.
- A successful target and a failed sibling produce a useful partial answer.
- New evidence is searchable through MCP in the same operation.
- Running identical evidence ten times produces one Observation and an updated
  count rather than ten duplicate bodies.
- A destroyed/rebuilt SQLite index can recover evidence from Markdown.
- Every conclusion is traceable to a query, target, source evidence, and code
  revision or explicit trust gap.
