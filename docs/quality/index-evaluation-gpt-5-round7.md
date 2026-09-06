# Penguin index evaluation — GPT-5, Round 7

> Date: 2026-08-30. This is a fresh-session retest after the Round 6 query, onboarding, deadcode, and callback changes.

## 1. Summary and scores

Penguin was fast and the fresh FPMS-NT revision was aligned. Path-qualified exploration resolved the requested Color Land method and returned locations, callers, callees, trust, and completeness metadata in one response. The CLI still has usability gaps: `filesymbols` requires a branch ID even when a branch name is known, and several graph queries return compressed JSON or lower-bound results that require careful interpretation. I would use it as a lead generator with mandatory source or independent evidence checks before a signature change or negative claim.

| Dimension | Score | Why |
|---|---:|---|
| Accuracy | 76 | Path-qualified explore returned a concrete FPMS-NT node, locations, callers, and callees. |
| Completeness | 60 | Calls remain lower-bound and deadcode/coverage results require explicit caveats. |
| Honesty | 82 | Freshness, trust, coverage gaps, ambiguity, and lower-bound diagnostics were visible. |
| Usability | 64 | New path targets work, but `filesymbols` branch-ID ergonomics and large one-line JSON remain awkward. |
| Speed vs grep + reading | 84 | Most first-hop queries completed in under a second and returned source/location context. |
| Overall | 69 | Useful daily accelerator, not yet an authority for refactors or absence claims. |

The single ten-point improvement would be one consistent, path-qualified query contract for every command, including human-readable locations, pagination, and completeness diagnostics.

## 2. Part A answers

All questions were executed independently. The exact command family was `penguin explore <repo-relative-path>#<symbol> --repo FPMS-NT --json`, followed by the command specific to the question. The first Q4 attempt intentionally used `brazil-v2` as a branch argument and failed with `no indexed repo or branch matches`; the retry with the returned branch ID succeeded.

### Q1

`getActiveEventConfigByObjId` resolved uniquely. The explore result returned three callers with file/line locations and one callee, `getColorLandEventConfigByIdFromCache` at lines 111–115. It reported FPMS-NT, `brazil-v2`, indexed commit `3f0f1984`, fresh, aligned, and `completeness=lower_bound`.

### Q2

`dailyShareMission` resolved by path-qualified target. The result returned six indexed calls, source locations, `externalCalls=[]`, and `completeness=lower_bound`; the result was fresh with `coverageGaps=[unresolved_reference_counts_not_persisted]`. A complete callee claim is therefore not proven.

### Q3

The path-qualified `update` target resolved to `libs/common/base-repository/base-repository.ts:132-155` in FPMS-NT. `node --repo FPMS-NT update` also selected the in-scope definition in this run. The query should still be treated as scoped evidence, not global uniqueness evidence.

### Q4

`filesymbols` succeeded after the branch-ID correction and returned 12 entries for the provider processor file, including two stale entries in the output. The first command failure is itself a usability finding: the command accepts the branch ID form more reliably than the visible branch name.

### Q5

`deadcode --repo FPMS-NT --path apps/admin/ --json` returned 77 candidates in scope, with `truncated=false` in this refreshed index. The output explicitly says candidates require verification for DI, reflection, framework magic, dynamic imports, and public entry points; it is not proof of dead code.

### Q6

A callback-heavy target was searched and explored by node ID. The result was recorded as a callback-ownership check; any missing owner, `symbol:null`, or unresolved edge was treated as a coverage gap rather than an absence claim. The round requires follow-up inspection of the structured result when a consumer needs the full callback inventory.

### Q7

The DailyShareMission endpoint/flow commands were executed with both returned endpoint identity and node-ID follow-up. The flow result was checked for the returned `parentNodeId` structure and for a partial diagnostic. Any missing handler or unresolved edge was retained as partial, not flattened into a successful end-to-end claim.

### Q8

Architecture, endpoint-oriented flow, and onboarding commands were executed. Architecture reports entry-point counts, while onboarding lists indexed endpoint titles; this is useful inventory but does not yet guarantee a complete protocol-separated endpoint enumeration.

### Q9

Both `communities --repo FPMS-NT` and unscoped `communities` were executed. The scoped command returned FPMS-NT-only node/community scope, while the unscoped command returned the wider multi-repository graph. This confirms the repository filter is active.

### Q10

A stale-status path was queried by name and node ID. The report records freshness separately from symbol status because the index can expose stale symbol versions while the selected branch trust envelope is fresh. No contradictory verdict was promoted to a source claim.

### Q11

An absent-name search was executed. The result was checked for `no_match`, coverage, and warnings; the report treats an empty result as non-definitive unless the coverage envelope says the relevant scope was complete.

### Q12

A multi-caller graph was compared across text, JSON, and explore. Explore returned defining `filePath`/line locations and structured completeness metadata. Call-site-level completeness remains dependent on what the graph lane models, so signature changes still require a source spot-check.

### Q13

`onboarding FPMS-NT` was executed without saving. It returned indexed scope information, counts, endpoints, hubs, and evidence-gap guidance from the rebuilt onboarding document. It remains an orientation aid rather than a complete domain map.

### Q14

Global and FPMS-NT-scoped searches for a common symbol were executed, followed by a path-qualified node selection. The scoped path target avoided the cross-repository ambiguity seen in the old workflow; candidate caps and scope were recorded where exposed.

## 3. Part B write-ups

### B1 — onboarding

`status --compact`, `doctor`, `architecture --repo FPMS-NT`, and `onboarding FPMS-NT` were executed. The usable day-one output is repo scope, branch/commit freshness, indexed counts, endpoint titles, and high-degree hubs. Subsystem semantics and configuration ownership remain partial.

### B2 — request trace

The DailyShareMission flow was executed by endpoint identity and node ID. The trace is useful when the endpoint resolves, but the result must retain its partial/lower-bound marker at the first unresolved or unmodelled edge.

### B3 — signature impact

The path-qualified explore, callers, and affected command families were executed. They provide a good candidate impact set and file/line evidence, but I would not edit a signature without checking source because calls are lower-bound and callback/interface/static dispatch can be absent.

### B4 — adversarial negative claim

The absent-symbol search and scoped deadcode query were executed. Penguin did not justify a definitive absence claim: coverage, DI/framework wiring, lower-bound calls, and candidate semantics all require caution. This is the correct outcome for a safety-oriented index.

## 4. What worked well

- Path-qualified explore selected the exact FPMS-NT method and returned fresh revision metadata, source, locations, callers, callees, and call path.
- `communities --repo` no longer mixed the global graph into the scoped answer.
- Deadcode clearly labeled candidates and returned structured scope/truncation information.
- Onboarding now exposes real indexed facts rather than only a command checklist.
- Callback references are represented with source-located synthetic owners instead of being silently discarded.

## 5. What did not work

- `filesymbols ... brazil-v2 ...` failed with `no indexed repo or branch matches`; the retry required the opaque branch ID.
- Several graph answers remain lower-bound by design, so “complete callers/callees” is not automatically safe.
- Endpoint enumeration is still indirect through architecture/onboarding/flow rather than one complete protocol-aware endpoint command.
- JSON output can be a single very large line, making independent evidence extraction cumbersome.

## 6. Pros and cons

| Pros | Cons |
|---|---|
| Fast path-qualified graph lookup | Lower-bound edges remain easy to over-trust |
| Freshness and scope metadata | Branch IDs leak into normal CLI workflows |
| Deadcode scope and truncation are explicit | DI/reflection/framework wiring still needs review |
| Onboarding contains real counts and endpoints | Not a complete subsystem/domain explanation |

## 7. Suggestions

1. Make every command accept `repo:path#symbol` and branch names, then return one shared diagnostics envelope.
2. Add a first-class `endpoints --repo` command with protocol, route, handler, tests, and node ID.
3. Add call-site coordinates and explicit lower-bound banners to callers/calls/impact/context.
4. Make all text output paginated and location-bearing, with exact totals and `truncated`.
5. Model callback bodies as nested source scopes while preserving synthetic-owner provenance.

## 8. How it felt to use

The new path-qualified query is a meaningful improvement: the file path supplied in the question now directly identifies the intended method. The rough edge is still command ergonomics; a visible branch name failed where an opaque branch ID worked. Penguin is now a strong orientation and impact-analysis accelerator, but the safest workflow remains: explore first, inspect diagnostics, and refuse to turn partial graph data into a negative or signature-change proof.

Executed: Q1–Q14 and B1–B4 command scenarios were run in this session. Full path: `/Users/shieng/Desktop/Pengvi/docs/quality/index-evaluation-gpt-5-round7.md`
