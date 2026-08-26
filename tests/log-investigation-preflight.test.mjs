import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightSearchTerms } from "../packages/mcp/dist/log-investigation-preflight.js";

const emptyClues = { traceIds: [], requestIds: [], playerIds: [], proposalIds: [], routes: [], methods: [], keywords: [] };

test("question stopwords are not turned into knowledge search terms", () => {
  const terms = preflightSearchTerms({
    question: "why did the withdraw request fail for player 8801",
    clues: { ...emptyClues, playerIds: ["8801"], keywords: ["turnstile"] },
  });
  assert.ok(terms.includes("withdraw"));
  assert.ok(terms.includes("player"));
  assert.ok(terms.includes("8801"));
  assert.ok(terms.includes("turnstile"));
  for (const stopword of ["why", "did", "the", "for"]) assert.ok(!terms.includes(stopword), `stopword leaked: ${stopword}`);
});

test("identifier-shaped question terms survive the stopword filter", () => {
  const terms = preflightSearchTerms({ question: "the forEach handler in trace_context.go", clues: { ...emptyClues, keywords: ["x"] } });
  assert.ok(terms.includes("forEach"));
  assert.ok(terms.includes("trace_context.go"));
  assert.ok(!terms.includes("the"));
});

test("explicit clue values survive even when they look like stopwords", () => {
  const terms = preflightSearchTerms({ question: "boom", clues: { ...emptyClues, keywords: ["for"] } });
  assert.ok(terms.includes("for"));
});

test("terms are trimmed, deduplicated, and capped at 24", () => {
  const keywords = Array.from({ length: 40 }, (_, i) => ` kw${i} `);
  const terms = preflightSearchTerms({ question: "kw0 kw1", clues: { ...emptyClues, keywords } });
  assert.equal(terms.length, 24);
  assert.ok(terms.includes("kw0"));
  assert.equal(new Set(terms).size, terms.length);
});
