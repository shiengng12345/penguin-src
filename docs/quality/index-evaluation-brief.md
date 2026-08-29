# Evaluate a local code index — and tell me what you actually think

> **Round 6 · 2026-08-30 · build `69e601e7`**
> Five earlier rounds found twelve defects, all fixed. Their reports are in
> this directory. The Part A questions are new again this round — the
> generator takes a seed, and rounds five and six share one question of
> fourteen. See "What changed since the last round" below before you start, so
> you spend the evaluation on new ground rather than re-finding what is done.

You are being asked to use a code knowledge index called **Penguin**, judge how
good it is, and write up your findings. You are **not** changing any code.

Everything you need is in this file. Read it through before starting.

---

## What Penguin is

It parses source code into a graph — symbols, call edges, HTTP endpoints, types
— and answers questions about it without reading files. It currently holds 26
repositories and 25 live branches from a working developer machine, most of them
a real NestJS/TypeScript microservice estate plus some Rust and legacy Node.

The point of the thing is that an AI agent can understand unfamiliar code from
the index faster and more reliably than by grepping and reading files. **That is
the claim you are testing.**

---

## How to query it

The MCP server may not be connected in your session. Use the CLI — it is the
same query layer over the same database:

```sh
VN=/Applications/Penguin.app/Contents/Resources/_up_/packages/knowledge-cli/bundle/node
export PENGUIN_WASM_DIR=/Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/wasm
B=/Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/penguin.mjs

"$VN" "$B" <command> [--json]
```

Or, if `penguin` is on your PATH, just `penguin <command>`.

Start with `penguin help` — it lists every verb. The ones that matter most:

| Command | What it answers |
|---|---|
| `explore <target>` | everything about a symbol: callers, callees, source, routes, freshness |
| `context <target>` | the same as a readable markdown pack |
| `flow <endpoint\|symbol>` | the execution chain, endpoint → handler → service → db |
| `search <query>` | find symbols by name or text |
| `files <repo>` / `filesymbols <repo> <path>` | what a repo contains, what a file defines |
| `deadcode --repo X --path Y` | symbols nothing references |
| `callers <symbol>` / `impact <symbol>` | who calls it; transitive blast radius |
| `affected <file>...` | blast radius of a change |
| `architecture` | repo overview |
| `status` | what is indexed and how fresh |

Two things worth knowing:

- **`--json` shows fields the text output abbreviates.** If a text answer looks
  thin, check the JSON before concluding the index lacks the data.
- **`--repo <name>` scopes a query.** Many symbol names repeat across the 26
  repos.

---

## Ground rules

1. **Answer only from the index.** No grep, no ripgrep, no opening source files,
   no filling gaps from what you already know about NestJS or this codebase.
   Using anything else measures something other than the index.

2. **If the index cannot answer, say so.** This matters more than getting a high
   score. An honest "the index does not have this" is the most valuable thing
   you can report, because a plausible guess hides the exact gap being measured.

3. **Quote the tool output that led you to each conclusion.** "explore returned
   `ambiguous target: 9 matches`" is evidence. "It didn't work well" is not.

4. **Pass on staleness.** If a result says `freshness=stale`, or `trust` reports
   a mismatch, say so rather than presenting it as current.

5. **Note what you had to do to get an answer.** If a question took five
   commands and a workaround, that is a finding — record the commands. Effort is
   part of the quality being measured.

---

## Part A — factual accuracy (14 questions)

Read and answer **`docs/quality/index-quality-quiz.md`** in this same directory.
It has fourteen questions with verifiable answers.

Do **not** read `index-quality-answers.md`. That is the answer key, and reading
it invalidates the whole exercise.

---

## Part B — is it actually usable? (this is the more important half)

Part A measures whether the data is right. Part B measures whether it is any
good to work with. Do these four, using only the index:

**B1 · Onboarding.** You have just joined this team and been handed the repo
`FPMS-NT`. Using only Penguin, write the orientation you would want on day one:
what the major subsystems are, which are the busiest entry points, and where you
would start reading. Then say honestly how confident you are, and what the index
did not tell you that you would have wanted.

**B2 · Trace a request.** Pick any HTTP endpoint the index knows about. Follow it
all the way down — handler, service, data access — and describe what happens on
that request. Say where the chain broke, if it did, and how you noticed.

**B3 · Change impact.** Pick a function with several callers. Answer: if I change
its signature, what breaks? Name every call site with `file:line`. Then say how
much you would trust that list if you were about to actually make the change,
and why.

**B4 · Find something wrong.** Use the index to find a real problem in the
indexed code — dead code that looks genuinely dead, a suspicious dependency, a
duplicated implementation, an endpoint with no tests. One concrete finding with
evidence beats a list of maybes.

---

## Part C — write the report

### Where to write it — read this before you write anything

Write to a file in `docs/quality/` named:

```
index-evaluation-<model>-<round>.md
```

- `<model>` — your own model name, lowercased, spaces and dots as hyphens.
  `gpt-5`, `opus-5`, `gemini-3-pro`, `sonnet-4-5`.
- `<round>` — `round2`, `round3`, and so on. Earlier evaluations are kept for
  comparison, so **do not overwrite an existing file.**

**Before writing, list the directory and pick a name that is not already
taken.** These already exist as of this brief:

```
index-evaluation-gpt-5.md            (round 1)
index-evaluation-opus-5.md           (round 1)
index-evaluation-gpt-5-round2.md     (round 2)
index-evaluation-opus-5-round2.md    (round 2)
index-evaluation-gpt-5-round3.md     (round 3)
index-evaluation-opus-5-round3.md    (round 3)
index-evaluation-gpt-5-round4.md     (round 4)
index-evaluation-opus-5-round4.md    (round 4)
index-evaluation-gpt-5-round5.md     (round 5)
index-evaluation-opus-5-round5.md    (round 5)
```

So a sixth GPT-5 run writes `index-evaluation-gpt-5-round6.md`. If your name is
already taken at the round you picked, go up a round — never replace a file that
is there.

If you genuinely cannot tell which model you are, use a short distinctive label
instead of guessing at a version, and say in the report's first line what you
actually are.

State the full path you wrote to as the last line of your reply.

### Sections — use these, in this order:

### 1. Summary and scores

Three or four sentences first: would you rely on this index to understand
unfamiliar code, and under what conditions?

Then score it. Give a whole number out of 100 for each row, and one line saying
what that number is based on — the score without the reason is not useful to me.

| Dimension | Score | Why that number |
|---|---|---|
| **Accuracy** — is what it tells you true? | /100 | |
| **Completeness** — does it find everything, or quietly miss things? | /100 | |
| **Honesty** — when it cannot answer, does it say so? | /100 | |
| **Usability** — how much work to get an answer you can act on? | /100 | |
| **Speed vs grep + reading files** — is it actually faster? | /100 | |
| **Overall** — would you install this? | /100 | |

Round five scored it 62 overall — accuracy 64, completeness 52, honesty 63,
usability 54, speed 80 — and a second model independently put completeness
lowest and speed highest. Score what you find, not what you think I want to
hear: a number that drifts up while the same complaints repeat would be the one
signal here I could not trust.

Use this scale so the numbers mean the same thing across rounds:

- **90–100** — I would trust this without checking, and act on it directly.
- **70–89** — I would trust it after a spot-check.
- **50–69** — useful as a lead, must be verified before acting.
- **30–49** — faster than nothing, but I check everything it says.
- **1–29** — I would not use it.

Then answer one question in a sentence or two: **what single change would move
your overall score up by ten points?** That is the most useful thing in this
whole report, so make it concrete.

### 2. Part A answers
One block per question, in the format the quiz specifies.

### 3. Part B write-ups
One section per task. Include the commands you ran.

### 4. What worked well
Be specific and give examples. "The call graph is accurate" is worth little
without the query and the result that convinced you.

### 5. What did not work
Every place the index was wrong, silent, confusing, or made you work for an
answer you should have got in one call. Include the exact output. **This is the
section I care most about — do not soften it.**

### 6. Pros and cons
A plain table. Judge it as a tool you might use daily, against the alternative
of grep plus reading files.

### 7. Suggestions
Concrete changes, ordered by how much difference they would make. For each, say
what problem it solves and roughly what it would cost. Include anything you
wanted and could not find at all — a missing capability is a suggestion too.

### 8. How it felt to use
Written as a user, not a test harness. Where did you get stuck, what surprised
you, what did you expect that was not there, what would make you reach for it
again — or not.

---

## What changed since the last round

Twelve defects reported by earlier reviewers have been fixed across five rounds.
If you hit any of these, it is a regression worth reporting loudly; if it works,
one line is enough — do not spend the evaluation re-testing them.

From rounds one and two:

- `completeness.status` never says "complete". It reports `lower_bound` (the
  calls list omits constructor calls, interface dispatch, static calls and calls
  inside callbacks), `partial` (plus unresolvable external calls, named in
  `externalCalls`), or `unknown` (nothing resolved).
- A target that does not resolve returns `confidence: low`, not `high`.
- `penguin callers X` reports a failed lookup instead of printing `(none)`;
  a genuinely empty result says `(no results)`.
- `--repo` narrows resolution in `explore`, `context`, `flow`, `callers`,
  `calls`, `impact`, `filesymbols`, `deadcode` and `architecture`.
- `architecture --repo` no longer dumps all 26 repos, and `repograph` ranks on
  calls/references/invokes/handles with the degree reported per node, instead of
  counting imports and putting `.spec.ts` files at the top.

From round five:

- `flow` renders the tree it actually traversed. Steps carry `parentNodeId`, so
  a step nests under the node it really hangs off. Before this the renderer
  indented by depth alone and showed a TypeScript interface as the caller of
  thirteen functions.

From round four:

- `penguin affected <path>` without `--repo` used to resolve its scope from the
  working directory, so asking about another repo's file printed
  "changed 0 · impacted 0" — a confident wrong negative. It now says no indexed
  file matches the path in the resolved scope and names the repos that contain
  it.
- Search hits carry `nodeId` and `symbol` for the innermost symbol containing
  them, so a hit feeds straight into `explore` instead of being a dead end. A
  hit with no symbol at that line carries no handle rather than a wrong one.

From round three:

- Graph results carry `truncated` when they sit at the limit, so a capped list
  of exactly 100 no longer reads as the complete answer.
- Dead-code candidates carry `fileImportedBy`: how many files import the file
  they live in. Zero is the strong case; a positive count is what DI and
  decorator wiring look like. The candidate is still listed either way —
  an import is not a call — but the two are now distinguishable.

Three of those eleven were the same mistake in different clothes: **a lookup
that failed, rendered as an answer that succeeded** — `callers` printing
`(none)`, `explore` reporting `complete` with `confidence: high` beside an empty
pack, `affected` printing `changed 0`. If you find a fourth instance of that
shape anywhere, it is the most valuable thing you can report.

Everything else is fair game, including anything an earlier round reported that
you think was judged wrongly. One earlier claim was rejected on inspection:
`deadcode` was said to ignore symbol-level `imports` edges, but all 86,745
active import edges are file-to-file, so no such edge exists to count. If you
think that judgment was wrong, say so.

## What I am looking for

I built this. I would rather hear that it is mediocre with specifics than that it
is good in general terms.

Score it honestly and low if it deserves low. A generous number tells me nothing
and costs me the one signal I can compare across rounds — earlier reports are in
this directory, so a score that drifts up while the same complaints repeat is
worse than useless. The reasons matter more than the numbers, and the
ten-points question matters most of all.

If something is broken, say it plainly. If a design choice seems wrong, say that
too, and say what you would have done instead.
