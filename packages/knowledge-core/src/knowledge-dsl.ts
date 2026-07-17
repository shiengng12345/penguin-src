import type { SearchMode, SearchRequest } from "@penguin/knowledge-contracts";

export interface KnowledgeDslPredicate { field: string; operator: ":" | "=" | ">=" | "<=" | ">" | "<"; value: string; position: number; }
export type KnowledgeDslExpression = { kind: "predicate"; predicate: KnowledgeDslPredicate } | { kind: "not"; child: KnowledgeDslExpression } | { kind: "and" | "or"; children: KnowledgeDslExpression[] };
export interface CompiledKnowledgeDsl { request: SearchRequest; expression: KnowledgeDslExpression; propertyPredicates: KnowledgeDslPredicate[]; markdownPredicates: KnowledgeDslPredicate[]; }

const FIELDS = new Set(["path", "file", "content", "tag", "property", "line", "section", "block", "task", "regex", "repo", "branch", "kind"]);
const MODES = new Set<SearchMode>(["auto", "exact", "phrase", "substring", "path", "regex", "lexical", "semantic", "structural"]);

function tokenize(input: string): Array<{ value: string; position: number }> {
  const out: Array<{ value: string; position: number }> = [];
  for (let i = 0; i < input.length;) {
    if (/\s/.test(input[i])) { i += 1; continue; }
    const position = i;
    if ("()".includes(input[i])) { out.push({ value: input[i], position }); i += 1; continue; }
    let value = "";
    if (input[i] === '"') {
      i += 1;
      while (i < input.length && input[i] !== '"') value += input[i++];
      if (input[i] !== '"') throw new Error(`DSL_UNTERMINATED_QUOTE@${position}`);
      i += 1;
    } else if (input[i] === "/") {
      value += input[i++];
      while (i < input.length) { const ch = input[i++]; value += ch; if (ch === "/" && input[i - 2] !== "\\") break; }
      while (i < input.length && /[a-z]/i.test(input[i])) value += input[i++];
    } else {
      while (i < input.length && !/\s|[()<>:=]/.test(input[i])) value += input[i++];
    }
    out.push({ value, position });
    if (i < input.length && ":=<>".includes(input[i])) {
      const opPos = i; const two = input.slice(i, i + 2);
      const operator = [">=", "<="].includes(two) ? two : input[i];
      out.push({ value: operator, position: opPos }); i += operator.length;
    }
  }
  return out;
}

export function compileKnowledgeDsl(input: string): CompiledKnowledgeDsl {
  const tokens = tokenize(input.trim());
  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];
  const parseAtom = (): KnowledgeDslExpression => {
    if (peek()?.value === "(") { take(); const child = parseOr(); if (take()?.value !== ")") throw new Error(`DSL_EXPECTED_CLOSE@${peek()?.position ?? input.length}`); return child; }
    if (peek()?.value?.toUpperCase() === "NOT") { take(); return { kind: "not", child: parseAtom() }; }
    const field = take();
    if (!field || !FIELDS.has(field.value)) throw new Error(`DSL_UNKNOWN_FIELD@${field?.position ?? input.length}`);
    const op = take();
    if (!op || ![":", "=", ">=", "<=", ">", "<"].includes(op.value)) throw new Error(`DSL_EXPECTED_OPERATOR@${op?.position ?? input.length}`);
    const value = take();
    if (!value || ["(", ")", "AND", "OR"].includes(value.value.toUpperCase())) throw new Error(`DSL_EXPECTED_VALUE@${value?.position ?? input.length}`);
    if (field.value === "property" && op.value === ":" && peek() && ["=", ">=", "<=", ">", "<"].includes(peek().value)) {
      const comparison = take();
      const comparisonValue = take();
      if (!comparisonValue) throw new Error(`DSL_EXPECTED_VALUE@${comparison?.position ?? input.length}`);
      return { kind: "predicate", predicate: { field: "property", operator: comparison!.value as KnowledgeDslPredicate["operator"], value: `${value.value}=${comparisonValue.value}`, position: field.position } };
    }
    return { kind: "predicate", predicate: { field: field.value, operator: op.value as KnowledgeDslPredicate["operator"], value: value.value, position: field.position } };
  };
  const parseAnd = (): KnowledgeDslExpression => { const children = [parseAtom()]; while (peek() && peek().value.toUpperCase() === "AND") { take(); children.push(parseAtom()); } return children.length === 1 ? children[0] : { kind: "and", children }; };
  const parseOr = (): KnowledgeDslExpression => { const children = [parseAnd()]; while (peek() && peek().value.toUpperCase() === "OR") { take(); children.push(parseAnd()); } return children.length === 1 ? children[0] : { kind: "or", children }; };
  if (!tokens.length) throw new Error("DSL_EMPTY@0");
  const expression = parseOr();
  if (cursor < tokens.length) throw new Error(`DSL_UNEXPECTED_TOKEN@${tokens[cursor].position}`);
  const predicates: KnowledgeDslPredicate[] = [];
  const walk = (node: KnowledgeDslExpression) => { if (node.kind === "predicate") predicates.push(node.predicate); else if (node.kind === "not") walk(node.child); else node.children.forEach(walk); };
  walk(expression);
  const content = predicates.find((p) => p.field === "content" || p.field === "line" || p.field === "section" || p.field === "block" || p.field === "tag")?.value
    ?? predicates.find((p) => p.field === "file" || p.field === "path")?.value
    ?? predicates.find((p) => p.field === "property")?.value
    ?? predicates[0]?.value ?? "";
  const mode: SearchMode = predicates.some((p) => p.field === "regex") ? "regex" : predicates.some((p) => p.field === "path" || p.field === "file") ? "path" : "auto";
  if (predicates.some((p) => p.field === "regex" && !/^\/.*\/[a-z]*$/i.test(p.value))) throw new Error(`DSL_REGEX_INVALID@${predicates.find((p) => p.field === "regex")!.position}`);
  if (predicates.some((p) => p.field === "mode" && !MODES.has(predicates.find((p) => p.field === "mode")!.value as SearchMode))) throw new Error("DSL_MODE_INVALID");
  const path = predicates.filter((p) => p.field === "path" || p.field === "file").map((p) => p.value);
  const repo = predicates.find((p) => p.field === "repo")?.value;
  const branch = predicates.find((p) => p.field === "branch")?.value;
  const kinds = predicates.filter((p) => p.field === "kind").map((p) => p.value);
  return { request: { query: content, mode, scope: { ...(path.length ? { paths: path } : {}), ...(repo || branch ? { revisions: [{ ...(repo ? { repoName: repo } : {}), ...(branch ? { branch } : {}) }] } : {}), ...(kinds.length ? { kinds } : {}) }, options: { explain: true } }, expression, propertyPredicates: predicates.filter((p) => p.field === "property"), markdownPredicates: predicates.filter((p) => ["line", "section", "block", "tag", "task"].includes(p.field)) };
}
