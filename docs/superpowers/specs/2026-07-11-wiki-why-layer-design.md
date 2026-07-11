# Wiki WHY Layer — Design

Date: 2026-07-11
Status: Approved (brainstorm) — pending implementation plan
Branch: feature/knowledge-core

## Problem

The knowledge Wiki indexes real code into a graph (symbols, calls, cross-service
gRPC edges). Audited structural accuracy ≈ 95% (cross-service/endpoint edges
100%). It is excellent at **structure/navigation** — "who calls X", "which
services depend on Y", "change here breaks what" — but it has **no WHY**: design
intent, business reason, why a line is written a certain way, the root cause when
something breaks. An AI (or human) using it can locate code fast but does not
*understand* the project.

Empirically confirmed this session by asking DeepSeek project questions grounded
in the graph: it answered structural questions well, but for "why is this
designed this way" it correctly said **"the graph has no such information"**.

## The ceiling (three-way agreement: DeepSeek + Codex + our audit)

An AI reading **code alone** produces **evidence-based hypotheses, not
historical facts**. Code stores results and constraints; it does not reliably
store *motive*.

- **Derivable from code** (with evidence): local design patterns, defensive
  guards, performance tradeoffs, adapter/compat intent, "this gRPC edge means a
  business flow depends on that service".
- **NOT derivable from code** (needs git history / PR / incident / a human):
  why this approach over another, what pitfall was hit, business/compliance/
  launch pressure, a specific incident's root cause, future-plan placeholders.

**The under-used goldmine already in the repo:** `git blame` + recent commits +
tests. Signal ranking: ADR/PR/incident > tests (state what must not break) >
high-quality commit messages > code comments (rot). Local first priority:
`blame + recent related commits + covering tests` — cheapest, closest to code.

## The make-or-break: governance, not generation

Both external models flagged the same top risk: an AI will write a
*plausible-sounding explanation* as if it were *real history*, and the Wiki
degrades into pretty-but-unaccountable noise. Second risk: staleness — code
changes, the WHY does not invalidate, and it now misleads.

Therefore every WHY entry MUST carry: **source, confidence, verbatim evidence,
human-confirmation status, and a content-hash binding for staleness.** AI
inference is never presented as fact. This is exactly the audit discipline used
this session (verify against source, separate fact from inference, label
confidence).

## Design: the "WHY card"

For each targeted symbol or edge, produce a structured card (NOT prose):

| Field | Source | Trust |
|-------|--------|-------|
| **Facts** | knowledge graph (95% accurate) | high |
| **Inference** | AI reading the code + graph neighbourhood | hypothesis, labelled |
| **Evidence** | `git blame`/recent commits (SHA) + covering tests, verbatim | citable |
| **Confidence** | derived (clear code + evidence → higher) | — |
| **Gaps** | AI self-declared "couldn't determine — needs a human" | — |
| **Bound hash** | target's content-hash (+ branch) | staleness signal |
| **Status** | `draft` (AI) → `confirmed` (human one-click) | — |

Inference is ALWAYS shown as "hypothesis, confidence X, evidence Y, gaps Z". A
human one-click confirm/correct promotes `draft → confirmed`.

## Layered model (the WHY card is L1–L2; the vision is all four)

- **L0 Structure** — the existing graph. Navigation/impact. (Have it.)
- **L1 Semantic WHY** — "what this does & how it fits", AI-generated grounded in
  the graph neighbourhood (Context Pack). Cheap, broad. (WHY card "inference".)
- **L2 Intent/History WHY** — mined from git blame/commits + tests. Real intent
  trail. (WHY card "evidence".)
- **L3 Decisions/Incidents** — human-authored notes for the business "why" that
  is nowhere in code or git. AI *prompts* for these on high-value, unconfirmed
  targets. (Existing why-layer notes.)

## MVP (first, and only, implementation slice)

**Cross-service gRPC edges.** Rationale: (1) the graph already has these edges,
audited to 100% structural accuracy this session; (2) "why does this edge exist"
is exactly what people most need and cannot get from structure; (3) small,
bounded set (~tens), high value.

For each cross-service edge (consumer stub call site → endpoint → server
handler), generate one WHY card:
- **Facts**: from the graph (consumer repo/symbol, endpoint, provider handler).
- **Inference**: AI reads the stub call site + the handler body + graph
  neighbourhood → "what this call is for" (labelled hypothesis).
- **Evidence**: recent commits touching the handler (SHA + message), covering
  tests (the graph already has `tests` edges), the stub/handler source.
- **Confidence / Gaps**: e.g. "business reason for gRPC-vs-sync not in code".

Do NOT auto-fill the whole repo. Do NOT generate for symbols outside the MVP set.

## Architecture (reuse, don't rebuild)

- **Storage/serving**: reuse the existing Wiki **why-notes** (typed notes:
  incident/decision/architecture) + **MCP** + **content-hash**. A WHY card is a
  note bound to a target node, MCP-queryable (AI recall) and Wiki-displayed
  (humans). No new store.
- **Generation**: a **local Claude session** for the high-value MVP cards
  (quality, code stays local, can read `git`). A cloud API (e.g. DeepSeek) is an
  option only later, for cheap bulk of the L1 semantic layer — out of scope now.
- **Selection**: computed from the graph (cross-service edges) + git (recent
  churn), the same queries used in this session's audit.

## Data flow (MVP)

1. **Select** cross-service edges from the graph.
2. **Gather evidence** per edge: stub call site + handler source (have via graph
   file paths) + graph neighbourhood (Context Pack) + `git log/blame` for the
   handler file/lines + covering tests (graph `tests` edges).
3. **Generate** the card (local Claude): facts / inference (labelled) / evidence
   (verbatim SHAs + test names) / confidence / gaps / bound content-hash.
4. **Store** as a why-note bound to the edge's endpoint/handler node + branch.
5. **Serve**: MCP for AI recall; Wiki overlay for humans (does NOT replace the
   structure graph — it augments it).
6. **Govern**: content-hash mismatch → flag "may be outdated"; human confirm →
   `draft → confirmed`.

## Error handling / failure modes

- **Hallucinated history**: mitigated by the card format — inference is a
  labelled hypothesis with confidence + declared gaps; never prose-as-fact.
- **Staleness**: content-hash binding; mismatch flags the card. Regeneration is
  incremental (only changed targets).
- **Generation failure** (git/test missing, unparseable): the card still shows
  Facts (from the graph) + a "no evidence found" note; never a fabricated
  evidence section.

## Testing / verification

- Same discipline as this session's audit: for a sample of generated cards,
  verify each Fact against the graph and each Evidence citation against the
  actual source/commit. Report accuracy + how many inferences were later
  human-confirmed vs corrected. A card whose "evidence" can't be located in the
  repo is a bug.

## Out of scope (YAGNI)

- Auto-generating WHY for the whole repo / all symbols (both models warned this
  degrades to code-paraphrase noise).
- Cloud-API bulk generation (L1 semantic for everything).
- PR/issue-tracker integration (no linked PR data locally yet).
- L3 human-note authoring UX beyond the existing note editor + an AI prompt.

## Open questions for the plan

- Exact card schema stored in the note frontmatter (source/confidence/status/
  bound_hash fields).
- How the local Claude session is invoked/driven for a batch of edges.
- Wiki overlay presentation (where the card renders relative to the edge).
