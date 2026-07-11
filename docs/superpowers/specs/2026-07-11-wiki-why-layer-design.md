# Wiki WHY Layer — Design (Spec B)

Date: 2026-07-11
Status: Approved (brainstorm, 3 review rounds w/ Codex + DeepSeek) — pending plan
Branch: feature/knowledge-core
Depends on: Spec A (full-stack graph linking, 2026-07-11) — the WHY layer's MVP
targets are the cross-service / full-stack edges Spec A produces.

## Problem

The knowledge graph is excellent at STRUCTURE/NAVIGATION — who calls X, which
services depend on Y, change-here-breaks-what, and (after Spec A) the full-stack
trace from a UI action to a backend handler. But it has NO WHY: design intent,
business reason, why a line is written a certain way, root cause on breakage.
An AI or human can locate code fast but does not *understand* the project.

Empirically confirmed this session: DeepSeek, asked "why is this designed this
way" over the graph, correctly answered "the graph has no such information".

## The ceiling (three-way agreement: DeepSeek + Codex + our audit)

Code alone yields **evidence-based hypotheses, not historical facts**. Code
stores results and constraints, not motive.
- Derivable from code (with evidence): local patterns, defensive guards, perf
  tradeoffs, "this edge means a business flow depends on that service".
- NOT derivable from code (needs git / PR / a human / a **PRD**): why this
  approach, what pitfall was hit, business/compliance pressure, incident root
  cause, future-plan placeholders.

Under-used goldmine in the repo: `git blame` + recent commits + tests + **the
PRD**. This project ships a real 52KB PRD (numbered AC-001..AC-048, a domain
model table, cross-repo responsibility table, explicit constraints) describing
the exact activity the indexed repos implement — the highest-quality business
WHY available, better than git blame.

## The make-or-break: governance, not generation

Both models flagged the same top risk: an AI writes a *plausible explanation* as
if it were *real history*, and the Wiki degrades into pretty, unaccountable
noise. With PRD added, a second variant appears: **authority laundering** — a
wrong PRD↔edge match looks *more* trustworthy because it is "human-authored",
even when the AC was never implemented or is stale/aspirational.

Therefore every WHY claim carries source, verification state, verbatim evidence
(citable), confidence, declared gaps, and a staleness fingerprint. Inference is
never shown as fact; a PRD citation is never shown as verified-against-code
unless it actually is.

## Layered WHY model

- **L0 Structure** — the graph (have it; Spec A extends it full-stack).
- **L1 Semantic WHY** — "what this does & how it fits", AI-generated, grounded in
  the graph neighbourhood. (card INFERENCE)
- **L2 Intent/History WHY** — git blame/commits + tests. (card EVIDENCE)
- **L3 Business/Decision WHY** — the PRD (declared intent) + human notes for what
  is nowhere in code/git. (card EVIDENCE: PRD citation; GAPS prompts a human)

## The WHY card

### Subject = a cross-service CONTRACT, not a note bolted to one node (Codex)

The card's subject is the full-stack contract, not a single handler symbol:
- the global endpoint node (`grpc::Service.Method`),
- consumer edge(s) — backend AND, after Spec A, frontend (`source_type` tagged),
- the server handler edge,
- source spans, covering test edges, git evidence,
- per-claim evidence IDs, confirmation status, staleness fingerprints.

### Claim-level structure (each field is a set of CLAIMS, each claim cited)

| Field | Source type | Trust |
|-------|-------------|-------|
| FACTS | `code_observed` (graph) | high; each FACT must cite an evidence ID or it becomes INFERENCE |
| INFERENCE | `ai_inferred` (AI reading code + neighbourhood) | hypothesis, always labelled |
| EVIDENCE | git SHA + msg, covering tests, source file:line, **PRD AC/domain-row** | citable |
| CONFIDENCE | derived | — |
| GAPS | AI self-declared "needs a human" | — |

### Trust = two independent axes (not one scale)

- **source type**: `code_observed` | `prd_declared` | `ai_inferred`
- **verification state**: `verified_against_code` | `conflicts_with_code` |
  `unchecked` | `stale`

A `prd_declared` claim starts `unchecked`. It is NOT elevated to
`verified_against_code` just because it is human-authored — see PRD coverage
check below. A `conflicts_with_code` claim (FACT contradicts the current graph)
is surfaced as a red `FACT DISCREPANCY`, auto-detected by a cheap background
recompute of the graph query behind the FACT.

### Status lifecycle

`draft` (AI) → `confirmed` (human one-click) — or `rejected` ("mark as noise",
one click). Confirm is BLOCKED / visibly degraded when the FACTS lack evidence
citations (you cannot "confirm" an ungrounded card).

## Evidence sources & the PRD

Per target, the generator assembles a deterministic evidence pack with STABLE
evidence IDs:
- graph Context Pack (get_node + explore_graph) + the proto message + a 1-hop
  subgraph (add proto & neighbours so the AI doesn't hallucinate from a bare
  stub+handler snippet),
- `git log`/`blame` for the handler file/lines,
- covering tests (graph `tests` edges),
- **PRD chunks** (see matching).

### PRD matching (no hallucinated mapping)

Rank of signals (most → least reliable), each emits CANDIDATES only:
1. **proto-comment AC annotations** — VERIFIED in this repo but PARTIAL. The
   promotion protos DO cite ACs, but measured coverage is low and uneven:
   skin-fragment-frontend.proto = 9 rpc, ~0–1 bindable (its AC mentions are a
   file-header note (AC-028) and a deep message comment (AC-038), NOT on the rpc
   lines); skin-fragment-admin.proto = 7 rpc, ~3 bindable (AC co-mentioned in the
   comments of UpdateActivity / ListFragmentLedger / ListRedemptions). Net ≈ 3–4
   of 16 rpc, concentrated in admin. Crucially the KEY frontend rpcs
   (`ClaimDailyFragment`, `SettlePendingInvites`, …) — the full-stack WHY targets
   — mostly LACK a proto AC comment (their ACs live in the PRD body:
   AC-003/004 daily draw, AC-039 lazy settlement, AC-011/012 gift). So proto
   comments are an OPPORTUNISTIC high-reliability binding WHERE PRESENT; they do
   NOT replace the binding map. Extraction: a comment co-mentioning a method name
   + an AC, wherever it appears in the file (not just above the rpc line).
2. explicit human-confirmed binding `{edge/entity → AC_id | domain-row}` (a small
   static map). Still needed for the MAJORITY of rpcs (esp. frontend). This is
   the workhorse, seeded from proto comments (#1) where available.
3. proto message / DTO / entity name overlap (`inviteRecord` ↔ `InviteRecord`,
   `SkinFragment` service ↔ PRD domain rows). Candidate generator for #2.
4. lexical (AC id / entity / service-name) match over pre-parsed PRD chunks.
5. embeddings — MAY WIDEN candidates, NEVER creates a cited fact.

A PRD citation appears on a card ONLY through a stored binding (a proto-comment
annotation counts as a machine-confirmed binding; anything weaker needs a human
confirm). No auto-asserted fuzzy match becomes evidence.

### PRD implementation coverage check (defeats authority laundering)

For each cited AC, auto-check whether a code/integration test references that AC
label. If NO test covers it, the PRD claim is demoted to `unchecked`/UNVERIFIED —
trust no higher than AI inference — and flagged "PRD-declared, not verified in
code".

VERIFIED in this repo — the convention exists and is machine-extractable:
- AC labels appear in **test NAMES**, e.g.
  `it('AC-003 sameTaskFrequencyDays blocks within cool-down', …)` — structured,
  greppable; and in comments (`// AC-003: …`). Extract from both.
- The skin-fragment backend has AC-labelled tests under
  `fpmsnt/apps/promotion/test/**/skin-fragment/` (draw/redemption/invite/activity).

CRITICAL caveat — **AC numbers COLLIDE across PRDs/features**. `AC-003` exists in
unbind-phone, a growth-task frequency feature, a task-validation feature, AND
skin-fragment — each a DIFFERENT AC-003. Therefore the coverage check MUST be
**feature/PRD-scoped**, never a global AC-number grep:
- scope = the contract's owning module/test directory (e.g. the skin-fragment
  card only counts tests under `apps/promotion/**/skin-fragment/**` referencing
  that AC), tied to the PRD the card's contract belongs to.
- a global `AC-039` match outside that scope does NOT count as coverage.

## `penguin why` — the batch enricher (NOT a Q&A tool)

Like `penguin index` but for WHY: auto-scan → generate → write cards INTO the
Wiki. Humans read & confirm in the Wiki.

```
penguin why              # auto-scan, MVP scope = cross-service / full-stack edges
penguin why --scope <repo>
penguin index            # marks cards whose fingerprint drifted as "stale" (free)
penguin why              # re-run regenerates only stale cards; fresh ones skipped
```

Generation engine = the existing `penguin explain` BYOK router → LOCAL Claude,
fed the evidence pack; reuses the `understand-explain` methodology. Cost trap:
never auto-fill the whole repo (paraphrase noise) — only the evidence-gated MVP set.

### Target gate (seed quality over coverage)

Only seed edges that HAVE citable evidence — handler + consumer + at least one of
{covering test, git history, PRD binding}. Edges with none are QUEUED as
"insufficient evidence", not written as hollow cards. Rank by importance/churn.

## Data flow (per target)

1. **Select** a cross-service / full-stack edge (Spec A gives full-stack ones).
2. **Gather** the deterministic evidence pack (graph + proto + 1-hop + git +
   tests + bound PRD chunks), each item with a stable evidence ID.
3. **Generate** (local Claude): FACTS (each cites an evidence ID or demotes to
   INFERENCE), INFERENCE (labelled), EVIDENCE, CONFIDENCE, GAPS + fingerprints.
4. **Store** as a why-note bound to the contract subject (reuse existing typed
   notes + MCP + content-hash). MCP-queryable (AI) + Wiki-shown (human).
5. **Serve** in the Wiki as an overlay on the edge/node (augments, never replaces
   the structure graph).
6. **Govern** (below).

## Governance / Wiki trust UX (make-or-break)

- **Visual isolation**: FACTS and INFERENCE never share the same card weight.
  INFERENCE is a separate, collapsed-by-default block (grey, italic, warning
  icon), expanded on click. A prominent `DRAFT — needs review` banner until
  confirmed.
- **Evidence-coverage gating**: show each claim's evidence coverage before
  confirm; block/degrade confirm when FACTS are uncited.
- **One-click reject** ("mark as noise") beside one-click confirm — else humans
  ignore the whole overlay.
- **Diff-since-confirmed**: on a stale/regenerated card, show what changed in
  FACTS/INFERENCE vs the last confirmed version.
- **FACT discrepancy check**: background recompute of each FACT's graph query;
  mismatch → red flag on that claim.
- After confirm: banner removed, FACTS/EVIDENCE read-only, inference stays
  collapsed.

## Staleness — per-claim, multi-source fingerprints

Two independent moving sources: code and PRD. Do NOT hash the 52KB doc into every
card, and do NOT invalidate on every PRD edit.

Per-claim fingerprint components:
- **code**: contract/proto fingerprint + handler impl + consumer (incl. frontend
  call site) + endpoint meta (service/method).
- **PRD**: per-cited-span — doc id/version, section id (AC anchor), span hash,
  extracted-quote hash, binding id.

Rules:
- Mark only IMPACTED claims stale, roll up to card status.
- Code fingerprint change → card `stale`.
- Cited PRD span changes/deletes (via PRD-file git blame on the bound region) →
  claim badge `PRD updated — verify alignment`. Do NOT auto-reject on PRD-only
  change unless the code fingerprint also changed; other PRD edits update doc
  freshness metadata only.

## Failure modes

- Hallucinated history → card format (labelled hypothesis + confidence + gaps),
  FACTS-cite-or-demote.
- PRD authority laundering → coverage check demotes uncovered ACs; bindings must
  be human-confirmed; two-axis trust prevents "human-authored ⇒ verified".
- Staleness → per-claim fingerprints; incremental regen (only changed targets).
- Generation failure (no git/test/PRD) → card shows FACTS + "no evidence found";
  never a fabricated evidence section.

## Testing / verification

- Same audit discipline as this session: for a sample of cards, verify each FACT
  against the graph and each EVIDENCE citation against the actual source / commit
  / test / PRD span. A card whose evidence can't be located is a bug.
- Report accuracy + how many inferences were later human-confirmed vs corrected +
  how many PRD claims passed the coverage check.
- Regression: no PRD citation without a stored binding; no `verified_against_code`
  without an actual code check.

## Out of scope (YAGNI)

- Auto-generating WHY for the whole repo / all symbols (paraphrase noise).
- Cloud-API bulk generation.
- A full RAG stack for PRD retrieval (pre-parsed chunks + binding map instead).
- PR / issue-tracker integration (no linked PR data locally yet).
- New storage (reuse notes + MCP + content-hash).

## Open questions for the plan

- Exact card schema in the note frontmatter (subject id, per-claim source
  type/verification state/evidence IDs/fingerprints/status).
- How the local Claude session is driven for a batch (a `/penguin` slash command
  vs a headless BYOK-router batch call).
- Wiki overlay presentation (where the card renders on the edge/node; the
  collapse/diff/discrepancy UI in `WikiWhyPanel`).
- PRD parser: chunking by AC anchor + domain-row; where the PRD file(s) live and
  how the binding map is stored/edited.
- ~~Whether this repo's tests carry AC labels~~ — RESOLVED: yes, in test names
  (`it('AC-0xx …')`) + comments + proto comments; coverage check must be
  feature/PRD-scoped because AC numbers collide across PRDs (see above).
