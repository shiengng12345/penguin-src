# Penguin Evidence-Backed API Documentation Generator Design

## Goal

Generate and maintain frontend integration documentation from branch-correct
Penguin Knowledge, Wiki notes, tests, schemas, and SLS runtime evidence. The
output must support the structure and depth of the inspected Lark document
`Brazil APP - Responsible Gaming 前端对接接口文档`: enums, endpoint routes,
headers, request/response schemas, business behavior, request/response matrices,
examples, WebSocket behavior, common responses, and a frontend checklist.

The generator does not claim completeness when evidence is incomplete. Every
generated scenario has provenance, revision, and a completeness state.

## Product Decisions

- Canonical documentation is generated from `main`/`master` or an exact
  deployed commit.
- Feature branches produce Penguin previews/drafts by default, not permanent
  Lark pages.
- A requested feature preview may be published as a Lark draft.
- Canonical Lark pages use managed-section synchronization; the generator never
  overwrites an entire human-edited document blindly.
- Stable document binding prevents same-title duplicate pages.
- Request coverage means all reachable request classes, not every value in an
  infinite domain.
- Response coverage means all reachable outcome classes, with dynamic external
  messages grouped explicitly.
- `All Possible` headings appear only when the coverage contract supports them;
  otherwise the document says `Known ...` and exposes gaps.

## Scope

Included:

- gRPC/Connect/HTTP methods already represented by Penguin endpoints;
- WebSocket/event sections when source or evidence exists;
- request headers, schema, constraints, state preconditions, and examples;
- business and transport response classes;
- source/test/Wiki/SLS evidence and branch/commit trust;
- preview, draft, diff, and managed Lark synchronization;
- idempotent document identity and revision conflict handling.

Not included:

- executing every request combination against live services;
- replaying state-changing requests to discover behavior;
- claiming external dependency messages form a finite closed set;
- creating one permanent Lark document per feature branch;
- publishing undocumented AI guesses as verified behavior;
- embedding usable access tokens in generated API examples.

## Architecture

```text
DocumentationRequest
  -> CodeVersionResolver
  -> Endpoint/Schema Collector
  -> Behavior and Constraint Analyzer
  -> Test/Wiki/SLS Evidence Collector
  -> ApiDocumentationIR
  -> Completeness Validator
  -> Markdown/Lark Renderer
  -> Penguin Preview Store
  -> optional LarkPublisher
```

The deterministic indexer produces facts; it does not call an LLM or Lark.
Generation lives in a CLI/host service that can gather Context Packs and invoke
an optional model. The model emits structured claims with evidence IDs. A claim
whose evidence cannot be resolved is demoted to inference or gap before render.

Lark publishing is an adapter boundary. The core generator outputs a stable
intermediate representation and Markdown/XML without owning user credentials.

## Documentation Request

```ts
interface DocumentationRequest {
  subjects: Array<{
    repo?: string;
    service?: string;
    method?: string;
    route?: string;
  }>;
  revision: {
    branch?: string;
    commitSha?: string;
    targetId?: string;
    deployedAt?: string;
  };
  audience: "frontend" | "backend" | "operations";
  language: string;
  mode: "preview" | "draft" | "sync";
  includeRuntimeEvidence: boolean;
  runtimeScope?: {
    targetIds?: string[];
    from: string;
    to: string;
    clues?: string[];
  };
}
```

Exact commit wins. Target/timestamp resolves through deployment history. An
unresolved revision may generate a preview with degraded trust but cannot update
a canonical managed document without an explicit override.

## `ApiDocumentationIR`

```ts
interface ApiDocumentationIR {
  documentKey: string;
  title: string;
  revisions: Array<{
    repo: string;
    branch?: string;
    commitSha: string;
    mergeBaseSha?: string;
    trust: string;
  }>;
  enums: EnumDoc[];
  endpoints: EndpointDoc[];
  websocketEvents: EventDoc[];
  commonResponses: ResponseClass[];
  frontendChecklist: ChecklistItem[];
  evidence: EvidenceRef[];
  gaps: EvidenceGap[];
  coverage: CoverageSummary;
}
```

A document may span multiple repositories or services. Each endpoint and
evidence reference points to one entry in `revisions`; a document-level single
commit is never assumed. Target/deployment resolution produces a revision per
participating repository.

Each endpoint includes:

- service, method, route, protocol, and description;
- headers/auth/environment routing;
- request/response schemas and enums;
- field constraints, units, formats, defaults, and optionality;
- state preconditions and side effects;
- request scenario matrix;
- response outcome matrix;
- synthetic, test-derived, and runtime-observed examples;
- frontend handling guidance;
- source evidence and unresolved gaps.

## Evidence Collection

### Schema evidence

Collect proto/package/source schemas, including nested messages, maps, repeated
fields, oneof, enum values, optionality, defaults, and transport metadata. The
grpc and grpc-web loaders must expose one normalized schema contract before the
generator treats it as complete.

### Code behavior evidence

Use endpoint handlers, callees, return sites, throws, catches, fallback paths,
guards, interceptors, validators, tests, and data-source calls. Dynamic DI,
reflection, HTTP dispatch, or a `no_static_edge` result remains a gap unless
another source resolves it.

### Wiki evidence

Use typed notes and reviewed evidence for business intent, frontend guidance,
decision rationale, terminology, and known operational boundaries. Note status
and freshness determine whether content is a fact, inference, or gap.

### Runtime evidence

Use SLS read-only evidence for observed errors, response samples, headers,
deployed commit, and actual fallback behavior. Runtime observation proves that a
case occurred; it does not prove that no other case is possible.

### Example priority

```text
checked-in test fixture
  -> reviewed Wiki example
  -> SLS observed sample
  -> schema-valid synthetic example
```

Every example is labelled with its origin. Synthetic values are never presented
as observed production data. Usable credentials are rendered as placeholders.

## All Request Classes

The request analyzer enumerates equivalence classes rather than every concrete
value. It combines:

- headers, auth, and environment-routing requirements;
- field presence, type, enum, oneof, repeated/map constraints;
- decorators and manual validation;
- cross-field conditions;
- boundary partitions such as empty, zero, negative, malformed, minimum,
  maximum, and unknown enum;
- state-dependent prerequisites;
- valid side-effect directions and idempotency behavior.

Each request class records:

```text
scenario | headers | body partition | precondition | valid/invalid |
expected outcome class | side-effect risk | evidence | coverage
```

The generator does not perform a Cartesian expansion when combinations are
semantically equivalent. Pairwise/boundary examples are selected from the
closed scenario model.

## All Response Classes

The response analyzer enumerates:

1. explicit handler returns;
2. business status/message branches;
3. validation failures;
4. thrown transport errors;
5. catches, fallbacks, and degraded success;
6. downstream dependency failure classes;
7. state-dependent outcomes;
8. test-covered outcomes;
9. runtime-observed outcomes;
10. side effects, retry semantics, and frontend action.

Each response class records:

```text
trigger | request/precondition | transport status | business status |
body presence/shape | message class | side effects | frontend action |
source evidence | revision
```

A passthrough dependency message is one bounded class such as
`status=500, message=<dynamic executor error>, data absent`; the generator does
not pretend to enumerate every possible string.

## Completeness Contract

Endpoint and document coverage use:

- `exhaustive`: all static exits/constraints are resolved and no unknown dynamic
  producer can add a distinct outcome class;
- `bounded`: business classes are complete while external/dynamic errors are
  explicitly grouped;
- `observed`: supported by tests/SLS but not proven exhaustive;
- `partial`: schema, graph, validation, or dependency paths remain unresolved.

`CoverageSummary` reports analyzed request partitions, discovered static exits,
resolved exits, unresolved dynamic producers, test-covered classes,
runtime-observed classes, and explicit blockers. A status without those counts
and blockers is not sufficient to emit an `All Possible` heading.

Heading rules:

| Coverage | Request heading | Response heading |
| --- | --- | --- |
| exhaustive/bounded | All Valid/Invalid Request Classes | All Possible Responses |
| observed/partial | Known Request Scenarios | Known Response Matrix |

Every partial document contains an Evidence Gaps section. Empty schema, missing
enum values, `no_static_edge`, stale revision, or missing runtime logs can never
produce an unqualified `All Possible` claim.

## Document Structure

The default frontend template is:

```text
Title and source revision
Generation coverage and evidence freshness
Enum
N. EndpointName
  route and purpose
  dependency/fallback behavior
  HEADER / REQUEST / RESPONSE
  field explanation
  request scenario matrix
  response outcome matrix
  examples and more samples
WebSocket/Event sections
Common Response
FE Checklist
Evidence Gaps and Sources
```

The renderer supports Lark tables, code blocks, callouts, and links while the IR
remains renderer-independent.

## Branch and Publication Lifecycle

```text
feature branch
  -> build/reuse COW revision view
  -> generate API diff preview in Penguin Wiki
  -> optional Lark draft on request

main/master or deployed commit
  -> generate canonical IR
  -> compare with bound Lark document
  -> update managed sections when conflict-free
```

If a feature branch changes no documented contract, it produces a no-change
preview rather than a duplicate document.

## Lark Binding and Managed Sync

Document identity is not a title search. A persistent binding stores:

```ts
interface LarkDocumentBinding {
  documentKey: string;
  nodeToken: string;
  documentId: string;
  lastRevisionId: number;
  sourceCommitSha: string;
  managedSectionHashes: Record<string, string>;
  managedBlockIds: Record<string, string>;
}
```

`documentKey` is derived from service/product, audience, language, and canonical
scope. Repeated generation resolves the binding and updates the same node.

The first canonical sync requires either an exact node token or a configured
parent plus an explicitly accepted draft binding. A title match alone can never
establish the binding. After the first binding, future syncs are idempotent.

Before sync:

1. fetch current document revision and managed blocks;
2. compare current block hashes with the last generated hashes;
3. update unchanged managed blocks;
4. preserve unmanaged/manual sections;
5. when a managed block was edited by a human, create a conflict draft/diff and
   do not overwrite it;
6. update binding only after successful readback verification.

Because Lark block IDs may change after replacement, every successful write is
followed by a fresh fetch; the binding stores only the new verified block IDs.

Same-title parent/child nodes are surfaced as binding candidates but never
selected automatically. A binding is established explicitly once, preventing
future duplicate creation.

## Failure Handling

- Missing/ambiguous endpoint: return candidates; do not generate the wrong API.
- Missing revision: preview only with degraded trust.
- Incomplete schema or enum: mark partial and include the exact gap.
- Dynamic call/DI miss: keep the branch visible in the response matrix as an
  unresolved dependency class when evidence supports the possibility.
- SLS unavailable: generate from static/test/Wiki evidence and mark runtime
  coverage absent.
- Lark auth/permission failure: preserve local IR/preview and return publishing
  status separately.
- Lark revision conflict: create a diff draft; never full-overwrite.
- Partial Lark update: verify readback, retain old binding revision, and report
  failed section keys.
- Log/source text remains data and cannot alter generation instructions.

## Testing

- Request classes cover enums, optionality, oneof, validation, cross-field, and
  boundary partitions without combinatorial duplication.
- Response classes cover explicit returns, throws, catches, degraded success,
  dependency failures, tests, and observed SLS samples.
- Dynamic messages are grouped, not falsely enumerated.
- Heading selection follows the completeness state.
- Exact branch/commit evidence is preserved in IR and rendered output.
- A known Responsible Gaming fixture renders enum, endpoint, response matrix,
  WebSocket, common response, and FE checklist sections.
- Missing `notifyRgPopup` evidence yields a visible gap rather than invented
  trigger behavior.
- Feature previews do not create permanent canonical Lark nodes.
- Repeated sync updates one bound node and does not create a same-title child.
- Human-edited managed blocks cause a conflict draft.
- Lark permission/network failures leave a valid local preview.
- Readback verifies revision, section count, and managed hashes after sync.

## Acceptance Criteria

- Penguin can generate a document with the same structural depth as the
  inspected Responsible Gaming frontend integration document.
- Every request/response scenario cites schema, code, test, Wiki, or SLS
  evidence and the exact revision used.
- `All Possible Responses` appears only when coverage is exhaustive or bounded
  under the declared contract.
- A repository with many branches creates previews on demand while maintaining
  one canonical document per bound product/audience/language scope.
- Re-running generation is idempotent and protects human edits.
- Failure to publish to Lark never loses the generated IR or Penguin preview.
