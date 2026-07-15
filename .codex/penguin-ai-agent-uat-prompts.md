# Penguin AI-Agent UAT Prompt Pack

This document is a copy-paste test pack for Claude Code, Codex, and other coding agents. It tests the canonical `penguin` CLI and MCP integration and makes the agent return an evidence-based result.

It does **not** authorize commit, push, tag, publish, release, destructive database operations, or configuration changes. Automated PASS does not replace the product owner's manual UAT.

## How to use this pack

1. Build and open the Penguin version you intend to test.
2. Open a fresh Claude Code or Codex session at `/Users/shieng/Desktop/Pengvi`.
3. Paste Prompt 0 once to establish the test contract.
4. Paste Prompts A1-A10 one at a time. This is the recommended mode because a failure is easier to isolate.
5. Run Prompts M1-M5 while manually operating the Penguin Desktop UI where requested.
6. Paste Prompt R1 to obtain the final report.
7. Repeat the agent-specific tests in both Claude Code and Codex.

Use these verdicts only:

| Verdict | Meaning |
|---|---|
| `PASS` | The agent ran the test and showed evidence matching every acceptance criterion. |
| `FAIL` | The test ran, but at least one observed result contradicted the acceptance criteria. |
| `BLOCKED` | The required tool, client, index, permission, or user action was unavailable. |
| `NOT RUN` | The test was not attempted. |

An agent must never convert `BLOCKED` or `NOT RUN` into `PASS`.

---

## Prompt 0 — Global test contract

Paste this once at the beginning of every Claude Code or Codex test session.

```text
You are the release UAT verifier for Penguin in /Users/shieng/Desktop/Pengvi.

Safety and evidence rules:
1. This session is read-only unless I explicitly perform a UI action myself.
2. Do not edit files, reindex/rebuild/remove any repository, install packages, change AI-client configuration, commit, push, tag, publish, or release.
3. Use only the canonical `penguin` MCP server and the `penguin` CLI for Penguin knowledge-answer tests.
4. Do not use grep, ripgrep, Read, CodeGraph, Graphify, source browsing, or another index to fill a missing Penguin result. If Penguin cannot prove it, report BLOCKED or FAIL.
5. You may use read-only shell commands only for environment/version checks and official test scripts explicitly requested by a prompt.
6. Run every requested command or MCP call. Do not describe what it "should" return.
7. For every test, report: test ID, exact command/tool, expected result, observed result, evidence, and PASS/FAIL/BLOCKED.
8. Quote only the minimum evidence needed. Never print secrets, tokens, credentials, request bodies, or complete AI-client settings.
9. Separate static-index accuracy from runtime/deployment claims. Static benchmark PASS does not prove deployed-image correctness, reflection, field-write coverage, Mongo collection coverage, or log-literal coverage.
10. Do not give an overall PASS until all required automated and manual tests have a recorded result.
11. If a result differs between CLI and MCP, mark FAIL even when either side looks plausible.
12. If any required test is FAIL, BLOCKED, or NOT RUN, the release verdict must be NO-GO.

After acknowledging these rules, create an empty result ledger with columns:
ID | Client | Expected | Observed | Evidence | Verdict
Do not run tests until I send the next prompt.
```

Expected response: the agent acknowledges the restrictions, creates the ledger, and does not begin unrelated work.

---

## Automated agent prompts

### Prompt A1 — Environment and canonical installation

```text
Run test A1: environment and canonical Penguin installation.

Perform these read-only checks:
- pwd
- git rev-parse --show-toplevel
- git branch --show-current
- git rev-parse HEAD
- command -v penguin
- penguin --version
- penguin doctor --json
- penguin status --compact --json
- Call the canonical Penguin MCP `mcp_health` tool.
- Call the canonical Penguin MCP `index_status` tool in its compact/summary form if supported.

Also inspect the MCP tools available to this session and determine whether a legacy `pengvi` MCP server/tool namespace is exposed. Do not infer this from a config file when the live tool list can answer it.

Acceptance criteria:
1. Repo root is /Users/shieng/Desktop/Pengvi.
2. `penguin` resolves from PATH and returns a version.
3. CLI doctor is healthy.
4. MCP health is healthy.
5. CLI and MCP report a usable knowledge index.
6. The canonical server is `penguin`; no `pengvi` duplicate tool namespace is exposed.
7. Report the branch and commit tested.

Return the A1 ledger row and a concise diagnosis for every mismatch.
```

### Prompt A2 — Index freshness and trust consistency

```text
Run test A2: index freshness and trust consistency.

Use both:
- `penguin status --compact --json`
- canonical Penguin MCP `index_status` compact/summary mode

Compare repo count, live branch, freshness category, dirty-file count, stale/error count, and any trust/stale flags for the same repositories.

Acceptance criteria:
1. Both outputs are machine-readable and understandable.
2. CLI and MCP agree on repo count and freshness categories.
3. No repo has an unexplained index error.
4. If `staleSymbols` is non-zero while overall `stale` is false, explain the two semantics from returned diagnostics; do not guess.
5. Dirty repositories may be reported as dirty, but they must not be mislabeled as clean/fresh.

Return one summary row plus a list of any disagreeing repos. If semantics cannot be established from Penguin output, mark BLOCKED rather than inventing an explanation.
```

### Prompt A3 — Search deduplication and snippets

```text
Run test A3: closeAccount search quality.

Execute:
- `penguin search closeAccount --json`
- canonical Penguin MCP `knowledge_search` with query `closeAccount`

For each side, calculate:
- total result count
- unique semantic symbol count
- duplicate identity groups
- stale-result count
- results with null/empty snippet
- results without a usable node identity

Acceptance criteria:
1. CLI and MCP return the same semantic result set.
2. The current baseline is six fresh closeAccount symbols when the indexed Projects snapshot has not changed. If the count differs, show which repo/branch changed and mark FAIL or BLOCKED until the baseline is reviewed.
3. No stale/fresh pair represents the same symbol twice.
4. Every graph-symbol result has a usable identity/node reference.
5. Every graph-symbol result has a non-empty snippet.
6. A file/line identifier result must be explicitly distinguished from a graph node; it must not masquerade as a node with `nodeId: null`.

Return the A3 ledger row and a compact table of the six expected semantic symbols or the observed replacement set.
```

### Prompt A4 — Dependency-injected caller resolution

```text
Run test A4: dependency-injected caller resolution for updateAccountStatus.

CLI path:
1. Run `penguin search updateAccountStatus --json` and select the fresh PlayerAdditionalDetailRepository method identity.
2. Run `penguin callers updateAccountStatus --json` or use the selected full identity if the short name is ambiguous.

MCP path:
1. Use `knowledge_search` for `updateAccountStatus`.
2. Select the same fresh repository method.
3. Use `explore_graph` in `who_calls` mode for that node.

Acceptance criteria:
1. Both CLI and MCP include `BpAccountClosureService.closeAccount` as a caller.
2. The caller edge is attached to the fresh identity, not a stale short identity.
3. CLI and MCP caller sets are semantically equal.
4. If either side returns an empty list, diagnostics must explain coverage; an unexplained empty list is FAIL.

Return the selected target identity, caller identities, diagnostics, and A4 verdict.
```

### Prompt A5 — Frontend endpoint to Auth backend

```text
Run test A5: Frontend RG endpoint to Auth backend flow.

Execute:
- `penguin flow grpc::FrontendRgAccountService.closeaccount --json`
- canonical Penguin MCP `knowledge_explore` for `grpc::FrontendRgAccountService.closeaccount`
- If needed, use MCP `explore_graph` only to inspect the endpoint's `handles`/outgoing relationships.

Acceptance criteria:
1. The endpoint is not a dead end.
2. The flow reaches the Auth controller/handler method in one handler hop.
3. It continues into the Auth business chain where indexed edges exist.
4. CLI and MCP agree on endpoint-to-handler semantics.
5. Source/trust information returned by `knowledge_explore` is attached to the correct handler.

Return a numbered flow using exact node titles and edge types. Do not fill gaps from source browsing.
```

### Prompt A6 — Auth backend to Risk backend

```text
Run test A6: cross-repository backend-to-backend CloseAccount flow.

Execute:
- `penguin flow RiskControlClientGrpc.closeAccount --json`
- canonical Penguin MCP `knowledge_explore` for `RiskControlClientGrpc.closeAccount`
- Use MCP `explore_graph` only if needed to show the `invokes` and `handles` hops.

Acceptance criteria:
1. The chain starts at the Auth `RiskControlClientGrpc.closeAccount` client call.
2. It crosses repository/service boundaries through the matching gRPC endpoint.
3. It reaches `ResponsibleGamingInternalService.CloseAccount` and the Risk handler/business chain.
4. Edge types distinguish client invocation from endpoint handling.
5. CLI and MCP agree on the cross-service chain.
6. Do not claim complete Mongo field/collection writes unless Penguin returns explicit field/collection evidence.

Return the exact cross-repo path, repo names, edge types, any unresolved boundary, and A6 verdict.
```

### Prompt A7 — `knowledge_explore` as the primary agent entry point

```text
Run test A7: primary `knowledge_explore` experience.

Call canonical Penguin MCP `knowledge_explore` once for `BpAccountClosureService.closeAccount` without first assembling the answer from other Penguin tools.

Inspect whether the single response provides the applicable parts of:
- focus identity and source/signature
- callers
- callees
- execution flow
- tests
- routes/endpoints
- branch/freshness/trust information
- diagnostics for missing sections

Acceptance criteria:
1. The response is sufficient to start a code investigation without mandatory search + get_node + graph round trips.
2. Returned source belongs to the selected fresh symbol.
3. Missing categories are empty with diagnostics or clearly not applicable; they are not silently omitted in a misleading way.
4. The result is bounded enough for an AI agent to consume.

Report which categories were present, missing, or unclear and give A7 PASS only if the response is a reliable primary entry point.
```

### Prompt A8 — Empty-result honesty and diagnostics

```text
Run test A8: empty-result honesty.

Using canonical Penguin MCP only, search for this deliberately nonexistent symbol:
`__penguin_uat_definitely_missing_symbol_20260714__`

Then attempt a graph/caller exploration only if the tool contract permits a missing target without inventing a node.

Acceptance criteria:
1. The result is empty/not-found, never a fuzzy unrelated symbol presented as exact.
2. The response includes query diagnostics or a clear not-found reason.
3. It distinguishes no match from index/tool failure.
4. It does not provide a fabricated source, caller, node ID, or confidence score.
5. The agent does not use grep/source browsing to compensate.

Return the exact diagnostic fields/messages and A8 verdict.
```

### Prompt A9 — Official benchmark and boundary gates

```text
Run test A9: official Penguin automated gates from /Users/shieng/Desktop/Pengvi.

These commands are authorized for this test and must be run without editing files:
- npm run knowledge:doctor
- npm run knowledge:benchmark
- npm run knowledge:benchmark:real
- node scripts/knowledge-projects-boundary-audit.mjs

Do not rerun indexing and do not substitute an older result.

Acceptance criteria for the current release candidate:
1. Runtime doctor healthy; configured Codex MCP healthy; Node/native ABI match.
2. Installed tool count is 30 and legacy `pengvi` duplicate classification is `none`.
3. Synthetic benchmark passes with calls/tests/routes+gRPC precision=1 and recall=1.
4. Real truth cases pass; CLI/MCP parity is true.
5. Shadow corpus: 415/415 queries across 21/21 repos, parity failures=0, material misses=0.
6. Auth test mapping: 11/11, recall=1, parity failures=0.
7. Claude/Codex shared debug golden: 4/4, parity failures=0.
8. Projects relation boundary: 1,044/1,044, FP=0, FN=0.
9. Flyover proto boundary: 1,185/1,185, FP=0, FN=0.

Report every metric explicitly. If the indexed repos legitimately changed, do not silently update the expected values; mark FAIL/BLOCKED and show the delta for review.
```

### Prompt A10 — CLI/MCP parity consolidation

```text
Run test A10: consolidate CLI/MCP parity for release golden cases.

Use the evidence already gathered in A3-A6. Do not rerun or reinterpret missing evidence.

Create this table:
Case | CLI target | MCP target | CLI semantic result | MCP semantic result | Parity | Verdict

Required cases:
1. closeAccount search dedup/snippet
2. updateAccountStatus who-calls
3. FrontendRgAccountService.closeaccount endpoint-to-Auth handler
4. RiskControlClientGrpc.closeAccount Auth-to-Risk flow

Acceptance criteria:
- All four cases have semantic parity.
- Node IDs may differ only when the outputs explicitly resolve to the same fresh identity.
- Any unexplained difference, stale identity, missing snippet, or missing edge is FAIL.

Return the A10 ledger row and the four-case table.
```

---

## Agent-specific prompts

Run these separately in a fresh Claude Code session and a fresh Codex session.

### Prompt C1 — Claude Code canonical MCP test

```text
Run test C1 in this fresh Claude Code session.

Use only the live canonical Penguin MCP tools, not the CLI and not any source/search fallback.

Test these four cases:
1. Find who calls updateAccountStatus.
2. Trace grpc::FrontendRgAccountService.closeaccount to the Auth handler.
3. Trace RiskControlClientGrpc.closeAccount to the Risk handler across repositories.
4. Search closeAccount and check deduplication plus snippets.

Also report:
- the Penguin MCP server/tool namespace you used
- whether any `pengvi` duplicate namespace is visible
- exact tool calls used
- whether empty/missing sections included diagnostics

Return C1 PASS only if all four results match their release acceptance criteria and only canonical Penguin MCP was used.
```

### Prompt C2 — Codex canonical MCP test

```text
Run test C2 in this fresh Codex session.

Use only the live canonical Penguin MCP tools, not the CLI and not any source/search fallback.

Test these four cases:
1. Find who calls updateAccountStatus.
2. Trace grpc::FrontendRgAccountService.closeaccount to the Auth handler.
3. Trace RiskControlClientGrpc.closeAccount to the Risk handler across repositories.
4. Search closeAccount and check deduplication plus snippets.

Also report:
- the Penguin MCP server/tool namespace you used
- whether any `pengvi` duplicate namespace is visible
- whether the current AGENTS.md guidance presents Penguin as the primary knowledge path
- exact tool calls used
- whether Codex is honestly using MCP + AGENTS.md rather than claiming Claude-style lifecycle hooks

Return C2 PASS only if all four results match their release acceptance criteria and only canonical Penguin MCP was used.
```

---

## Manual UI and Hook prompts

These prompts make the agent guide you. The agent must wait for your observation after each step and may not mark a step PASS on its own.

### Prompt M1 — Guided Penguin Desktop UI test

```text
Run manual test M1 as my interactive UAT guide.

Do not control or modify the app yourself. Give me one step at a time, wait for my observation, then record PASS/FAIL/BLOCKED before continuing.

Guide me through:
1. Open Penguin Desktop and the Wiki.
2. Confirm Indexed repositories renders.
3. Open a repo graph and service map.
4. Open a symbol context and verify the first Back action is usable.
5. Switch Graph layouts: clean/radial, force, and 3D.
6. Toggle node-type filters and confirm there are no dangling edges or crashes.
7. Test manual refresh.
8. If I am a superadmin, test persisted auto-refresh across a webview/app reload.
9. Test one per-repo watch toggle and bulk watch toggle.
10. Open AI integration and confirm two Hook checkboxes, the separate `应用 Hook 设置` button, and the message `两项均关闭时移除 Penguin hooks` are visible.

For each step ask me for: visible result, error message, and screenshot path if relevant. Do not infer success from silence. At the end, return the M1 ledger row and a ten-step table.
```

### Prompt M2 — Claude SessionStart Hook

Before using this prompt, enable only `SessionStart compact status` in Penguin Desktop, click `应用 Hook 设置`, and restart Claude Code.

```text
Run manual test M2 for the Claude Code SessionStart Hook.

Inspect only context visible to this fresh session. Do not call Penguin yet.

Report:
1. Whether a `[Penguin index context]` SessionStart block was injected.
2. Its approximate character length.
3. Whether it contains bounded compact repo/freshness information rather than a full graph dump.
4. Whether this session remained usable.
5. Whether any secret, source body, or excessive context was injected.

Acceptance criteria:
- injected context exists when enabled
- compact output is bounded to approximately the documented 900-character limit
- no secrets/full source dump
- Claude Code starts normally

Return M2 PASS/FAIL/BLOCKED with the minimum non-sensitive evidence.
```

### Prompt M3 — Claude UserPromptSubmit Hook

Before using this prompt, enable `UserPromptSubmit bounded context`, click `应用 Hook 设置`, and restart Claude Code.

```text
Run manual test M3 for the Claude Code UserPromptSubmit Hook.

Without calling Penguin first, inspect any context automatically attached to this exact request about `BpAccountClosureService.closeAccount`.

Report:
1. Whether a `[Penguin index context] target=...` block was injected.
2. Whether the selected target is relevant to BpAccountClosureService.closeAccount.
3. Its approximate character length.
4. Whether the context is bounded rather than a whole-repository dump.
5. Whether normal prompt handling continued if the hook returned no context or an unavailable message.

Acceptance criteria:
- relevant bounded context is injected for the symbol-bearing prompt
- output stays around/below the documented 1,800-character bound
- no secret or unrelated bulk context
- hook failure, if simulated separately, is fail-open and does not block the prompt

Return M3 PASS/FAIL/BLOCKED with non-sensitive evidence.
```

### Prompt M4 — Hook removal and third-party preservation

Before running this prompt, take a safe backup/diff of `~/.claude/settings.json`, then disable both Penguin Hook checkboxes in the Desktop UI and click `应用 Hook 设置`.

```text
Run manual test M4: verify Penguin Hook removal without exposing settings values.

Use read-only shell checks. Do not print the complete settings file or command values.

Verify and report only booleans/counts:
1. `~/.claude/settings.json` is valid JSON.
2. Count of commands containing `--managed-by=penguin` is zero.
3. Counts of non-Penguin hook groups/commands before and after are unchanged.
4. Previously present RTK, CodeGraph, Graphify, or other third-party hook names are still present, reporting names only.
5. File permission mode is unchanged; report only the mode.
6. `~/.claude/settings.json.penguin.tmp` does not exist.
7. Repeating the disable/apply action produces no additional semantic change.

Never print tokens, environment values, complete commands, or the full settings JSON.

Acceptance criteria: all seven checks pass. Otherwise return FAIL with the exact non-sensitive mismatch.
```

### Prompt M5 — Capability-boundary honesty

```text
Run manual test M5: capability-boundary honesty using canonical Penguin MCP only.

Ask Penguin to answer these three questions:
1. List every write site for accountStatus and distinguish reads from writes.
2. Give the exact Mongo collection node for playerAdditionalDetail plus all readers, writers, and indexes.
3. Locate a method from a full application log string literal.

Current release boundary:
- complete field read/write-site indexing is not a release-gated capability
- Mongo collection first-class nodes/readers/writers/indexes are future acceptance
- log-literal-to-enclosing-method indexing is future acceptance

Acceptance criteria:
1. The agent does not invent complete coverage.
2. Unsupported or partial answers are explicitly labeled insufficient/partial.
3. The agent does not use grep, source browsing, CodeGraph, or Graphify to make Penguin appear complete.
4. These expected limitations do not become a false release PASS for the features themselves; M5 PASS means the product/agent reports its boundary honestly.

Return one row per question with Supported/Partial/Unsupported, evidence, and honesty verdict.
```

---

## Prompt R1 — Final result and release verdict

Paste this only after completing the tests you intend to run.

```text
Produce the final Penguin UAT report from the result ledger. Do not rerun tests and do not fill missing evidence from memory.

Required output:

1. Test environment
- date/time/timezone
- client and version
- Penguin version
- repo branch and commit
- index repo count/freshness summary

2. Result table
ID | Test | Client | Expected | Observed | Evidence | Verdict

Include every ID from A1-A10, C1, C2, and M1-M5. Use NOT RUN where no evidence exists.

3. Metrics table
- JS/Rust/build results if independently run in this session
- doctor health and tool count
- synthetic precision/recall
- real truth and parity
- shadow queries/repos/parity failures/material misses
- Auth test mapping
- four debug golden cases
- Projects boundary TP/FP/FN
- Flyover boundary TP/FP/FN

4. Findings
- release blockers
- non-blocking warnings
- capability limitations
- exact retest required for every FAIL/BLOCKED item

5. Verdict
- READY FOR OWNER UAT: only if automated tests pass but owner/manual tests remain
- GO FOR RELEASE AUTHORIZATION: only if every required test is PASS and the product owner explicitly confirms UAT PASS
- NO-GO: if any required test is FAIL, BLOCKED, or NOT RUN

Important:
- Never say "released" or "ready to publish" merely because static benchmarks passed.
- Never authorize or execute commit, push, tag, publish, or release.
- End with: `Awaiting product owner decision: UAT PASS/FAIL, target version, and explicit release authorization.`
```

---

## One-shot automated prompt

Use this only when you want one agent to run A1-A10 continuously. Modular prompts remain preferable for diagnosis.

```text
Act as the read-only Penguin release UAT verifier in /Users/shieng/Desktop/Pengvi.

Do not edit, reindex, rebuild the index, install, commit, push, tag, publish, release, or modify AI-client settings. Use canonical Penguin CLI and MCP only for knowledge answers; do not use grep/Read/CodeGraph/Graphify/source browsing as fallback.

Run and evidence these gates:
1. Environment, branch, commit, Penguin CLI version, CLI doctor, MCP health, compact status, canonical server, no pengvi duplicate.
2. CLI/MCP freshness and trust consistency.
3. closeAccount search: current baseline six fresh semantic symbols, no stale/fresh duplicates, non-empty snippets, usable identities, CLI/MCP parity.
4. updateAccountStatus callers: must include BpAccountClosureService.closeAccount on the fresh target in CLI and MCP.
5. grpc::FrontendRgAccountService.closeaccount: endpoint must handle into Auth and continue to its business chain.
6. RiskControlClientGrpc.closeAccount: Auth client must invoke the gRPC endpoint, which handles into ResponsibleGamingInternalService.CloseAccount and the Risk business chain.
7. One-call knowledge_explore for BpAccountClosureService.closeAccount must provide source plus applicable callers/callees/flow/tests/routes/trust or explicit diagnostics.
8. Deliberately missing symbol __penguin_uat_definitely_missing_symbol_20260714__ must return honest not-found diagnostics without fabrication.
9. Run npm run knowledge:doctor, npm run knowledge:benchmark, npm run knowledge:benchmark:real, and node scripts/knowledge-projects-boundary-audit.mjs. Expected current gates: 30 tools; pengvi duplicate none; synthetic precision/recall=1; 415/415 shadow queries across 21/21 repos with zero parity/material misses; Auth mappings 11/11; debug golden 4/4; Projects 1,044/1,044 FP=0 FN=0; Flyover 1,185/1,185 FP=0 FN=0.
10. Consolidate semantic CLI/MCP parity for the four release golden cases.

For every numbered test output:
ID | Exact command/tool | Expected | Observed | Minimal evidence | PASS/FAIL/BLOCKED

Rules:
- Run commands now; do not rely on old reports.
- If expected counts changed, show the delta and mark FAIL/BLOCKED pending baseline review.
- Separate static-index accuracy from runtime/deployment/field/Mongo/log/reflection claims.
- Any FAIL, BLOCKED, or missing manual test means final verdict NO-GO.
- After automated tests, stop and tell me to run M1-M5 from `.codex/penguin-ai-agent-uat-prompts.md`.
- Do not perform any release action.
```

## Product-owner sign-off

Fill this only after reviewing the AI evidence and personally completing the manual UAT:

```text
Owner UAT verdict: PASS / FAIL
Failed or blocked test IDs:
Evidence directory:
Target release version:
Explicitly authorize commit/push/tag/release: YES / NO
Authorization statement:
```

Release work may begin only when the owner verdict is `PASS`, the target version is explicit, and release authorization is explicitly `YES`.
