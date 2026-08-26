import type { ValidatedInvestigationRequest } from "./log-investigation-contract.js";

// English function words appear in virtually every indexed source file, so as
// search terms they only force the source lane to materialize six-figure
// occurrence counts that the page limit then throws away. Question text is
// prose and gets filtered; explicit clue values are the caller's choice and
// always pass through. Identifier-shaped terms (forEach, trace_context.go)
// never match the pure-alphabetic guard and survive.
const QUESTION_STOPWORDS = new Set([
  "the", "and", "for", "not", "but", "with", "without", "that", "this", "these", "those",
  "from", "into", "onto", "over", "under", "between", "during", "before", "after", "while",
  "when", "where", "what", "which", "who", "whom", "whose", "why", "how",
  "are", "was", "were", "been", "being", "has", "have", "had", "having",
  "does", "did", "doing", "done", "will", "would", "shall", "should", "can", "could",
  "may", "might", "must", "all", "any", "each", "few", "more", "most", "some", "such",
  "only", "also", "just", "than", "then", "there", "here", "its", "his", "her", "him",
  "she", "they", "them", "their", "our", "your", "you", "per", "via", "off", "out",
  "own", "same", "too", "very", "about", "because", "again", "still", "please",
]);

export function preflightSearchTerms(request: Pick<ValidatedInvestigationRequest, "question" | "clues">): string[] {
  const clueTerms = [
    ...request.clues.traceIds ?? [], ...request.clues.requestIds ?? [],
    ...request.clues.playerIds ?? [], ...request.clues.proposalIds ?? [],
    ...request.clues.routes ?? [], ...request.clues.methods ?? [],
    ...request.clues.keywords ?? [],
  ];
  const questionTerms = request.question
    .split(/[^A-Za-z0-9_.:/-]+/)
    .filter((term) => term.length >= 3)
    .filter((term) => !(/^[A-Za-z]+$/.test(term) && QUESTION_STOPWORDS.has(term.toLowerCase())));
  return [...new Set([...clueTerms, ...questionTerms].map((term) => term.trim()).filter(Boolean))].slice(0, 24);
}
