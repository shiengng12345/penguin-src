# Penguin Evidence-Backed API Documentation Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate revision-correct frontend integration documentation from Penguin schema, code, tests, Wiki, and optional SLS evidence; preserve every scenario's provenance; preview feature-branch changes locally; and safely synchronize one explicitly bound Lark document without overwriting human content.

**Architecture:** A new `@penguin/api-doc-generator` package owns renderer-independent IR, request/response class analysis, evidence validation, coverage, rendering, managed-section parsing, and preview storage. The Knowledge CLI supplies revision-aware Penguin adapters and an optional runtime-evidence provider; Lark remains a host adapter invoked with argument arrays and stdin. Feature branches create local previews, while canonical default/deployed revisions may update explicitly bound Lark nodes through revision-aware block operations and a recoverable sync journal.

**Tech Stack:** TypeScript, Node 22, existing Penguin Knowledge/COW revision contracts, `@penguin/core` protobuf parsers, SHA-256, atomic JSON/Markdown/XML files, Lark CLI XML and block APIs, React/Tauri bridge, Node test runner.

## Global Constraints

- Canonical documentation comes from `main`/`master` or exact deployed commits. Per-repository `commits[repo]` wins; single `commitSha` is allowed only for one resolved repository and otherwise fails as ambiguous.
- Feature branches create Penguin previews by default. They never create a permanent canonical Lark page; an explicit user action may create an unbound Lark draft.
- One physical Knowledge database and the Branch Revision/COW plan's immutable revision views serve all repositories and branches. Do not create one code index per branch.
- A multi-repository document records one revision per participating repository. Never label the whole document with one repository's commit.
- Request coverage enumerates reachable equivalence classes, not every concrete value in an infinite domain and not an unconditional Cartesian product.
- Response coverage enumerates reachable outcome classes. Passthrough/external messages are grouped as dynamic classes rather than falsely enumerated strings.
- `All Valid/Invalid Request Classes` and `All Possible Responses` appear only when the coverage contract is `exhaustive` or `bounded`; otherwise render `Known Request Scenarios` / `Known Response Matrix` and an Evidence Gaps section.
- Every request/response scenario references resolvable schema, code, test, Wiki, SLS, or synthetic evidence and the exact revision that produced it.
- Empty response schema, missing enum/map metadata, unresolved `no_static_edge`, stale/degraded revision trust, unresolved dynamic producers, or unavailable requested runtime evidence lowers coverage. An empty result is never proof that an outcome does not exist.
- Generation never installs repository dependencies. Checked-in proto/source/declarations and lockfiles remain indexable without `pnpm i`; schema available only from an absent package artifact becomes `dependency_artifact_unavailable` and cannot support an `All ...` heading.
- The generator never replays state-changing business requests, calls mutation/verify RPCs for discovery, writes service databases, or treats log absence as proof of non-occurrence.
- Checked-in fixture, reviewed Wiki, observed SLS, then schema-valid synthetic is the example priority. Usable authorization values, cookies, passwords, API keys, and tokens are always replaced with explicit placeholders even when source evidence is sensitive.
- Raw source, Wiki, test, or log text is untrusted data. It cannot change selectors, publication mode, evidence policy, or tool instructions.
- The deterministic indexer never invokes an LLM, SLS, or Lark. Optional narrative synthesis is injected by the host and every generated claim must resolve allowed evidence IDs.
- Generated previews may be searched/displayed in Penguin Wiki, but generated prose is derived output and cannot recursively count as source evidence. Only reviewed source notes/evidence can raise future coverage.
- Lark identity is an explicit binding, never a title match. Same-title parent/child nodes remain candidates only.
- Lark sync fetches `detail=full`, uses the returned `revision_id`, applies block-level XML changes, refetches after writes, and updates bindings only after verified readback. It never calls whole-document `overwrite` for generated docs.
- Existing `src/components/docs/docs-lark.ts` remains the legacy manually authored Knowledge Base path. Generated-document sync must not route through its whole-document Markdown sentinel or `pushDocsToLark()`.
- Lark commands run as the authenticated user with argv arrays and stdin. Never interpolate node tokens, document text, or patterns into a shell command.
- A Lark network/permission/revision failure leaves valid local IR and preview files. A partial write leaves a recoverable journal and the previous verified binding revision.
- Run SQLite/native tests with Node `v22.22.1`. Do not run `pnpm install --no-frozen-lockfile`; update only explicit workspace importer entries.
- Preserve unrelated dirty-worktree changes. Every future commit stages only files named in its task.

---

## File Map

- Create: `packages/api-doc-generator/package.json` — workspace package metadata and the sole `@penguin/core` dependency.
- Create: `packages/api-doc-generator/tsconfig.json` — strict NodeNext library build.
- Create: `packages/api-doc-generator/src/types.ts` — documentation request, IR, scenario, evidence, revision, coverage, render, preview, and Lark-neutral contracts.
- Create: `packages/api-doc-generator/src/identity.ts` — stable document/revision/scenario keys and canonical serialization.
- Create: `packages/api-doc-generator/src/collector.ts` — revision-aware adapter interfaces and deterministic multi-source collection orchestration.
- Create: `packages/api-doc-generator/src/request-analyzer.ts` — request equivalence classes, boundaries, pairwise conditions, and deduplication.
- Create: `packages/api-doc-generator/src/response-analyzer.ts` — static/business/transport/dependency outcome classes and dynamic-message grouping.
- Create: `packages/api-doc-generator/src/evidence.ts` — evidence resolution, optional model-claim validation, example selection, and credential placeholdering.
- Create: `packages/api-doc-generator/src/coverage.ts` — coverage counts, blockers, level derivation, and heading gates.
- Create: `packages/api-doc-generator/src/generator.ts` — deterministic facts-to-IR assembly and final provenance/coverage validation.
- Create: `packages/api-doc-generator/src/markdown-renderer.ts` — stable generated Markdown and managed sections.
- Create: `packages/api-doc-generator/src/lark-xml-renderer.ts` — escaped Lark XML tables, code blocks, links, and gap callout.
- Create: `packages/api-doc-generator/src/managed-sections.ts` — stable marker parsing, canonical section hashes, and sync diff planning.
- Create: `packages/api-doc-generator/src/preview-store.ts` — atomic file-backed IR/render/diff previews and retention references.
- Create: `packages/api-doc-generator/src/index.ts` — public exports only.
- Modify: `packages/core/src/types.ts` — normalized protobuf field presence/map/oneof/default metadata.
- Modify: `packages/core/src/proto-parser.ts` — parity between raw proto and generated Connect/grpc-web declarations.
- Modify: `packages/core/src/sdk-parser.ts` — emit the same normalized field contract for SDK declarations.
- Modify: `packages/core/src/index.ts` — export normalized schema types/helpers.
- Modify: `packages/mcp/src/parse-services.ts` — report parser source/completeness without protocol-specific shape changes.
- Create: `packages/knowledge-cli/src/api-doc-collector.ts` — KnowledgeStore, `RevisionContext`, `CodeVersionResolver`, notes, tests, samples, and optional runtime adapter.
- Create: `packages/knowledge-cli/src/api-doc-command.ts` — `generate/list/show/diff/bind/draft/sync/repair` command family.
- Create: `packages/knowledge-cli/src/api-doc-binding-store.ts` — atomic explicit Lark bindings and legacy single-repo migration.
- Create: `packages/knowledge-cli/src/lark-document-client.ts` — typed `lark-cli docs` process adapter using argv/stdin.
- Create: `packages/knowledge-cli/src/api-doc-sync.ts` — serial revision-aware managed-section publication and journal recovery.
- Modify: `packages/knowledge-cli/src/index.ts` and `packages/knowledge-cli/src/bin.ts` — route the command family and inject paths/process/runtime dependencies.
- Modify: `packages/knowledge-cli/package.json`, root `package.json`, and `pnpm-lock.yaml` — workspace dependency and build order only.
- Modify: `src/lib/knowledge-client.ts` — generated preview/binding/sync result contracts.
- Modify: `src/components/docs/ApiDocsPage.tsx` — generated preview/diff/evidence panel beside the existing manual store.
- Modify: `src/components/wiki/WikiPage.tsx` — searchable generated-preview entry and revision/evidence routing without re-indexing derived prose as facts.
- Modify: `src-tauri/src/knowledge.rs` — safe CLI bridge commands for generated docs.
- Modify: `src-tauri/src/lib.rs` — register the generated-doc bridge command.
- Create: `tests/api-doc-ir.test.mjs` — identity and IR validation.
- Create: `tests/proto-schema-parity.test.mjs` — grpc/grpc-web/SDK schema parity and incompleteness reporting.
- Create: `tests/api-doc-collector.test.mjs` — ambiguity, revision, multi-repo, source, Wiki, and runtime collection.
- Create: `tests/api-doc-request-analyzer.test.mjs` — equivalence classes and bounded combinations.
- Create: `tests/api-doc-response-analyzer.test.mjs` — all outcome producer categories and dynamic grouping.
- Create: `tests/api-doc-evidence.test.mjs` — provenance, optional claims, examples, and credential replacement.
- Create: `tests/api-doc-coverage.test.mjs` — level and heading contract.
- Create: `tests/api-doc-generator.test.mjs` — complete fact-bundle to IR assembly, multi-repo provenance, and failure contracts.
- Create: `tests/api-doc-renderer.test.mjs` — Responsible Gaming Markdown/XML golden structure.
- Create: `tests/api-doc-preview-store.test.mjs` — atomic/idempotent/no-change/diff/retention behavior.
- Create: `tests/api-doc-binding-store.test.mjs` — explicit identity and same-title safety.
- Create: `tests/api-doc-lark-sync.test.mjs` — block lifecycle, conflict, partial journal, readback, and duplicate prevention.
- Create: `tests/api-doc-cli.test.mjs` — end-to-end CLI flow with fake Knowledge/runtime/Lark adapters.
- Modify: `tests/api-docs.test.mjs` — legacy manual sync remains isolated and generated panel is wired.
- Modify: `tests/wiki-page.test.mjs` — generated preview listing/search/open behavior and derived-evidence boundary.
- Create: `tests/fixtures/api-doc/responsible-gaming-facts.json` — schema/code/test/Wiki/runtime fixture with one intentional `notifyRgPopup` gap.
- Create: `tests/fixtures/api-doc/responsible-gaming.expected.md` and `responsible-gaming.expected.xml` — structural-depth goldens.
- Create: `docs/api-documentation-generator.md` — operator workflow, coverage semantics, branch policy, binding, conflicts, and recovery.

## Delivery Order

Tasks 1–2 establish stable IR and trustworthy schema. Tasks 3–7 collect/analyze evidence and gate completeness before any renderer can claim `All Possible`. Tasks 8–9 produce safe local artifacts and must work without Lark. Tasks 10–11 add explicit identity and recoverable block sync. Task 12 exposes the flow and runs acceptance verification. The Branch Revision/COW plan's Tasks 1–2 and 10 are prerequisites for exact historical/deployment trust; without them, this plan may generate degraded previews but must refuse canonical sync unless the caller supplies the explicit override defined in Task 12.

### Task 1: Scaffold the generator and lock the IR/identity contract

**Files:**
- Create: `packages/api-doc-generator/package.json`
- Create: `packages/api-doc-generator/tsconfig.json`
- Create: `packages/api-doc-generator/src/types.ts`
- Create: `packages/api-doc-generator/src/identity.ts`
- Create: `packages/api-doc-generator/src/index.ts`
- Create: `tests/api-doc-ir.test.mjs`

**Interfaces:**
- Consumes: normalized subject selectors, audience, language, revision selector, mode, and optional runtime scope.
- Produces: `DocumentationRequest`, `ApiDocumentationIR`, `validateDocumentationRequest()`, `canonicalJson()`, `createDocumentKey()`, `createRevisionSetHash()`, and `createScenarioId()` used by every later task.

- [ ] **Step 1: Write failing identity and IR validation tests**

Assert subject ordering, case-normalized audience/language, and branch/commit/runtime changes behave deliberately:

```js
assert.equal(createDocumentKey(base), createDocumentKey({ ...base, subjects: [...base.subjects].reverse() }));
assert.equal(createDocumentKey(base), createDocumentKey({ ...base, mode: "sync" }));
assert.equal(createDocumentKey(base), createDocumentKey({ ...base, revision: { branch: "feature/x" } }));
assert.notEqual(createDocumentKey(base), createDocumentKey({ ...base, audience: "operations" }));
assert.notEqual(createDocumentKey(base), createDocumentKey({ ...base, language: "pt-BR" }));
assert.notEqual(createDocumentKey(base), createDocumentKey({ ...base, subjects: [{ service: "OtherService" }] }));
assert.equal(validateDocumentationRequest({ ...base, subjects: [] }).ok, false);
assert.equal(validateDocumentationRequest({ ...base, includeRuntimeEvidence: true, runtimeScope: undefined }).ok, false);
```

Also assert two repositories produce one order-independent revision-set hash and that no raw branch/commit/title string becomes a filesystem path component.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-ir.test.mjs
```

Expected: FAIL because `@penguin/api-doc-generator` and its contracts do not exist.

- [ ] **Step 3: Create the package and strict build configuration**

Use this package boundary:

```json
{
  "name": "@penguin/api-doc-generator",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@penguin/core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.10.0"
  }
}
```

`tsconfig.json` uses `ES2022`, `NodeNext`, strict declarations, `rootDir: "src"`, and `outDir: "dist"`, matching `knowledge-cli`.

- [ ] **Step 4: Define the exact request, revision, evidence, scenario, and IR types**

Implement these public roots; endpoint/schema/scenario child interfaces in the same file must use only these names throughout later tasks:

```ts
export interface DocumentationSubject {
  repo?: string;
  service?: string;
  method?: string;
  route?: string;
}

export interface DocumentationRequest {
  subjects: DocumentationSubject[];
  revision: {
    branch?: string;
    branches?: Record<string, string>;
    commitSha?: string;
    commits?: Record<string, string>;
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

export interface DocumentationRevision {
  revisionId: string;
  repoId: string;
  repo: string;
  branch?: string;
  commitSha: string;
  snapshotId?: string;
  mergeBaseSha?: string;
  worktreeFingerprint?: string;
  trust: "exact_commit" | "exact_worktree" | "fallback_live" | "trust_unavailable";
  resolutionSource:
    | "commit" | "log_commit" | "deployment" | "indexed_commit"
    | "environment_branch" | "branch" | "worktree" | "live_fallback";
  degradationReason?: string;
}

export interface EvidenceRef {
  evidenceId: string;
  source: "schema" | "code" | "test" | "wiki" | "sls" | "synthetic";
  revisionId?: string;
  locator: string;
  excerpt?: string;
  status: "verified" | "reviewed" | "observed" | "synthetic" | "inference";
  freshness?: "fresh" | "stale" | "trust_unavailable";
  targetId?: string;
  observedAt?: string;
}

export type CoverageLevel = "exhaustive" | "bounded" | "observed" | "partial";

export interface EvidenceGap {
  gapId: string;
  code: string;
  message: string;
  endpointKey?: string;
  fieldPath?: string;
  producerId?: string;
  revisionId?: string;
  evidenceIds: string[];
}

export interface SchemaFieldDoc {
  path: string;
  name: string;
  type: string;
  presence: "required" | "optional" | "implicit";
  repeated: boolean;
  description?: string;
  units?: string;
  format?: string;
  defaultValue?: string | number | boolean;
  enumRef?: string;
  map?: { keyType: string; valueType: string };
  oneof?: string;
  fields?: SchemaFieldDoc[];
  evidenceIds: string[];
}

export interface EnumDoc {
  name: string;
  revisionId: string;
  values: Array<{ name: string; number?: number; description?: string }>;
  evidenceIds: string[];
}

export interface ExampleDoc {
  exampleId: string;
  origin: "test" | "wiki" | "sls" | "synthetic";
  synthetic: boolean;
  label: string;
  value: unknown;
  revisionId?: string;
  targetId?: string;
  observedAt?: string;
  evidenceIds: string[];
}

export interface RequestClass {
  scenarioId: string;
  scenario: string;
  headers: string[];
  bodyPartitions: string[];
  preconditions: string[];
  validity: "valid" | "invalid";
  expectedOutcomeClassIds: string[];
  sideEffectRisk: "none" | "read" | "write" | "unknown";
  evidenceIds: string[];
  coverage: CoverageLevel;
}

export interface ResponseClass {
  outcomeClassId: string;
  trigger: string;
  requestClassIds: string[];
  preconditions: string[];
  transport: { protocol: string; status?: string | number };
  businessStatus?: string | number;
  bodyPresence: "present" | "absent" | "conditional";
  bodyShape?: string;
  messageClass: {
    kind: "exact" | "static_set" | "dynamic_dependency";
    values?: string[];
    pattern?: string;
    producer?: string;
  };
  sideEffects: string[];
  retry: "safe" | "unsafe" | "conditional" | "unknown";
  frontendAction?: string;
  revisionId: string;
  evidenceIds: string[];
  examples: ExampleDoc[];
  coverage: CoverageLevel;
}

export interface EndpointDoc {
  endpointKey: string;
  revisionId: string;
  service: string;
  method: string;
  route: string;
  protocol: string;
  description: string;
  dependencies: string[];
  headers: Array<{ name: string; required: boolean; description: string; evidenceIds: string[] }>;
  requestSchema: SchemaFieldDoc[];
  responseSchema: SchemaFieldDoc[];
  requestClasses: RequestClass[];
  responseClasses: ResponseClass[];
  examples: ExampleDoc[];
  frontendGuidance: string[];
  evidenceIds: string[];
  gaps: EvidenceGap[];
  coverage: CoverageSummary;
}

export interface EventDoc {
  eventKey: string;
  revisionId: string;
  name: string;
  direction: "client_to_server" | "server_to_client" | "bidirectional";
  payloadSchema: SchemaFieldDoc[];
  behavior: string;
  evidenceIds: string[];
  gaps: EvidenceGap[];
}

export interface ChecklistItem {
  key: string;
  text: string;
  evidenceIds: string[];
}

export interface CoverageSummary {
  level: CoverageLevel;
  analyzedRequestPartitions: number;
  unresolvedRequestConstraints: number;
  discoveredStaticExits: number;
  resolvedStaticExits: number;
  unresolvedDynamicProducers: number;
  groupedDynamicProducers: number;
  testCoveredClasses: number;
  runtimeObservedClasses: number;
  runtimeEvidenceState: "available" | "not_requested" | "unavailable" | "partial";
  blockers: EvidenceGap[];
}

export interface ApiDocumentationIR {
  documentKey: string;
  title: string;
  revisions: DocumentationRevision[];
  enums: EnumDoc[];
  endpoints: EndpointDoc[];
  websocketEvents: EventDoc[];
  commonResponses: ResponseClass[];
  frontendChecklist: ChecklistItem[];
  evidence: EvidenceRef[];
  gaps: EvidenceGap[];
  coverage: CoverageSummary;
}

export interface DocumentationRequestValidation {
  ok: boolean;
  request?: DocumentationRequest;
  errors: Array<{ path: string; code: string; message: string }>;
}

export function validateDocumentationRequest(input: unknown): DocumentationRequestValidation;
export function canonicalJson(input: unknown): string;
export function createDocumentKey(request: DocumentationRequest): string;
export function createRevisionSetHash(revisions: DocumentationRevision[]): string;
export function createScenarioId(input: {
  endpointKey: string;
  kind: "request" | "response";
  partitions: string[];
  preconditions: string[];
}): string;
```

Every evidence-bearing object has `evidenceIds: string[]`; every endpoint/event/enum revision ID must reference one entry in `revisions`.

- [ ] **Step 5: Implement stable canonical identities**

`validateDocumentationRequest()` rejects unknown keys, empty subjects, conflicting single/multi-repo selectors, non-BCP-47 language tags, malformed runtime windows, and `includeRuntimeEvidence: true` without a runtime scope. `createDocumentKey()` canonicalizes sorted subjects plus audience and BCP-47 language, but deliberately omits title, mode, branch, commit, target, timestamp, and runtime window. Return `api-doc:v1:<audience>:<language>:<16-hex-sha256>`. `createRevisionSetHash()` hashes sorted `(repoId, repo, commitSha, snapshotId, worktreeFingerprint)` records and requires a fingerprint for `exact_worktree`. `createScenarioId()` hashes endpoint key, scenario kind, canonical partitions, and preconditions. Use recursive key sorting and reject non-finite numbers/undefined object properties before hashing.

- [ ] **Step 6: Run GREEN verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-ir.test.mjs
```

Expected: package build PASS and all identity/validation assertions PASS.

- [ ] **Step 7: Commit the IR boundary**

```bash
rtk git add packages/api-doc-generator/package.json packages/api-doc-generator/tsconfig.json packages/api-doc-generator/src/types.ts packages/api-doc-generator/src/identity.ts packages/api-doc-generator/src/index.ts tests/api-doc-ir.test.mjs
rtk git commit -m "feat(api-docs): define evidence-backed documentation IR"
```

### Task 2: Normalize grpc, grpc-web, and SDK schema metadata

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/proto-parser.ts`
- Modify: `packages/core/src/sdk-parser.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/mcp/src/parse-services.ts`
- Create: `tests/proto-schema-parity.test.mjs`
- Modify: `tests/proto-parser-nested.test.mjs`

**Interfaces:**
- Consumes: raw `.proto`, protobuf-es `*_pb.d.ts`/`*_connect.d.ts`, and SDK declaration files.
- Produces: one `FieldInfo` contract with explicit presence, map key/value, oneof, enum values/numbers, defaults, field number/json name, parser source, and schema gaps.

- [ ] **Step 1: Write failing parity fixtures and assertions**

Describe the same service once as raw proto and once as generated declarations. Include `optional string`, implicit scalar, nested message, repeated enum, `map<string, Value>`, oneof, explicit proto2 default, and a 260-value enum. Assert deep equality after removing `schemaSource`:

```js
assert.deepEqual(normalize(rawMethod.requestFields), normalize(generatedMethod.requestFields));
assert.equal(field(rawMethod, "nickname").presence, "optional");
assert.equal(field(rawMethod, "platformId").presence, "implicit");
assert.deepEqual(field(rawMethod, "labels").map, { keyType: "string", valueType: "Value", valueFields: expectedValueFields });
assert.equal(field(rawMethod, "email").oneof, "identity");
assert.deepEqual(field(generatedMethod, "status").enumValues.slice(0, 2), ["STATUS_UNSPECIFIED", "STATUS_SUCCESS"]);
assert.equal(field(generatedMethod, "status").enumValues.length, 260);
assert.equal(methodSchemaCompleteness(generatedMethod).gaps.length, 0);
```

Add a deliberately incomplete generated declaration and assert exact gaps `enum_values_missing` and `map_value_type_missing`; do not silently mark it complete.

Add a package present only in `package.json`/`pnpm-lock.yaml` with no checked-in or installed declaration artifact; assert discovery remains side-effect free and returns `dependency_artifact_unavailable` instead of running an install or claiming an empty complete schema.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/core build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/proto-schema-parity.test.mjs tests/proto-parser-nested.test.mjs
```

Expected: FAIL because `FieldInfo` lacks normalized metadata and generated declarations lose enum/map/oneof information.

- [ ] **Step 3: Extend `FieldInfo` without breaking existing callers**

Keep `name`, `type`, `repeated`, `optional`, `fields`, and `enumValues`; add optional normalized fields so existing UI/call clients compile during migration:

```ts
export interface FieldInfo {
  name: string;
  type: string;
  repeated: boolean;
  optional: boolean;
  presence?: "required" | "optional" | "implicit";
  fields?: FieldInfo[];
  enumValues?: string[];
  enumNumbers?: Record<string, number>;
  map?: {
    keyType: string;
    valueType: string;
    valueFields?: FieldInfo[];
    valueEnumValues?: string[];
  };
  oneof?: string;
  defaultValue?: string | number | boolean;
  fieldNumber?: number;
  jsonName?: string;
  schemaSource?: "raw_proto" | "generated_dts" | "sdk_dts";
  schemaGaps?: string[];
}
```

Export `methodSchemaCompleteness(method: ProtoMethod): { complete: boolean; gaps: SchemaGap[] }`; a gap includes `code`, `fieldPath`, and `schemaSource`.

```ts
export interface SchemaGap {
  code:
    | "request_schema_empty" | "response_schema_empty" | "enum_values_missing"
    | "map_value_type_missing" | "oneof_metadata_missing" | "presence_unknown"
    | "dependency_artifact_unavailable";
  fieldPath: string;
  schemaSource: "raw_proto" | "generated_dts" | "sdk_dts";
}
```

- [ ] **Step 4: Populate complete metadata from raw proto reflection**

Use protobuf reflection for enum names/numbers, field number, resolved nested type, map key/value, oneof membership, and declared default. Derive presence as `required` for required fields, `optional` only for explicit optional/message/oneof presence, and `implicit` for proto3 scalar presence. Preserve declaration order and apply the existing cycle guard.

- [ ] **Step 5: Parse generated declarations to parity**

Extend the declaration parser to collect generated enum declarations, field annotations, map generic arguments, oneof/case unions, optional markers, field numbers, and defaults before resolving messages. Resolve map value messages/enums through the same message/enum maps used for ordinary fields. When generated declarations genuinely omit metadata, attach `schemaGaps` instead of inventing values.

- [ ] **Step 6: Align SDK declarations and MCP reporting**

`sdk-parser.ts` emits `presence`, `map`, `schemaSource: "sdk_dts"`, and gaps when a `Record`/object value type is unknown. `parseServicesForPackage()` keeps one return shape for every protocol and does not rewrite `optional`; MCP `describe_method` surfaces the normalized fields plus a `schemaCompleteness` object. If a package is declared in a manifest/lockfile but its schema artifact is not checked in or installed, return `dependency_artifact_unavailable`; never install it or report an empty schema as complete. Keep full enum values in the data contract; later renderers summarize display while preserving machine-readable values.

- [ ] **Step 7: Keep default JSON schema-valid**

Update `generateDefaultJson()` so enum uses the first declared value, map uses `{}`, oneof emits no member until one branch is explicitly selected, and optional fields are omitted by default. Add assertions proving unknown enum/map metadata creates a gap rather than `null` in a body advertised as valid.

- [ ] **Step 8: Run GREEN and compatibility verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/core build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/mcp build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/proto-schema-parity.test.mjs tests/proto-parser-nested.test.mjs
```

Expected: parity fixtures PASS, incomplete declarations expose exact gaps, nested parser regressions PASS, and MCP builds with the extended contract.

- [ ] **Step 9: Commit normalized schema parity**

```bash
rtk git add packages/core/src/types.ts packages/core/src/proto-parser.ts packages/core/src/sdk-parser.ts packages/core/src/index.ts packages/mcp/src/parse-services.ts tests/proto-schema-parity.test.mjs tests/proto-parser-nested.test.mjs
rtk git commit -m "fix(schema): normalize grpc and grpc-web field metadata"
```

### Task 3: Collect exact multi-repository facts and provenance

**Files:**
- Create: `packages/api-doc-generator/src/collector.ts`
- Modify: `packages/api-doc-generator/src/types.ts`
- Modify: `packages/api-doc-generator/src/index.ts`
- Create: `packages/knowledge-cli/src/api-doc-collector.ts`
- Modify: `packages/knowledge-cli/package.json`
- Modify: root `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `tests/api-doc-collector.test.mjs`

**Interfaces:**
- Consumes: `DocumentationRequest`, Penguin subject candidates, `RevisionContext`, optional `CodeVersionResolver`, notes/tests/samples, and optional runtime evidence.
- Produces: `DocumentationFactBundle` containing endpoint/schema/constraint/producer/event/checklist facts, exact revisions, evidence refs, and explicit gaps.

- [ ] **Step 1: Write failing subject/revision/source tests**

Use two fake repositories where frontend route and backend handler live at different commits. Assert per-repo exact commits win, a lone `commitSha` is rejected for two repos, deployment time resolves both repos, ambiguity returns candidates, feature branch stays preview-only, and unavailable runtime becomes a gap:

```js
assert.deepEqual(bundle.revisions.map((r) => [r.repo, r.commitSha]).sort(), [["auth", "a2"], ["fpmsnt", "f7"]]);
assert.equal(bundle.endpoints[0].revisionId, revisionFor(bundle, "fpmsnt").revisionId);
assert.ok(bundle.evidence.every((e) => !e.revisionId || bundle.revisions.some((r) => r.revisionId === e.revisionId)));
assert.equal(ambiguous.status, "ambiguous_subject");
assert.deepEqual(ambiguous.candidates.map((c) => c.identityKey).sort(), expectedCandidates);
assert.ok(noRuntime.gaps.some((g) => g.code === "runtime_evidence_unavailable"));
assert.ok(diMiss.gaps.some((g) => g.code === "no_static_edge"));
assert.equal(await collectDocumentationFacts({ ...request, revision: { commitSha: "a2" } }, adapter).status, "ambiguous_revision");
```

Also assert missing `notifyRgPopup` becomes a gap and that SLS observation proves occurrence only, never exhaustiveness.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-collector.test.mjs
```

Expected: FAIL because collection contracts and the Knowledge adapter do not exist.

- [ ] **Step 3: Define the adapter and fact contracts**

Use one injected boundary; the pure package never opens SQLite, Git, SLS, or Lark:

```ts
export interface ResolvedSubject {
  subjectId: string;
  identityKey: string;
  repoId: string;
  repo: string;
  endpointKey: string;
  service: string;
  method: string;
  route: string;
  protocol: string;
}

export type SubjectResolution =
  | { status: "resolved"; subjects: ResolvedSubject[] }
  | { status: "ambiguous_subject"; candidates: ResolvedSubject[]; reason: string }
  | { status: "not_found"; candidates: ResolvedSubject[]; reason: string };

export interface EndpointFact {
  endpointKey: string;
  revisionId: string;
  service: string;
  method: string;
  route: string;
  protocol: string;
  description?: string;
  requestFields: SchemaFieldDoc[];
  responseFields: SchemaFieldDoc[];
  enums: EnumDoc[];
  schemaGaps: EvidenceGap[];
  evidenceIds: string[];
}

export type RequestConstraintKind =
  | "header" | "auth" | "routing" | "presence" | "type" | "enum"
  | "oneof" | "repeated" | "map" | "range" | "format" | "cross_field"
  | "state" | "idempotency";

export interface RequestConstraintFact {
  constraintId: string;
  endpointKey: string;
  kind: RequestConstraintKind;
  fieldPath?: string;
  description: string;
  validPartitions: string[];
  invalidPartitions: string[];
  preconditions: string[];
  expectedOutcomeClassIds: string[];
  sideEffectRisk: "none" | "read" | "write" | "unknown";
  evidenceIds: string[];
}

export type ResponseProducerKind =
  | "explicit_return" | "business_branch" | "validation_failure"
  | "transport_throw" | "catch" | "fallback" | "degraded_success"
  | "dependency_failure" | "state_outcome" | "test" | "runtime";

export interface ResponseProducerFact {
  producerId: string;
  endpointKey: string;
  kind: ResponseProducerKind;
  trigger: string;
  requestClassIds: string[];
  preconditions: string[];
  transport: { protocol: string; status?: string | number };
  businessStatus?: string | number;
  bodyPresence: "present" | "absent" | "conditional";
  bodyShape?: string;
  messageClass: {
    kind: "exact" | "static_set" | "dynamic_dependency";
    values?: string[];
    pattern?: string;
    producer?: string;
  };
  sideEffects: string[];
  retry: "safe" | "unsafe" | "conditional" | "unknown";
  frontendAction?: string;
  revisionId: string;
  evidenceIds: string[];
}

export interface CodeBehaviorFact {
  factId: string;
  kind: "guard" | "validator" | "return" | "throw" | "catch" | "fallback" | "dependency" | "side_effect" | "frontend_guidance";
  statement: string;
  revisionId: string;
  constraintIds: string[];
  producerIds: string[];
  evidenceIds: string[];
}

export interface TestFact {
  factId: string;
  revisionId: string;
  coveredConstraintIds: string[];
  coveredProducerIds: string[];
  examples: ExampleDoc[];
  evidenceIds: string[];
}

export interface WikiFact {
  factId: string;
  revisionId?: string;
  status: "reviewed" | "draft" | "stale";
  statement: string;
  examples: ExampleDoc[];
  evidenceIds: string[];
}

export interface EventFact {
  eventKey: string;
  revisionId: string;
  name: string;
  direction: EventDoc["direction"];
  payloadFields: SchemaFieldDoc[];
  behavior?: string;
  evidenceIds: string[];
}

export interface ChecklistFact {
  key: string;
  text: string;
  endpointKey?: string;
  revisionId?: string;
  evidenceIds: string[];
}

export interface RuntimeEvidenceObservation {
  observationId: string;
  targetId: string;
  observedAt: string;
  endpointKey?: string;
  requestClassId?: string;
  responseClassId?: string;
  payload: unknown;
  evidenceIds: string[];
}

export interface RuntimeEvidenceResult {
  status: "available" | "partial" | "unavailable";
  observations: RuntimeEvidenceObservation[];
  evidence: EvidenceRef[];
  gaps: EvidenceGap[];
}

export interface RuntimeEvidenceProvider {
  collect(input: {
    request: DocumentationRequest;
    subjects: ResolvedSubject[];
    revisions: DocumentationRevision[];
  }): Promise<RuntimeEvidenceResult>;
}

export interface DocumentationFactBundle {
  request: DocumentationRequest;
  subjects: ResolvedSubject[];
  revisions: DocumentationRevision[];
  endpoints: EndpointFact[];
  requestConstraints: RequestConstraintFact[];
  responseProducers: ResponseProducerFact[];
  codeFacts: CodeBehaviorFact[];
  testFacts: TestFact[];
  wikiFacts: WikiFact[];
  eventFacts: EventFact[];
  checklistFacts: ChecklistFact[];
  runtime: RuntimeEvidenceResult;
  evidence: EvidenceRef[];
  gaps: EvidenceGap[];
}

export type DocumentationCollectionResult =
  | { status: "collected"; bundle: DocumentationFactBundle }
  | { status: "ambiguous_subject"; candidates: ResolvedSubject[]; reason: string }
  | { status: "ambiguous_revision"; repos: string[]; reason: string }
  | { status: "not_found"; candidates: ResolvedSubject[]; reason: string };

export interface DocumentationSourceAdapter {
  resolveSubjects(subjects: DocumentationSubject[]): Promise<SubjectResolution>;
  resolveRevisions(request: DocumentationRequest, subjects: ResolvedSubject[]): Promise<DocumentationRevision[]>;
  collectEndpoint(subject: ResolvedSubject, revision: DocumentationRevision): Promise<EndpointFact>;
  collectRequestConstraints(subject: ResolvedSubject, revision: DocumentationRevision): Promise<RequestConstraintFact[]>;
  collectResponseProducers(subject: ResolvedSubject, revision: DocumentationRevision): Promise<ResponseProducerFact[]>;
  collectCodeFacts(subject: ResolvedSubject, revision: DocumentationRevision): Promise<CodeBehaviorFact[]>;
  collectTestFacts(subject: ResolvedSubject, revision: DocumentationRevision): Promise<TestFact[]>;
  collectWikiFacts(subject: ResolvedSubject, revision: DocumentationRevision): Promise<WikiFact[]>;
  collectEvents(subject: ResolvedSubject, revision: DocumentationRevision): Promise<EventFact[]>;
  collectChecklistFacts(subject: ResolvedSubject, revision: DocumentationRevision): Promise<ChecklistFact[]>;
  collectRuntimeEvidence?(request: DocumentationRequest, subjects: ResolvedSubject[], revisions: DocumentationRevision[]): Promise<RuntimeEvidenceResult>;
}

export async function collectDocumentationFacts(
  request: DocumentationRequest,
  adapter: DocumentationSourceAdapter,
): Promise<DocumentationCollectionResult>;
```

`DocumentationCollectionResult` is a discriminated union for `collected`, `ambiguous_subject`, `ambiguous_revision`, and `not_found`; wrong candidates are never selected by score alone. Resolve each repository in this order: `commits[repo]`, one-repo `commitSha`, target/deployment timestamp, `branches[repo]`, shared `branch`, then default/live fallback with degraded trust.

- [ ] **Step 4: Implement deterministic collection order and evidence IDs**

Resolve subjects, then revisions, then endpoint/enums/request constraints/response producers/code/test/Wiki/events/checklists, and runtime last. Every fact is normalized into an evidence ref immediately; evidence IDs hash source, exact locator, revision ID, and canonical payload. Merge duplicate endpoint identities only when their protocol/route/schema facts agree; otherwise return an ambiguity gap rather than selecting one. Keep facts, inferences, and gaps separate. Preserve empty response schema, stale note, graph misses, and missing test/runtime as explicit gap codes.

- [ ] **Step 5: Wire the workspace dependency before its first consumer**

Add `@penguin/api-doc-generator: workspace:*` to `knowledge-cli`, add `packages/api-doc-generator` plus the `link:../api-doc-generator` knowledge-cli importer entry in `pnpm-lock.yaml`, and build `@penguin/api-doc-generator` after core and before knowledge-cli in root `build` and `typecheck`. Do not run a lockfile-rewriting install.

- [ ] **Step 6: Build the Knowledge CLI adapter**

Implement `KnowledgeApiDocCollector` with injected dependencies rather than direct globals:

```ts
export interface KnowledgeApiDocCollectorDeps {
  store: KnowledgeStore;
  codeVersionResolver?: CodeVersionResolver;
  runtimeEvidenceProvider?: RuntimeEvidenceProvider;
  readSourceAtRevision(input: { repoId: string; commitSha: string; filePath: string }): Promise<string | null>;
}

export class KnowledgeApiDocCollector implements DocumentationSourceAdapter {
  constructor(deps: KnowledgeApiDocCollectorDeps);
}
```

Use exact endpoint/symbol identity keys, revision-scoped search/context/graph calls, typed notes, source/test links, endpoint response samples, and deployment mapping. `no_static_edge` does not suppress DI/HTTP/dynamic possibilities. If Branch Revision/COW contracts are unavailable during staged rollout, emit `trust_unavailable` and allow preview only.

- [ ] **Step 7: Normalize optional runtime evidence without package coupling**

Use the `RuntimeEvidenceProvider.collect()` contract from Step 3. Its result mirrors the SLS plan's target/provenance/facts/gaps contract but lives behind the adapter, so `knowledge-cli` does not import MCP. Existing indexed evidence notes may satisfy observed examples; a host can inject a live sibling-MCP provider. Per-target failures remain separate and lower runtime coverage.

- [ ] **Step 8: Run GREEN verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-cli build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-collector.test.mjs
```

Expected: PASS for exact/deployed/feature/degraded selectors, two-repo revisions, ambiguity, all evidence origins, and runtime partial failure.

- [ ] **Step 9: Commit revision-aware collection**

```bash
rtk git add packages/api-doc-generator/src/collector.ts packages/api-doc-generator/src/types.ts packages/api-doc-generator/src/index.ts packages/knowledge-cli/src/api-doc-collector.ts packages/knowledge-cli/package.json package.json pnpm-lock.yaml tests/api-doc-collector.test.mjs
rtk git commit -m "feat(api-docs): collect revision-aware knowledge evidence"
```

### Task 4: Enumerate bounded request equivalence classes

**Files:**
- Create: `packages/api-doc-generator/src/request-analyzer.ts`
- Modify: `packages/api-doc-generator/src/types.ts`
- Modify: `packages/api-doc-generator/src/index.ts`
- Create: `tests/api-doc-request-analyzer.test.mjs`

**Interfaces:**
- Consumes: normalized request schema, headers/auth/routing facts, validation constraints, cross-field/state rules, idempotency, and evidence IDs.
- Produces: `RequestClassAnalysis` with valid/invalid classes, covered constraints, unresolved constraints, and a bounded generation count.

- [ ] **Step 1: Write failing enum/oneof/boundary/cross-field tests**

Use a request with auth header, environment header, optional amount, a three-value enum, oneof email/phone, range `1..100`, cross-field `schedule=true -> startAt required`, and a side-effecting submit direction. Assert:

```js
assert.ok(analysis.classes.some((c) => c.validity === "invalid" && c.bodyPartitions.includes("amount:below_min")));
assert.ok(analysis.classes.some((c) => c.bodyPartitions.includes("method:unknown_enum")));
assert.equal(analysis.classes.filter((c) => c.bodyPartitions.includes("identity:both_oneof_members")).length, 1);
assert.ok(analysis.classes.some((c) => c.preconditions.includes("schedule=true") && c.bodyPartitions.includes("startAt:missing")));
assert.ok(analysis.classes.every((c) => c.evidenceIds.length > 0));
assert.ok(analysis.classes.length < 30, "must not expand the full Cartesian product");
assert.equal(new Set(analysis.classes.map((c) => c.scenarioId)).size, analysis.classes.length);
```

Also assert map/repeated empty vs populated, malformed format, zero/negative/min/max, and idempotent vs non-idempotent direction classes.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-request-analyzer.test.mjs
```

Expected: FAIL because no request analyzer exists.

- [ ] **Step 3: Define constraint and analysis contracts**

Reuse the `RequestConstraintFact` contract collected in Task 3 and add only the analysis boundary:

```ts
export interface RequestClassAnalysis {
  classes: RequestClass[];
  analyzedConstraintIds: string[];
  unresolvedConstraintIds: string[];
  generationStrategy: "equivalence_boundary_pairwise";
}

export interface RequestAnalysisInput {
  endpoint: EndpointFact;
  constraints: RequestConstraintFact[];
  defaultExpectedOutcomeClassIds: string[];
}

export function analyzeRequestClasses(input: RequestAnalysisInput): RequestClassAnalysis;
```

- [ ] **Step 4: Implement the bounded partition algorithm**

Create one canonical valid baseline for each semantically distinct oneof/state/side-effect direction. For each independent constraint, create one negative class that changes only that partition. Add min/max/inside and below/above boundaries, empty/populated collection classes, unknown enum, missing required headers/auth/routing, and explicitly declared cross-field pairs. Do not cross unrelated independent invalid partitions.

- [ ] **Step 5: Deduplicate and retain traceability**

Canonicalize headers, body partitions, preconditions, validity, expected outcomes, and side-effect risk into `createScenarioId()`. Merge evidence IDs for duplicate semantics. If a manual validator cannot be converted into partitions, retain an unresolved constraint and gap; never silently drop it.

- [ ] **Step 6: Run GREEN verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-request-analyzer.test.mjs
```

Expected: PASS with every declared partition represented, no duplicate scenario IDs, and no combinatorial explosion.

- [ ] **Step 7: Commit request class analysis**

```bash
rtk git add packages/api-doc-generator/src/request-analyzer.ts packages/api-doc-generator/src/types.ts packages/api-doc-generator/src/index.ts tests/api-doc-request-analyzer.test.mjs
rtk git commit -m "feat(api-docs): enumerate bounded request classes"
```

### Task 5: Enumerate response outcome classes without false infinity

**Files:**
- Create: `packages/api-doc-generator/src/response-analyzer.ts`
- Modify: `packages/api-doc-generator/src/types.ts`
- Modify: `packages/api-doc-generator/src/index.ts`
- Create: `tests/api-doc-response-analyzer.test.mjs`

**Interfaces:**
- Consumes: explicit returns, validation failures, throws, catches, fallbacks, downstream producers, state branches, tests, runtime observations, side effects, and frontend guidance.
- Produces: `ResponseClassAnalysis` with deduplicated outcome classes, producer coverage, dynamic groups, and unresolved producers.

- [ ] **Step 1: Write failing outcome-producer tests**

Build one endpoint fixture with successful return, business rejection, transport validation error, caught dependency error, degraded success, state conflict, test-only outcome, SLS-observed sample, and dynamic executor messages. Assert:

```js
assert.ok(byTrigger(analysis, "explicit_return"));
assert.ok(byTrigger(analysis, "validation_failure"));
assert.ok(byTrigger(analysis, "degraded_success"));
assert.ok(byTrigger(analysis, "state_conflict"));
assert.equal(analysis.classes.filter((c) => c.messageClass.kind === "dynamic_dependency").length, 1);
assert.equal(dynamic(analysis).messageClass.pattern, "<dynamic executor error>");
assert.equal(dynamic(analysis).bodyPresence, "absent");
assert.ok(analysis.classes.every((c) => c.revisionId && c.evidenceIds.length > 0));
assert.ok(analysis.unresolvedProducerIds.includes("reflection:notifyRgPopup"));
```

Add two outcomes that share HTTP/gRPC transport status but have different business status/side effects and assert they remain distinct. Add two runtime messages from the same producer and assert they merge as observations under one class.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-response-analyzer.test.mjs
```

Expected: FAIL because no response analyzer exists.

- [ ] **Step 3: Define producer, message, and outcome contracts**

Reuse the `ResponseProducerFact` contract collected in Task 3 and add only the analysis boundary:

```ts
export interface ResponseClassAnalysis {
  classes: ResponseClass[];
  discoveredProducerIds: string[];
  resolvedProducerIds: string[];
  unresolvedProducerIds: string[];
  dynamicProducerIds: string[];
}

export interface ResponseAnalysisInput {
  endpoint: EndpointFact;
  requestClasses: RequestClass[];
  producers: ResponseProducerFact[];
  testFacts: TestFact[];
  runtimeObservations: RuntimeEvidenceObservation[];
}

export function analyzeResponseClasses(input: ResponseAnalysisInput): ResponseClassAnalysis;
```

- [ ] **Step 4: Normalize transport and business status separately**

Never reuse MCP's ambiguous cross-protocol `statusCode`. Store protocol plus transport status (`HTTP 200`, `gRPC OK`, `gRPC INVALID_ARGUMENT`) separately from body/business status. Include body presence/shape, side effects, retry semantics, and frontend action in the outcome identity.

- [ ] **Step 5: Group only messages proven to share one producer**

Merge dynamic strings only when evidence points to the same downstream producer, catch/fallback branch, transport/business/body shape, and side-effect semantics. Represent them as one bounded class such as `status=500, message=<dynamic executor error>, data absent`. Different producers or retry/side-effect semantics remain different classes.

- [ ] **Step 6: Reconcile static, test, and runtime evidence**

Static exits define candidate classes; tests and SLS add coverage/evidence to matching classes or create `observed` classes when no static producer resolves. An observed class never resolves an unrelated static producer. Preserve unresolved DI/reflection/HTTP dispatch as producer IDs and gaps.

- [ ] **Step 7: Run GREEN verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-response-analyzer.test.mjs
```

Expected: PASS for all ten producer categories, status separation, dynamic grouping, observation merging, and unresolved-producer retention.

- [ ] **Step 8: Commit response outcome analysis**

```bash
rtk git add packages/api-doc-generator/src/response-analyzer.ts packages/api-doc-generator/src/types.ts packages/api-doc-generator/src/index.ts tests/api-doc-response-analyzer.test.mjs
rtk git commit -m "feat(api-docs): classify reachable response outcomes"
```

### Task 6: Validate evidence-backed claims and select safe examples

**Files:**
- Create: `packages/api-doc-generator/src/evidence.ts`
- Modify: `packages/api-doc-generator/src/types.ts`
- Modify: `packages/api-doc-generator/src/index.ts`
- Create: `tests/api-doc-evidence.test.mjs`

**Interfaces:**
- Consumes: collected facts, request/response classes, evidence registry, optional structured model claims, and candidate examples.
- Produces: resolved facts/inferences/gaps, provenance-complete scenarios, and one labelled/sanitized example set per scenario.

- [ ] **Step 1: Write failing provenance/model/example tests**

Assert missing evidence IDs, wrong-revision evidence, hostile log instructions, and raw secrets cannot become verified output:

```js
assert.equal(validateEvidenceReferences(irWithMissingEvidence).ok, false);
assert.equal(resolveCandidateClaims([{ claimId: "c1", text: "verified", evidenceIds: ["missing"], requestedStatus: "fact" }], evidence).claims[0].status, "inference");
assert.ok(resolveCandidateClaims(hostileLogClaim, evidence).gaps.some((g) => g.code === "unresolved_generated_claim"));
assert.equal(selectExamples(candidates).selected[0].origin, "test");
assert.match(JSON.stringify(sanitizeExample(secretExample)), /<AUTHORIZATION_TOKEN>/);
assert.doesNotMatch(JSON.stringify(sanitizeExample(secretExample)), /eyJ[a-zA-Z0-9_-]+\./);
```

Also assert reviewed Wiki beats SLS, SLS beats synthetic, every synthetic example is schema-valid, PII not used as a credential placeholder, and one scenario can retain several labelled samples without changing its outcome identity.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-evidence.test.mjs
```

Expected: FAIL because evidence resolution and example selection do not exist.

- [ ] **Step 3: Define optional synthesis and validation contracts**

```ts
export interface CandidateClaim {
  claimId: string;
  text: string;
  evidenceIds: string[];
  requestedStatus: "fact" | "inference";
}

export interface ClaimSynthesizer {
  synthesize(input: {
    facts: DocumentationFactBundle;
    requestClasses: RequestClass[];
    responseClasses: ResponseClass[];
    allowedEvidenceIds: string[];
  }): Promise<CandidateClaim[]>;
}

export interface ResolvedClaim {
  claimId: string;
  text: string;
  evidenceIds: string[];
  status: "fact" | "inference";
}

export interface ClaimResolution {
  claims: ResolvedClaim[];
  gaps: EvidenceGap[];
}

export interface ExampleCandidate extends ExampleDoc {
  reviewed: boolean;
  schemaValid: boolean;
}

export interface ExampleSelection {
  selected: ExampleDoc[];
  rejected: Array<{ exampleId: string; reason: string }>;
  gaps: EvidenceGap[];
}

export interface EvidenceValidation {
  ok: boolean;
  missingEvidenceIds: string[];
  wrongRevisionEvidenceIds: string[];
  gaps: EvidenceGap[];
}

export function resolveCandidateClaims(
  candidates: CandidateClaim[],
  evidence: EvidenceRef[],
): ClaimResolution;

export function selectExamples(candidates: ExampleCandidate[]): ExampleSelection;
export function sanitizeExample(value: unknown): unknown;
export function validateEvidenceReferences(ir: ApiDocumentationIR): EvidenceValidation;
```

The host may omit `ClaimSynthesizer`; deterministic facts and renderers still produce a complete preview.

- [ ] **Step 4: Resolve evidence and revision scope before accepting claims**

A fact requires every cited ID to exist and at least one verified/reviewed/observed source. A claim spanning endpoint facts from different repos may cite several revision IDs, but each cited fact must match the endpoint's revision set. Unknown/stale evidence demotes the claim to inference and emits a concrete gap. Model prose never creates new evidence IDs.

- [ ] **Step 5: Apply exact example priority and labelling**

Rank `test` then reviewed `wiki` then observed `sls` then `synthetic`. Keep origin, evidence IDs, revision ID, target/time for runtime, and a `synthetic: true` marker. Use schema-generated examples only after schema completeness validation; otherwise emit `example_generation_blocked`.

- [ ] **Step 6: Replace usable credentials recursively**

Case-insensitively replace object/header/query keys matching `authorization`, `cookie`, `set-cookie`, `token`, `access_token`, `refresh_token`, `api_key`, `password`, `secret`, and `client_secret`. Replace Bearer/JWT/basic-auth values even under an unexpected key. Use stable placeholders such as `<AUTHORIZATION_TOKEN>`, `<COOKIE>`, and `<PASSWORD>`; never hash and expose the original.

- [ ] **Step 7: Treat all source text as data**

The optional synthesizer receives immutable fact JSON and an allowed evidence-ID list. Strip control instructions from examples only for rendering safety; preserve bounded raw evidence in its evidence store. Claims such as “ignore prior instructions”, target changes, or publication requests remain quoted evidence text and cannot change execution.

- [ ] **Step 8: Run GREEN verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-evidence.test.mjs
```

Expected: PASS for claim demotion, revision validation, example priority, schema blocking, hostile evidence, and recursive credential replacement.

- [ ] **Step 9: Commit evidence and examples**

```bash
rtk git add packages/api-doc-generator/src/evidence.ts packages/api-doc-generator/src/types.ts packages/api-doc-generator/src/index.ts tests/api-doc-evidence.test.mjs
rtk git commit -m "feat(api-docs): enforce provenance and safe examples"
```

### Task 7: Compute coverage and guard `All Possible` headings

**Files:**
- Create: `packages/api-doc-generator/src/coverage.ts`
- Create: `packages/api-doc-generator/src/generator.ts`
- Modify: `packages/api-doc-generator/src/types.ts`
- Modify: `packages/api-doc-generator/src/index.ts`
- Create: `tests/api-doc-coverage.test.mjs`
- Create: `tests/api-doc-generator.test.mjs`

**Interfaces:**
- Consumes: schema gaps, request analysis, response producer analysis, test/runtime observations, revision trust, and evidence validation.
- Produces: endpoint/document `CoverageSummary`, exact blockers, renderer heading labels, and `buildApiDocumentation()` as the one facts-to-IR assembly path.

- [ ] **Step 1: Write the coverage truth table and fact-to-IR assembly tests**

Cover complete static exits, grouped dynamic producer, unresolved dynamic producer, empty response schema, missing enum/map type, stale revision, `no_static_edge`, no tests, runtime unavailable, and observed-only classes. Assert:

```js
assert.equal(deriveCoverage(exhaustiveInput).level, "exhaustive");
assert.equal(deriveCoverage(boundedDynamicInput).level, "bounded");
assert.equal(deriveCoverage(observedInput).level, "observed");
assert.equal(deriveCoverage(emptyResponseSchema).level, "partial");
assert.equal(deriveCoverage(noTestsButStaticComplete).level, "exhaustive");
assert.equal(deriveCoverage(noTestsButStaticComplete).testCoveredClasses, 0);
assert.equal(coverageHeadings(deriveCoverage(exhaustiveInput)).response, "All Possible Responses");
assert.equal(coverageHeadings(deriveCoverage(boundedDynamicInput)).response, "All Possible Responses");
assert.equal(coverageHeadings(deriveCoverage(observedInput)).response, "Known Response Matrix");
assert.equal(coverageHeadings(deriveCoverage(runtimeNotRequestedButStaticComplete)).response, "All Possible Responses");
assert.equal(coverageHeadings(deriveCoverage(requestedRuntimeUnavailable)).response, "Known Response Matrix");
assert.ok(deriveCoverage(noStaticEdge).blockers.some((b) => b.code === "no_static_edge"));
```

Assert document coverage is never higher than its lowest endpoint and counts remain visible in every level.

In `tests/api-doc-generator.test.mjs`, start with one two-repository fact bundle and assert separate commits, enum/checklist/event survival, endpoint-local constraint/producer isolation, an unresolved `notifyRgPopup` gap, and exhaustive/bounded versus partial document outcomes. Add a malformed bundle with an unknown revision/evidence ID and assert `invalid_fact_bundle` rather than silently dropping provenance.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-coverage.test.mjs tests/api-doc-generator.test.mjs
```

Expected: FAIL because neither the coverage validator nor the fact-to-IR generator exists.

- [ ] **Step 3: Define count-rich coverage output**

```ts
export interface CoverageInput {
  endpointKey: string;
  schemaGaps: EvidenceGap[];
  requestAnalysis: RequestClassAnalysis;
  responseAnalysis: ResponseClassAnalysis;
  revisionTrust: DocumentationRevision["trust"];
  evidenceValidation: EvidenceValidation;
  testCoveredClassIds: string[];
  runtimeObservedClassIds: string[];
  runtimeEvidenceState: CoverageSummary["runtimeEvidenceState"];
}

export function deriveCoverage(input: CoverageInput): CoverageSummary;
export function aggregateDocumentCoverage(endpoints: EndpointDoc[]): CoverageSummary;
export function coverageHeadings(summary: CoverageSummary): {
  request: "All Valid/Invalid Request Classes" | "Known Request Scenarios";
  response: "All Possible Responses" | "Known Response Matrix";
};
```

- [ ] **Step 4: Implement level rules in one place**

Use these exact rules:

- `exhaustive`: complete request/response schema; every static constraint/exit resolved; no dynamic producer; exact revision trust; evidence valid; runtime is either `not_requested` or available when requested.
- `bounded`: same, except every dynamic producer is represented by one explicit bounded class and no producer remains unresolved; runtime is either `not_requested` or available when requested.
- `observed`: test/SLS evidence supports classes but static completeness cannot be proven; no blocker may be hidden.
- `partial`: schema/enum/map missing, stale/degraded revision, unresolved constraint/producer, graph gap, evidence failure, or requested runtime unavailable/partial.

Only `exhaustive` and `bounded` return `All ...` headings. Do not let a caller override heading text directly.
Test/runtime observations strengthen examples and expose contradictions, but their absence is not itself a blocker when they were not requested and static proof is complete. Any observed contradiction becomes a blocker until reconciled.

- [ ] **Step 5: Render precise blockers, not one confidence label**

Deduplicate blockers by `(code, endpointKey, fieldPath, producerId, revisionId)`. Keep counts even when zero. `confidence: high` is never emitted for no-match/empty evidence; coverage describes proof state, not model confidence.

- [ ] **Step 6: Assemble one deterministic IR from the fact bundle**

Implement the missing composition boundary instead of rebuilding IR ad hoc in CLI/UI code:

```ts
export interface ApiDocumentationBuildInput {
  bundle: DocumentationFactBundle;
  claimSynthesizer?: ClaimSynthesizer;
}

export type ApiDocumentationBuildResult =
  | { status: "generated"; ir: ApiDocumentationIR }
  | { status: "invalid_fact_bundle"; gaps: EvidenceGap[] };

export async function buildApiDocumentation(
  input: ApiDocumentationBuildInput,
): Promise<ApiDocumentationBuildResult>;
```

For each endpoint, select only matching request constraints/response producers/tests/runtime observations; run request analysis before response analysis; resolve claims/examples; build headers, enums, events, common responses, guidance, and checklist facts; then derive endpoint coverage. Build a provisional document, validate every evidence/revision reference, fold validation failures into exact gaps, recompute endpoint/document coverage once, and reject only structural defects such as an unknown revision ID or an evidence-bearing scenario with no resolvable evidence. Sort every output by stable identity. Generated previews, CLI, renderers, and Lark sync must all consume this function's IR and may not assemble a second shape.

- [ ] **Step 7: Run GREEN verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-coverage.test.mjs tests/api-doc-generator.test.mjs
```

Expected: every truth-table row PASS and no partial/observed input can render an `All Possible` heading.

- [ ] **Step 8: Commit the completeness contract and IR assembler**

```bash
rtk git add packages/api-doc-generator/src/coverage.ts packages/api-doc-generator/src/generator.ts packages/api-doc-generator/src/types.ts packages/api-doc-generator/src/index.ts tests/api-doc-coverage.test.mjs tests/api-doc-generator.test.mjs
rtk git commit -m "feat(api-docs): gate completeness claims with coverage proof"
```

### Task 8: Render Responsible Gaming depth in Markdown and Lark XML

**Files:**
- Create: `packages/api-doc-generator/src/markdown-renderer.ts`
- Create: `packages/api-doc-generator/src/lark-xml-renderer.ts`
- Create: `packages/api-doc-generator/src/managed-sections.ts`
- Modify: `packages/api-doc-generator/src/index.ts`
- Create: `tests/api-doc-renderer.test.mjs`
- Create: `tests/fixtures/api-doc/responsible-gaming-facts.json`
- Create: `tests/fixtures/api-doc/responsible-gaming.expected.md`
- Create: `tests/fixtures/api-doc/responsible-gaming.expected.xml`

**Interfaces:**
- Consumes: validated `ApiDocumentationIR` and coverage headings.
- Produces: deterministic `RenderedDocument` with ordered `ManagedSection[]`, full Markdown, full Lark XML, section hashes, and no publication side effects.

- [ ] **Step 1: Create the Responsible Gaming fixture and failing structural assertions**

The fixture must include enums, at least two endpoints, routes/purpose, dependencies/fallbacks, headers, nested/map/oneof schemas, request classes, response classes, test/Wiki/SLS/synthetic examples, WebSocket event, common response, FE checklist, revisions/sources, and an unresolved `notifyRgPopup` trigger. Assert:

```js
assert.match(markdown, /Generation coverage and evidence freshness/);
assert.match(markdown, /## Enum/);
assert.match(markdown, /HEADER[\s\S]*REQUEST[\s\S]*RESPONSE/);
assert.match(markdown, /Request Scenario Matrix/);
assert.match(markdown, /Response Outcome Matrix/);
assert.match(markdown, /WebSocket|Event/);
assert.match(markdown, /Common Response/);
assert.match(markdown, /Frontend Checklist/);
assert.match(markdown, /Evidence Gaps and Sources/);
assert.match(markdown, /notifyRgPopup[\s\S]*(unresolved|gap)/i);
assert.doesNotMatch(markdown, /All Possible Responses/, "partial fixture must not overclaim");
assert.match(xml, /<table>[\s\S]*<thead>/);
assert.match(xml, /<pre lang="json"><code>/);
```

Compare normalized output to both golden files and assert a second render is byte-identical.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-renderer.test.mjs
```

Expected: FAIL because renderers, managed sections, and fixtures do not exist.

- [ ] **Step 3: Define stable managed sections**

```ts
export interface ManagedSection {
  sectionKey: string;
  title: string;
  markdown: string;
  larkXml: string;
  contentHash: string;
}

export interface RenderedDocument {
  documentKey: string;
  revisionSetHash: string;
  coverage: CoverageSummary;
  sections: ManagedSection[];
  markdown: string;
  larkXml: string;
}

export interface ManagedBlockInput {
  blockId: string;
  topLevelIndex: number;
  xml: string;
}

export interface ParsedManagedSection {
  sectionKey: string;
  beginBlockId: string;
  contentBlockIds: string[];
  endBlockId: string;
  contentHash: string;
  canonicalXml: string;
}

export interface ManagedSectionParseResult {
  status: "ok" | "structural_conflict";
  sections: ParsedManagedSection[];
  unmanagedBlockIds: string[];
  errors: Array<{ code: string; sectionKey?: string; blockIds: string[] }>;
}

export function renderApiDocumentation(ir: ApiDocumentationIR): RenderedDocument;
export function parseManagedSections(
  documentKey: string,
  blocks: ManagedBlockInput[],
  options?: {
    pending?: {
      sectionKey: string;
      oldBlockIds: string[];
      observedNewBlockIds: string[];
    };
  },
): ManagedSectionParseResult;
```

Use stable section keys: `summary`, `enums`, `endpoint:<endpointKey>`, `event:<eventKey>`, `common-responses`, `frontend-checklist`, and `evidence-gaps-sources`. Section order follows this list and sorted endpoint/event identities, never evidence discovery order.

- [ ] **Step 4: Render Markdown with the approved frontend template**

Render title/revision, coverage/freshness counts, enums, numbered endpoints, route/purpose/dependencies, HEADER/REQUEST/RESPONSE schemas, field explanation, request matrix, response matrix, labelled examples, events, common responses, FE checklist, and gaps/sources. Summarize enums longer than 50 values in the visible table as first 20 + count + link/reference, while retaining all values in IR and a collapsible/raw appendix section.

- [ ] **Step 5: Render valid Lark XML**

Escape only text content (`&`, `<`, `>`), not tags. Use semantic headings, paragraphs for narrative, HTML tables for matrix data, `<pre lang="json"><code>...</code></pre>` for examples, links for source locators, checkboxes for FE checklist, and at most one warning callout for evidence gaps. Do not use whole-document Markdown as the publication primitive.

- [ ] **Step 6: Emit recoverable marker blocks**

Wrap each XML section with compact gray marker paragraphs whose exact text is:

```text
PENGUIN_API_DOC_BEGIN:v1:<documentKey>:<sectionKey>
PENGUIN_API_DOC_END:v1:<documentKey>:<sectionKey>
```

Markers carry identity only; hashes remain in the binding store. `parseManagedSections()` parses marker pairs from fetched full XML blocks, rejects duplicate/unbalanced/nested markers, extracts top-level block IDs, and hashes canonical content between markers after removing fetched `id`/revision attributes. The only tolerated duplicate range is the exact old/new block set named by an active sync journal; every other duplicate is a structural conflict. Visible markers are a deliberate recoverability trade-off; they must be rendered in gray and never mistaken for user content.

- [ ] **Step 7: Preserve provenance in every matrix row**

Each request/response row renders compact evidence links/IDs and revision aliases. Examples display `Test fixture`, `Reviewed Wiki`, `Observed <target/time>`, or `Synthetic`. Gaps name the exact missing field/producer/revision/runtime source.

- [ ] **Step 8: Run GREEN and golden verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-renderer.test.mjs
```

Expected: byte-stable goldens PASS, all required Responsible Gaming sections exist, XML escapes hostile text, and `notifyRgPopup` remains a visible gap.

- [ ] **Step 9: Commit deterministic renderers**

```bash
rtk git add packages/api-doc-generator/src/markdown-renderer.ts packages/api-doc-generator/src/lark-xml-renderer.ts packages/api-doc-generator/src/managed-sections.ts packages/api-doc-generator/src/index.ts tests/api-doc-renderer.test.mjs tests/fixtures/api-doc/responsible-gaming-facts.json tests/fixtures/api-doc/responsible-gaming.expected.md tests/fixtures/api-doc/responsible-gaming.expected.xml
rtk git commit -m "feat(api-docs): render evidence-backed Markdown and Lark XML"
```

### Task 9: Store idempotent branch previews and API diffs locally

**Files:**
- Create: `packages/api-doc-generator/src/preview-store.ts`
- Modify: `packages/api-doc-generator/src/types.ts`
- Modify: `packages/api-doc-generator/src/index.ts`
- Create: `tests/api-doc-preview-store.test.mjs`

**Interfaces:**
- Consumes: validated IR, rendered document, revision set, optional canonical preview, and retention references.
- Produces: atomic `ApiDocPreviewStore.save/list/load/diff/prune` operations with no Lark calls.

- [ ] **Step 1: Write failing create/update/no-change/diff/recovery tests**

Use a temporary root and assert:

```js
assert.equal(first.status, "created");
assert.equal(same.status, "no_change");
assert.equal(changed.status, "updated");
assert.equal(store.list({ documentKey }).length, 1);
assert.equal(store.load(first.previewId).ir.documentKey, documentKey);
assert.ok(store.diff(featurePreviewId, canonicalPreviewId).changedSectionKeys.includes("endpoint:rg.GetLimit"));
```

Inject a crash before rename and assert the previous complete manifest remains readable. Create 25 cold feature previews plus protected default/deployed/pinned/draft references and assert pruning delegates the 20-hot/14-day policy without deleting protected artifacts.

Also save a human-edit conflict and assert `conflict.json` round-trips, `protectedBy` contains `conflict`, `setProtection()` is atomic/idempotent, and a drafted preview cannot be pruned until its external reference is explicitly released.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-preview-store.test.mjs
```

Expected: FAIL because no preview store exists.

- [ ] **Step 3: Define manifest and store contracts**

```ts
export interface ApiDocPreviewManifest {
  previewId: string;
  documentKey: string;
  revisionSetHash: string;
  mode: "preview" | "draft" | "canonical" | "conflict";
  title: string;
  subjects: DocumentationSubject[];
  searchTerms: string[];
  coverage: CoverageLevel;
  sectionHashes: Record<string, string>;
  revisionIds: string[];
  sourceCommits: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  protectedBy: Array<"default" | "deployment" | "pin" | "lark_draft" | "conflict">;
}

export interface ApiDocPreview {
  manifest: ApiDocPreviewManifest;
  ir: ApiDocumentationIR;
  rendered: RenderedDocument;
  conflict?: ApiDocConflictPreview;
}

export interface ApiDocConflictPreview {
  baseRevisionId: number;
  currentRevisionId: number;
  sectionKeys: string[];
  baseHashes: Record<string, string>;
  currentHashes: Record<string, string>;
  desiredHashes: Record<string, string>;
  markdownDiff: string;
}

export type ApiDocPreviewSaveResult =
  | { status: "created" | "updated" | "no_change"; previewId: string; manifest: ApiDocPreviewManifest }
  | { status: "immutable_revision_conflict"; previewId: string; reason: string };

export interface ApiDocPreviewDiff {
  status: "changed" | "no_documented_change";
  addedSectionKeys: string[];
  removedSectionKeys: string[];
  changedSectionKeys: string[];
  markdownDiff: string;
}

export interface ApiDocPreviewPruneResult {
  removedPreviewIds: string[];
  retainedPreviewIds: string[];
  protectedPreviewIds: string[];
}

export class ApiDocPreviewStore {
  constructor(rootDir: string);
  save(input: { ir: ApiDocumentationIR; rendered: RenderedDocument; mode: ApiDocPreviewManifest["mode"]; protectedBy?: ApiDocPreviewManifest["protectedBy"]; now?: Date }): ApiDocPreviewSaveResult;
  saveConflict(input: { preview: ApiDocPreview; conflict: ApiDocConflictPreview; now?: Date }): ApiDocPreviewSaveResult;
  load(previewId: string): ApiDocPreview;
  list(filter?: { documentKey?: string; mode?: ApiDocPreviewManifest["mode"]; query?: string }): ApiDocPreviewManifest[];
  diff(leftPreviewId: string, rightPreviewId: string): ApiDocPreviewDiff;
  setProtection(previewId: string, reason: ApiDocPreviewManifest["protectedBy"][number], enabled: boolean): ApiDocPreviewManifest;
  prune(input: { keepRevisionIds: string[]; hotLimit: number; coldBefore: Date }): ApiDocPreviewPruneResult;
}
```

- [ ] **Step 4: Persist one atomic artifact directory per revision set**

Store under `<root>/<document-key-hash>/<revision-set-hash>/` with `manifest.json`, `ir.json`, `document.md`, and `document.xml`; conflict generations also contain `conflict.json`. Write all files to a same-parent temporary directory, fsync files/directories, then rename into place. A manifest is the commit marker; ignore orphan temporary directories during reads and remove them during repair. Protection changes use the same atomic manifest replacement and never mutate a clean revision's IR/rendered payload.

- [ ] **Step 5: Make repeated generation idempotent**

The preview ID is `preview:v1:<document-key-hash>:<revision-set-hash>`. Same IR/render hashes update `updatedAt` only in memory and return `no_change` without rewriting files. A changed result at the same dirty-worktree revision writes a new generation subdirectory and atomically moves `current.json`; clean commit revisions are immutable and a hash mismatch returns `immutable_revision_conflict`.

- [ ] **Step 6: Generate section-aware diffs**

Compare section hashes first, then emit added/removed/changed section keys and a bounded unified Markdown diff for changed sections. If a feature branch changes no documented contract, return `no_documented_change`; the UI must not offer a duplicate Lark draft for that result.

- [ ] **Step 7: Reuse Branch Revision/COW retention references**

Do not invent a second branch catalogue. Protect previews whose revisions are default, deployed, pinned, explicitly drafted, or conflict evidence. `createDraft()` adds `lark_draft`; conflict creation adds `conflict`; deleting/unbinding the external artifact explicitly releases it. The host registers those protections in the Branch Revision/COW plan's generic revision-reference store so snapshot GC and preview pruning agree. For unprotected feature previews, accept the Branch Revision/COW plan's default `hotLimit=20` and `coldBefore=14 days`; prune only preview artifacts after the corresponding revision has no protected reference.

- [ ] **Step 8: Run GREEN verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-preview-store.test.mjs
```

Expected: PASS for atomic recovery, immutable clean commits, dirty generations, no-change detection, diffs, and protected retention.

- [ ] **Step 9: Commit local previews**

```bash
rtk git add packages/api-doc-generator/src/preview-store.ts packages/api-doc-generator/src/types.ts packages/api-doc-generator/src/index.ts tests/api-doc-preview-store.test.mjs
rtk git commit -m "feat(api-docs): persist branch previews and API diffs"
```

### Task 10: Persist explicit Lark bindings without title-based identity

**Files:**
- Create: `packages/knowledge-cli/src/api-doc-binding-store.ts`
- Create: `tests/api-doc-binding-store.test.mjs`

**Interfaces:**
- Consumes: explicit document key/node token, fetched document ID/revision, verified managed blocks/hashes, and source revision set.
- Produces: atomic `LarkDocumentBindingStore` with bind/read/update/remove and legacy single-repo migration.

- [ ] **Step 1: Write failing identity, duplicate-title, and migration tests**

Assert:

```js
assert.equal(store.resolve(documentKey), null);
assert.throws(() => store.bind({ documentKey, title: "Responsible Gaming" }), /nodeToken is required/);
assert.equal(store.bind(explicit).nodeToken, "wikcnBoundNode");
assert.throws(() => store.bind({ ...explicit, nodeToken: "wikcnOther" }), /already bound/);
assert.equal(store.listCandidates(sameTitleNodes).length, 2);
assert.equal(store.resolve(documentKey).nodeToken, "wikcnBoundNode");
assert.deepEqual(store.resolve(multiRepoKey).sourceRevisions, { auth: "a2", fpmsnt: "f7" });
```

Load a legacy record with only `sourceCommitSha` and no repository identity; assert it preserves that field, sets `sourceRevisions: {}` plus `migrationState: "legacy_repo_unknown"`, and does not invent a repository key. The first verified sync replaces it with exact per-repository revisions without changing the node token.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-binding-store.test.mjs
```

Expected: FAIL because no binding store exists.

- [ ] **Step 3: Implement the multi-repo binding contract**

Preserve the approved fields while extending them for multi-repo correctness:

```ts
export interface LarkDocumentBinding {
  documentKey: string;
  nodeToken: string;
  documentId: string;
  lastRevisionId: number;
  sourceCommitSha?: string;
  sourceRevisions: Record<string, string>;
  sourceRevisionSetHash?: string;
  managedSectionHashes: Record<string, string>;
  managedBlockIds: Record<string, string[]>;
  verifiedAt: string;
  migrationState?: "legacy_repo_unknown";
}

export interface ExplicitBindingInput {
  documentKey: string;
  nodeToken: string;
  documentId: string;
  revisionId: number;
  sourceRevisions: Record<string, string>;
  sourceRevisionSetHash: string;
  managedSectionHashes?: Record<string, string>;
  managedBlockIds?: Record<string, string[]>;
  verifiedAt: string;
}

export interface LarkBindingCandidate {
  nodeToken: string;
  documentId: string;
  title: string;
  parentNodeToken?: string;
  revisionId: number;
}

export class LarkDocumentBindingStore {
  constructor(filePath: string);
  resolve(documentKey: string): LarkDocumentBinding | null;
  bind(input: ExplicitBindingInput): LarkDocumentBinding;
  listCandidates(nodes: LarkBindingCandidate[]): LarkBindingCandidate[];
  updateVerified(binding: LarkDocumentBinding): void;
  remove(documentKey: string, expectedNodeToken: string): void;
}
```

`sourceCommitSha` remains only for reading an old single-repo binding. Because the old format did not store the repository identity, migration must not guess a key; `sourceRevisions` stays empty with `migrationState: "legacy_repo_unknown"` until the first readback-verified sync writes the exact map and removes both legacy fields. New logic uses `sourceRevisions` and `sourceRevisionSetHash`.

- [ ] **Step 4: Require explicit binding establishment**

`bind()` requires `documentKey`, exact `nodeToken`, fetched `documentId`, and fetched `revisionId`. A configured parent plus an accepted generated draft may supply that token. A title-search result can be displayed as a candidate but can never call `bind()` automatically. Rebinding to another token requires explicit unbind with the expected old token.

- [ ] **Step 5: Write bindings atomically and verify schema**

Use one versioned JSON file, exclusive lock, same-directory temp, fsync, rename, and deterministic key ordering. Reject duplicate document keys, duplicate node tokens bound to different keys, negative revisions, empty document IDs, malformed hashes, and block IDs outside their section key.

- [ ] **Step 6: Run GREEN verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-cli build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-binding-store.test.mjs
```

Expected: PASS for explicit bind/rebind, duplicate-title non-selection, multi-repo revisions, atomic recovery, and legacy migration.

- [ ] **Step 7: Commit stable document identity**

```bash
rtk git add packages/knowledge-cli/src/api-doc-binding-store.ts tests/api-doc-binding-store.test.mjs
rtk git commit -m "feat(api-docs): persist explicit Lark document bindings"
```

### Task 11: Synchronize managed Lark blocks with conflicts and recovery

**Files:**
- Create: `packages/knowledge-cli/src/lark-document-client.ts`
- Create: `packages/knowledge-cli/src/api-doc-sync.ts`
- Modify: `packages/api-doc-generator/src/managed-sections.ts`
- Modify: `packages/api-doc-generator/src/index.ts`
- Create: `tests/api-doc-lark-sync.test.mjs`

**Interfaces:**
- Consumes: rendered managed sections, explicit binding, full fetched XML/block IDs/revision, process runner, preview store, and binding store.
- Produces: `LarkSyncResult`, conflict preview, explicit unbound draft, or recoverable partial journal; never a whole-document overwrite.

- [ ] **Step 1: Write failing client argv/stdin and sync-state tests**

Use a fake process runner and full-document fixtures. Assert exact argv and no shell:

```js
assert.deepEqual(fetchCall.argv, ["docs", "+fetch", "--doc", nodeToken, "--doc-format", "xml", "--detail", "full", "--revision-id", "-1", "--format", "json", "--as", "user"]);
assert.equal(fetchCall.shell, false);
assert.equal(insertCall.argv.includes("--command"), true);
assert.equal(insertCall.argv.includes("block_insert_after"), true);
assert.equal(insertCall.stdin, generatedSectionXmlWithEndMarker);
assert.ok(insertCall.argv.includes(String(fetchedRevisionId)));
assert.ok(!insertCall.argv.includes(generatedSectionXmlWithEndMarker));
```

Cover unchanged no-op, safe update, unmanaged content preservation, human edit conflict, same-title siblings, revision race, insert-success/delete-failure, retry repair, block-ID churn, permission/network failure, and two repeated syncs updating one bound node.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-cli build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-lark-sync.test.mjs
```

Expected: FAIL because the Lark client and sync orchestrator do not exist.

- [ ] **Step 3: Implement the process-runner and document-client contracts**

```ts
export interface ProcessRunner {
  run(input: {
    command: string;
    argv: string[];
    stdin?: string;
    timeoutMs: number;
    env?: Record<string, string>;
    shell: false;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface LarkBlockSnapshot {
  blockId: string;
  parentBlockId?: string;
  blockType: string;
  xml: string;
  topLevelIndex: number;
}

export interface LarkDocumentSnapshot {
  nodeToken: string;
  documentId: string;
  revisionId: number;
  xml: string;
  blocks: LarkBlockSnapshot[];
}

export interface LarkWriteResult {
  status: "success" | "partial_success" | "failed" | "confirmation_required";
  revisionId?: number;
  updatedBlocksCount: number;
  newBlocks: Array<{ blockId: string; blockType: string; blockToken?: string }>;
  warnings: string[];
  reason?: string;
}

export interface LarkDraftResult {
  status: "created" | "failed" | "confirmation_required";
  nodeToken?: string;
  documentId?: string;
  revisionId?: number;
  url?: string;
  reason?: string;
}

export type LarkSyncResult =
  | { status: "synced" | "no_change"; documentKey: string; nodeToken: string; revisionId: number; completedSectionKeys: string[] }
  | { status: "conflict"; documentKey: string; conflictPreviewId: string; conflictSectionKeys: string[] }
  | { status: "partial"; documentKey: string; journalId: string; completedSectionKeys: string[]; failedSectionKey: string; reason: string }
  | { status: "failed" | "confirmation_required"; documentKey: string; reason: string };

export interface ApiDocSyncInput {
  preview: ApiDocPreview;
  binding: LarkDocumentBinding;
  client: LarkCliDocumentClient;
  bindingStore: LarkDocumentBindingStore;
  previewStore: ApiDocPreviewStore;
  journalDir: string;
  now?: Date;
}

export interface ApiDocRepairInput {
  documentKey: string;
  client: LarkCliDocumentClient;
  bindingStore: LarkDocumentBindingStore;
  previewStore: ApiDocPreviewStore;
  journalDir: string;
  now?: Date;
}

export class LarkCliDocumentClient {
  constructor(runner: ProcessRunner);
  fetchFull(nodeToken: string, revisionId?: number): Promise<LarkDocumentSnapshot>;
  insertAfter(input: { nodeToken: string; blockId: string; revisionId: number; xml: string }): Promise<LarkWriteResult>;
  deleteBlocks(input: { nodeToken: string; blockIds: string[]; revisionId: number }): Promise<LarkWriteResult>;
  createDraft(input: { parentToken: string; title: string; xml: string }): Promise<LarkDraftResult>;
}

export async function syncManagedDocument(input: ApiDocSyncInput): Promise<LarkSyncResult>;
export async function repairManagedDocument(input: ApiDocRepairInput): Promise<LarkSyncResult>;
```

Run `lark-cli` directly with argv arrays. Send XML as `--content -` stdin. Parse the documented JSON envelope, `document.revision_id`, `new_blocks`, `result`, warnings, permission violations, and exit code 10 confirmation requirement. Generated-doc sync must never append `--yes` automatically.

- [ ] **Step 4: Fetch and classify every section before writing**

Parse full XML marker pairs and compute canonical current hashes. For each desired section classify:

- `unchanged`: current hash equals desired hash;
- `safe_update`: current hash equals binding's last generated hash;
- `new_section`: marker absent and binding has no prior hash;
- `safe_remove`: generated section removed from IR and current hash equals last generated hash;
- `human_conflict`: current hash differs from both last generated and desired;
- `structural_conflict`: duplicate/unbalanced/nested marker or unknown block sequence.

Any conflict prevents writes to that section. Call `previewStore.saveConflict()` with base/current/desired hashes, revisions, section keys, and diff; the resulting preview is protected by `conflict`. Do not establish or switch binding from a title match.

- [ ] **Step 5: Apply one safe section at a time with revision checks**

Keep the existing BEGIN marker as the stable anchor. For update: insert desired content plus a new END marker after BEGIN, refetch and verify the inserted sequence, delete the old managed content and old END block IDs with the newest revision, then refetch again. For new sections, insert BEGIN/content/END after the previous verified managed section or page end. For safe removal, delete the verified marker range. Refetch after every write because block IDs and revision IDs may change. The ordinary parser rejects duplicate END markers; only `parseManagedSections(documentKey, snapshot.blocks, { pending: journal.pending })` may recognize the exact transient old/new ranges recorded by the active journal.

- [ ] **Step 6: Persist and repair partial operations**

Before the first write, atomically create:

```ts
export interface ApiDocSyncJournal {
  journalId: string;
  documentKey: string;
  nodeToken: string;
  baseRevisionId: number;
  desiredRevisionSetHash: string;
  desiredSectionHashes: Record<string, string>;
  completedSectionKeys: string[];
  pending?: {
    sectionKey: string;
    phase: "inserted_pending_verify" | "inserted_pending_delete" | "deleted_pending_verify";
    oldBlockIds: string[];
    observedNewBlockIds: string[];
  };
  status: "running" | "partial" | "verified";
  lastError?: string;
  updatedAt: string;
}
```

Update the journal after each refetch. `repair()` refetches first, recognizes duplicate old/new marker ranges, verifies hashes, then completes delete or stops on human/structural conflict. Never guess based only on the previous process exit code.

- [ ] **Step 7: Verify final readback before binding mutation**

After all safe sections, fetch full again and assert node/document identity, latest revision, one balanced marker pair per section, exact desired hashes, expected section count, and unchanged unmanaged block hashes. Only then persist new `lastRevisionId`, `sourceRevisions`, section hashes, and current block IDs. Permission/network failure or `partial_success` leaves the old binding and journal intact.

- [ ] **Step 8: Create drafts without canonical binding**

`createDraft()` runs `lark-cli docs +create --parent-token <token> --doc-format xml --content - --format json --as user` with rendered XML on stdin. Return the draft token/revision but do not bind it, then atomically add `lark_draft` protection to the source preview and register revision references for every participating revision. A separate explicit `bind` command in Task 12 accepts the draft after user review; unbind/delete explicitly releases those references. Feature `no_documented_change` refuses draft creation.

- [ ] **Step 9: Run GREEN verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-cli build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-lark-sync.test.mjs
```

Expected: PASS for argv/stdin safety, revision-aware no-op/update/create/remove, conflict drafts, partial repair, verified binding update, and no same-title duplicates.

- [ ] **Step 10: Commit managed Lark synchronization**

```bash
rtk git add packages/knowledge-cli/src/lark-document-client.ts packages/knowledge-cli/src/api-doc-sync.ts packages/api-doc-generator/src/managed-sections.ts packages/api-doc-generator/src/index.ts tests/api-doc-lark-sync.test.mjs
rtk git commit -m "feat(api-docs): sync revision-aware managed Lark sections"
```

### Task 12: Expose CLI/desktop workflows and prove acceptance

**Files:**
- Create: `packages/knowledge-cli/src/api-doc-command.ts`
- Modify: `packages/knowledge-cli/src/index.ts`
- Modify: `packages/knowledge-cli/src/bin.ts`
- Modify: `src/lib/knowledge-client.ts`
- Modify: `src/components/docs/ApiDocsPage.tsx`
- Modify: `src/components/wiki/WikiPage.tsx`
- Modify: `src-tauri/src/knowledge.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `tests/api-doc-cli.test.mjs`
- Modify: `tests/api-docs.test.mjs`
- Modify: `tests/wiki-page.test.mjs`
- Create: `docs/api-documentation-generator.md`

**Interfaces:**
- Consumes: all prior generator/collector/preview/binding/Lark contracts and a JSON `DocumentationRequest` from a relative file or bounded stdin.
- Produces: `penguin api-doc generate/list/show/diff/bind/unbind/draft/sync/repair`, generated-doc UI, and full local acceptance evidence.

- [ ] **Step 1: Write failing CLI end-to-end tests**

Drive `runCli()` with fake Knowledge, runtime, files, and Lark dependencies:

```js
assert.equal(await runCli(["api-doc", "generate", "--request", "-", "--json"], deps), 0);
assert.equal(JSON.parse(out.at(-1)).status, "created");
assert.equal(await runCli(["api-doc", "list", "--json"], deps), 0);
assert.equal(await runCli(["api-doc", "show", previewId, "--format", "markdown"], deps), 0);
assert.equal(await runCli(["api-doc", "diff", featureId, "--against", canonicalId, "--json"], deps), 0);
assert.equal(await runCli(["api-doc", "sync", featureId, "--json"], deps), 1);
assert.match(err.at(-1), /canonical revision required/);
assert.equal(fakeLark.calls.length, 0);
```

Then bind an exact token, sync an exact default/deployed preview twice, and assert one node, second sync `no_change`, final binding revision advances only after readback. Cover malformed/oversized stdin, ambiguous subject, degraded override, draft, conflict, permission failure, and repair.

- [ ] **Step 2: Run RED verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-cli.test.mjs tests/api-docs.test.mjs
```

Expected: FAIL because the command family and generated UI path do not exist.

- [ ] **Step 3: Verify the workspace dependency gate from Task 3**

Confirm `knowledge-cli/package.json` contains `@penguin/api-doc-generator: workspace:*`, `pnpm-lock.yaml` contains `link:../api-doc-generator`, and root `build`/`typecheck` place generator after core and before knowledge-cli. Run:

```bash
rtk grep -n "@penguin/api-doc-generator" packages/knowledge-cli/package.json pnpm-lock.yaml package.json
```

Expected: all three files contain the dependency/build-order entry; if any is absent, Task 3 is incomplete and Task 12 must stop before adding CLI imports.

- [ ] **Step 4: Implement the exact CLI surface**

Add help and routing for:

```text
penguin api-doc generate --request <relative-json-file|-> [--allow-degraded-revision] [--json]
penguin api-doc list [--document-key <key>] [--query <text>] [--json]
penguin api-doc show <preview-id> --format json|markdown|xml
penguin api-doc diff <preview-id> --against <preview-id> [--json]
penguin api-doc bind <document-key> --node-token <token> --preview <preview-id> [--json]
penguin api-doc unbind <document-key> --node-token <expected-token> [--json]
penguin api-doc draft <preview-id> --parent-token <token> [--json]
penguin api-doc sync <preview-id> [--allow-degraded-revision] [--json]
penguin api-doc repair <document-key> [--json]
```

Bound stdin/request JSON to 2 MiB. Relative request paths resolve inside `deps.cwd`; reject absolute/traversal paths. `generate` always saves a local preview before any draft/sync action. `--allow-degraded-revision` is explicit, printed in output, and never implied by `mode: "sync"`.

Add `--request`, `--document-key`, `--query`, `--format`, `--against`, `--node-token`, `--preview`, and `--parent-token` to the CLI's value-flag parser so their values never leak into positional arguments. `bind` loads the exact preview, verifies its `documentKey`, fetches the supplied node token with `detail=full`, and persists the fetched document ID/revision plus the preview's exact `sourceRevisions`/revision-set hash. It never binds from a title result or an implicit latest preview.

- [ ] **Step 5: Inject host paths/process/runtime dependencies**

Extend `CliDeps` with optional `apiDocPaths`, `larkProcessRunner`, and `runtimeEvidenceProvider`. `bin.ts` defaults to:

```text
~/.penguin/knowledge/api-docs/previews
~/.penguin/knowledge/api-docs/bindings.json
~/.penguin/knowledge/api-docs/sync-journals
```

Use these exact additions:

```ts
export interface ApiDocPaths {
  previewRoot: string;
  bindingFile: string;
  journalDir: string;
}

export interface ApiDocRevisionReferenceWriter {
  retain(input: {
    refType: "api_doc_draft" | "api_doc_conflict";
    refKey: string;
    revisions: DocumentationRevision[];
  }): void;
  release(input: {
    refType: "api_doc_draft" | "api_doc_conflict";
    refKey: string;
    revisions: DocumentationRevision[];
  }): void;
}

export interface CliDeps {
  apiDocPaths?: ApiDocPaths;
  apiDocRevisionReferences?: ApiDocRevisionReferenceWriter;
  larkProcessRunner?: ProcessRunner;
  runtimeEvidenceProvider?: RuntimeEvidenceProvider;
  readStdin?: () => Promise<string>;
}
```

Implement the real process runner with `node:child_process.spawn("lark-cli", argv, { shell: false })`, bounded stdout/stderr, stdin write/end, 60-second timeout, and update-notifier environment variables disabled. `bin.ts` adapts `ApiDocRevisionReferenceWriter` to `GitTopologyStore.retainRevisionReference()`/`releaseRevisionReference()` using each revision's `repoId`, commit, and snapshot. Never log stdin or authorization material.

- [ ] **Step 6: Enforce publication policy at the command boundary**

`sync` requires an explicit binding and one of: exact clean default branch, exact deployed commit, or explicit `--allow-degraded-revision`. Feature branches default to `preview`; `draft` is the only branch publication action and remains unbound. State-changing request replay is absent from the command family. Lark exit code 10 returns `confirmation_required` to the user and does not self-approve.

- [ ] **Step 7: Add generated-document UI without changing the manual store**

Expose these client functions through one new Tauri command `knowledge_api_doc(args, request_json)`; the Rust command appends `--json`, writes bounded request JSON to child stdin when present, and runs off the main thread:

```ts
export type ApiDocGenerateResult =
  | ApiDocPreviewSaveResult
  | { status: "ambiguous_subject"; candidates: ResolvedSubject[]; reason: string }
  | { status: "ambiguous_revision"; repos: string[]; reason: string }
  | { status: "not_found"; candidates: ResolvedSubject[]; reason: string }
  | { status: "invalid_fact_bundle"; gaps: EvidenceGap[] };

export function knowledgeApiDocGenerate(request: DocumentationRequest): Promise<ApiDocGenerateResult>;
export function knowledgeApiDocList(filter?: { documentKey?: string; query?: string }): Promise<ApiDocPreviewManifest[]>;
export function knowledgeApiDocShow(previewId: string, format: "json" | "markdown" | "xml"): Promise<ApiDocPreview | string>;
export function knowledgeApiDocDiff(leftPreviewId: string, rightPreviewId: string): Promise<ApiDocPreviewDiff>;
export function knowledgeApiDocBind(documentKey: string, nodeToken: string, previewId: string): Promise<LarkDocumentBinding>;
export function knowledgeApiDocUnbind(documentKey: string, expectedNodeToken: string): Promise<void>;
export function knowledgeApiDocCreateDraft(previewId: string, parentToken: string): Promise<LarkDraftResult>;
export function knowledgeApiDocSync(previewId: string, allowDegradedRevision: boolean): Promise<LarkSyncResult>;
export function knowledgeApiDocRepair(documentKey: string): Promise<LarkSyncResult>;
```

Register `knowledge::knowledge_api_doc` in `src-tauri/src/lib.rs`. Reject arguments outside the `api-doc` subcommand and request bodies over 2 MiB at both TypeScript and Rust boundaries.

Add a `Generated` view beside the existing manually authored collections. Show document key, repository revisions/branches/trust, coverage counts, evidence gaps, preview/diff, and Lark binding/sync status. Add the same previews to Penguin Wiki search/navigation by title, service, route, document key, and revision; opening one reads its immutable preview artifact. Do not insert rendered prose into Knowledge facts or use it as evidence. On feature branches show `Generate Preview` and explicit `Create Lark Draft`; on canonical/deployed revisions show explicit bind/unbind and `Sync Bound Document` only to super admins and only after a confirmation dialog. Binding always names the preview whose revisions are being accepted. Keep existing CRUD and `docs-lark.ts` tests passing; generated actions call the Knowledge CLI bridge and never `pushDocsToLark()`.

- [ ] **Step 8: Document operator and recovery workflows**

`docs/api-documentation-generator.md` must include: request JSON example; exact revision precedence; multi-repo revision display; request/response class meaning; coverage truth table; runtime evidence limitation; credential placeholders; preview/diff lifecycle; explicit bind/unbind; same-title warning; Lark user auth; conflict draft; partial journal repair; branch retention; and the rule that no live mutation/replay is used for discovery.

- [ ] **Step 9: Run focused GREEN verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/core build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-core build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/api-doc-generator build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm -F @penguin/knowledge-cli build
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk node --test tests/api-doc-ir.test.mjs tests/proto-schema-parity.test.mjs tests/api-doc-collector.test.mjs tests/api-doc-request-analyzer.test.mjs tests/api-doc-response-analyzer.test.mjs tests/api-doc-evidence.test.mjs tests/api-doc-coverage.test.mjs tests/api-doc-generator.test.mjs tests/api-doc-renderer.test.mjs tests/api-doc-preview-store.test.mjs tests/api-doc-binding-store.test.mjs tests/api-doc-lark-sync.test.mjs tests/api-doc-cli.test.mjs tests/api-docs.test.mjs tests/wiki-page.test.mjs
```

Expected: all focused generator, legacy isolation, CLI, UI-source, and fake-Lark tests PASS.

- [ ] **Step 10: Run repository verification**

```bash
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm typecheck
PATH="/Users/shieng/.nvm/versions/node/v22.22.1/bin:$PATH" rtk pnpm test
rtk git diff --check
```

Expected: typecheck PASS, repository test suite PASS, and `git diff --check` prints no errors. If an unrelated dirty-worktree test fails, record the exact pre-existing failure and rerun every touched-package/focused test to prove this plan's scope.

- [ ] **Step 11: Run local acceptance without SLS or Lark writes**

Generate the Responsible Gaming fixture through the real CLI with `mode: "preview"`; show the preview twice; diff it against an unchanged canonical fixture; and assert:

```text
one stable documentKey
one preview per clean revision set
no_documented_change on identical contract
all scenario rows have evidence and revision IDs
notifyRgPopup remains in Evidence Gaps
partial coverage renders Known Response Matrix
zero lark-cli write calls
```

- [ ] **Step 12: Optionally verify a disposable Lark draft after separate approval**

Only when `PENGUIN_LARK_DRAFT_PARENT_TOKEN` is set to a disposable parent and the user explicitly approves the write, run `api-doc draft`, fetch the returned token with `detail=full`, explicitly bind that draft in the test profile, sync twice, and verify one node, balanced markers, unchanged unmanaged block, current revision, and second-run `no_change`. Never use the existing canonical Responsible Gaming node for this smoke test.

- [ ] **Step 13: Commit CLI, UI, and documentation**

```bash
rtk git add packages/knowledge-cli/src/api-doc-command.ts packages/knowledge-cli/src/index.ts packages/knowledge-cli/src/bin.ts src/lib/knowledge-client.ts src/components/docs/ApiDocsPage.tsx src/components/wiki/WikiPage.tsx src-tauri/src/knowledge.rs src-tauri/src/lib.rs tests/api-doc-cli.test.mjs tests/api-docs.test.mjs tests/wiki-page.test.mjs docs/api-documentation-generator.md
rtk git commit -m "feat(api-docs): expose previews and safe Lark publication"
```

## Acceptance Checklist

- [ ] The Responsible Gaming fixture renders enum, endpoint routes/purpose, HEADER/REQUEST/RESPONSE schemas, business/fallback behavior, request classes, response outcome classes, examples, WebSocket/events, common responses, FE checklist, revisions, evidence, and gaps at the inspected document's structural depth.
- [ ] Every scenario cites resolvable evidence IDs and exact participating repository revisions.
- [ ] grpc and grpc-web parsing agree on enum values, map key/value, oneof, defaults, and optionality; incomplete metadata is a gap.
- [ ] Dynamic external messages are one bounded class per producer/shape/semantics, not an invented finite string list.
- [ ] `All Possible Responses` appears only for `exhaustive`/`bounded`; missing `notifyRgPopup`, schema, graph, trust, or requested runtime evidence prevents it.
- [ ] Feature branches create on-demand local previews/diffs and no permanent canonical Lark pages.
- [ ] Exact default/deployed generation updates one explicitly bound node; same-title siblings are never auto-selected.
- [ ] Human edits inside a managed section create a conflict preview; unmanaged blocks remain byte-equivalent after sync.
- [ ] Every Lark write uses fetched `revision_id`, refetches for new block IDs, and mutates the binding only after final readback.
- [ ] Insert/delete/network/permission failure leaves local IR/preview plus a recoverable journal and the old verified binding.
- [ ] Lark drafts/conflicts register revision references, and unbind/delete releases only the matching explicit reference so COW GC cannot collect still-referenced code.
- [ ] Repeated generation/sync is idempotent, and no live state-changing request replay is used to discover outcomes.
