# Penguin Knowledge Round 26 — New Session Evaluation Instruction

## Copy this prompt into a completely new Codex or Claude Code process

```text
You are an independent black-box evaluator. This must be a genuinely new
operating-system Codex or Claude Code process started after the latest Penguin
App installation. Do not trust earlier scores, reports, IDs, targets, paths,
cursors, answers, or conclusions.

Read the complete active evaluation brief first:

/Users/shieng/Desktop/Pengvi/docs/quality/index-evaluation-brief.md

Then execute every requirement in that brief, including Q1-Q20, B1-B8, all
evidence tables, hard gates, scoring, and closure rules.

Strict boundaries:

1. After reading the brief, use Penguin MCP as the only product/data path.
2. Do not inspect source code, Git, SQLite, terminal output, Penguin CLI,
   implementation plans, bundles, old reports, or another indexing product.
3. Stay read-only. Never invoke repository registration, index, rebuild,
   semantic control, note/memory writes, or any mutating operation.
4. Discover every repo, branch, file, symbol, endpoint, node ID, generation ID,
   and cursor from responses in this fresh MCP session.
5. Use new dynamic targets. Do not copy targets or expected answers from the
   brief or any previous evaluation.
6. Never convert incomplete coverage, unresolved references, truncation,
   exclusions, stale state, semantic fallback, or a missing edge into proof of
   absence.
7. Separate DIRECT MCP EVIDENCE from INFERENCE. Use PARTIAL, UNPROVEN,
   BLOCKED, or N/A whenever the MCP evidence is insufficient.
8. Continue through the complete evaluation even if one scenario fails. Record
   the failure and its effect on hard gates and scoring.
9. Create exactly one report. Do not read or modify the other evaluator's
   report.

Report path:

- If you are Codex:
  /Users/shieng/Desktop/Pengvi/docs/quality/index-evaluation-codex-round26.md
- If you are Claude Code:
  /Users/shieng/Desktop/Pengvi/docs/quality/index-evaluation-claude-opus-5-round26.md

Mandatory per-scenario scoring:

- Score every Q1-Q20 separately from 0-100.
- Score every B1-B8 separately from 0-100.
- For every score include: verdict, direct MCP evidence, evidence location or
  stable identity, duration, completeness/coverage limitation, failure reason,
  and required remediation.
- A scenario without enough evidence cannot receive more than 69/100.
- A blocked or unexecuted scenario must receive 0-49/100 and must not be
  silently excluded from the total.
- Bonus scenarios do not add bonus points. They are diagnostic evidence that
  can reduce the relevant category when they expose a defect.

Mandatory category scoring:

Score every category independently from 0-100, then calculate the weighted
contribution exactly:

weighted contribution = category score × category weight / 100

Use these weights:

1. Runtime identity, installed MCP parity, reliability — 10%
2. Discoverability, schemas, annotations, onboarding, remediation — 14%
3. Exact, lexical, graph, context, flow usefulness and latency — 20%
4. Semantic readiness, model identity, hybrid honesty, lifecycle — 16%
5. Stable identity, pagination, cursor correctness, affected parity — 20%
6. File reconciliation, coverage debt, cache hygiene, negative-proof honesty — 15%
7. Compactness and Agent handoff usability — 5%

The seven weighted contributions must sum to the raw total out of 100. Show
the arithmetic. Do not average category scores without weights and do not round
a lower score upward.

Accuracy and evidence requirements:

- For positive claims, require repo + branch + revision/snapshot + stable
  identity + file:line provenance when the capability should provide it.
- Test both precision and recall through the brief's dynamic forward and
  reverse checks.
- Confirm repeated queries are deterministic under identical inputs.
- Confirm no cross-repository or cross-branch leakage.
- Confirm endpoint discovery, continuation, handler selection, and flow remain
  evidence-bearing.
- Confirm affected results distinguish proven impact from lower-bound risk and
  do not treat filenames as test-execution proof.
- Confirm cursor totals, page limits, ordering, overlap, exhaustion, family
  mismatch, and tamper errors.
- Confirm exact/graph/lexical queries stay useful when semantic/vector work is
  unavailable or incomplete.
- Semantic similarity may assist discovery but cannot independently prove call
  direction, ownership, execution, impact completeness, or safe deletion.

Hard-gate scoring rule:

- List every hard gate as PASS or FAIL with direct evidence.
- If any hard gate in the active brief fails, the final score cannot be 95 or
  above, even when the mathematical raw score is higher.
- Show both `Raw weighted score` and `Hard-gate-adjusted final score`.
- If the evaluation boundary is violated by using source, Git, DB, CLI, old
  reports, or mutation, mark the report INVALID and do not claim acceptance.
- Award 95-100 only when all hard gates pass and every category has sufficient
  direct evidence.

Required scoring tables in the report:

| Scenario | Score /100 | Verdict | Direct MCP evidence | Limitation/failure | Remediation |
| --- | ---: | --- | --- | --- | --- |

Create one row for every Q1-Q20 and a separate table for every B1-B8.

| Category | Weight | Category score /100 | Weighted contribution | Evidence summary | Remaining gap |
| --- | ---: | ---: | ---: | --- | --- |

| Hard gate | PASS/FAIL | Direct evidence | Score impact |
| --- | --- | --- | --- |

Final report conclusion must include:

1. Evaluator/model and fresh-process proof.
2. MCP session ID, connection time, runtime/build/schema/contract/capability
   identity discovered in this session.
3. Q1-Q20 scores and B1-B8 scores, each out of 100.
4. Seven category scores, each out of 100, with exact weighted arithmetic.
5. Raw weighted score /100.
6. Hard-gate-adjusted final score /100.
7. Accuracy, recall, evidence quality, completeness, reliability, latency,
   semantic/vector readiness, and first-user usability verdicts.
8. Every hard-gate failure.
9. The five highest-priority remaining defects with reproducible MCP evidence.
10. Final verdict: GO, CONDITIONAL GO, NO-GO, or INVALID.

When finished, reply with the report's full absolute path, raw score, adjusted
score, verdict, hard-gate failures, and the three most serious defects.
```

## Expected scoring format

The evaluator must score every individual scenario, not merely provide one
overall impression. The final report therefore contains three distinct score
levels:

| Score level | Required output |
| --- | --- |
| Scenario | Q1-Q20 and B1-B8 each receive `x/100` |
| Category | All seven weighted categories each receive `x/100` |
| Product | Raw weighted score and hard-gate-adjusted final score, both `/100` |

The scenario scores expose exactly where Penguin succeeds or fails. The
weighted category scores remain aligned with the canonical Round 26 scoring
contract. The hard-gate-adjusted score prevents a serious identity, evidence,
cursor, scope, mutation-safety, or semantic-honesty failure from being hidden
inside an otherwise high average.

