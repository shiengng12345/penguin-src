# Evaluate a local code index — and tell me what you actually think

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

Write everything to:

```
docs/quality/index-evaluation-<your-model-name>.md
```

Use these sections, in this order:

### 1. Summary
Three or four sentences. Would you rely on this index to understand unfamiliar
code? Under what conditions?

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

## What I am looking for

I built this. I would rather hear that it is mediocre with specifics than that it
is good in general terms. Findings I can act on are worth more than a score.

If something is broken, say it plainly. If a design choice seems wrong, say that
too, and say what you would have done instead.
