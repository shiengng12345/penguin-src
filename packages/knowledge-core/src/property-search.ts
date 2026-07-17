import type { SearchHit } from "@penguin/knowledge-contracts";
import type { KnowledgeStore } from "./store.js";
import type { KnowledgeDslPredicate } from "./knowledge-dsl.js";

function matches(value: { valueType: string; valueText: string | null; valueNumber: number | null; valueBoolean: number | null; valueDate: string | null }, operator: string, expected: string): boolean {
  const actual = value.valueType === "number" ? value.valueNumber : value.valueType === "boolean" ? Boolean(value.valueBoolean) : value.valueType === "date" ? value.valueDate : value.valueText;
  const right = typeof actual === "number" ? Number(expected) : typeof actual === "boolean" ? expected.toLowerCase() === "true" : expected;
  if (operator === ":" || operator === "=") return String(actual).toLocaleLowerCase() === String(right).toLocaleLowerCase();
  if (typeof actual !== "number" || typeof right !== "number") return false;
  if (operator === ">=") return actual >= right;
  if (operator === "<=") return actual <= right;
  if (operator === ">") return actual > right;
  if (operator === "<") return actual < right;
  return false;
}

/** Apply typed Markdown property predicates without treating property values as FTS text. */
export function filterHitsByPropertyPredicates(store: KnowledgeStore, hits: SearchHit[], predicates: KnowledgeDslPredicate[]): SearchHit[] {
  if (!predicates.length) return hits;
  const propertyRows = store.db.prepare("SELECT n.path,p.property_key AS propertyKey,p.value_type AS valueType,p.value_text AS valueText,p.value_number AS valueNumber,p.value_boolean AS valueBoolean,p.value_date AS valueDate FROM notes_index n JOIN note_properties p ON p.note_node_id=n.node_id").all() as Array<{ path: string; propertyKey: string; valueType: string; valueText: string | null; valueNumber: number | null; valueBoolean: number | null; valueDate: string | null }>;
  const byPath = new Map<string, typeof propertyRows>();
  for (const row of propertyRows) byPath.set(row.path, [...(byPath.get(row.path) ?? []), row]);
  return hits.filter((hit) => {
    const path = hit.locator.filePath;
    const rows = byPath.get(path) ?? [];
    return predicates.every((predicate) => {
      const equal = predicate.value.match(/^([^=<>]+)=(.*)$/);
      const key = equal?.[1] ?? predicate.value;
      const expected = equal?.[2] ?? "true";
      return rows.some((row) => row.propertyKey === key && matches(row, predicate.operator, expected));
    });
  });
}

function noteBody(store: KnowledgeStore, path: string): { body: string; nodeId: string } | undefined {
  return store.db.prepare("SELECT f.node_id AS nodeId, f.body FROM fts_notes f JOIN notes_index n ON n.node_id=f.node_id WHERE n.path=? LIMIT 1").get(path) as { body: string; nodeId: string } | undefined;
}

function lineFor(body: string, value: string): number | undefined {
  const index = body.toLocaleLowerCase().indexOf(value.toLocaleLowerCase());
  return index < 0 ? undefined : body.slice(0, index).split(/\r?\n/).length;
}

function sectionRange(body: string, value: string): { start: number; end: number } | undefined {
  const lines = body.split(/\r?\n/);
  const headings = lines.map((line, index) => ({ line: index + 1, match: line.match(/^(#{1,6})\s+(.+)$/) })).filter((item) => item.match);
  const found = headings.find((item) => item.match![2].toLocaleLowerCase().includes(value.toLocaleLowerCase()));
  if (!found) return undefined;
  const level = found.match![1].length;
  const next = headings.find((item) => item.line > found.line && item.match![1].length <= level);
  return { start: found.line, end: (next?.line ?? lines.length + 1) - 1 };
}

/** Apply line/section/block/tag/task DSL predicates and return precise note locators. */
export function filterHitsByMarkdownPredicates(store: KnowledgeStore, hits: SearchHit[], predicates: KnowledgeDslPredicate[]): SearchHit[] {
  if (!predicates.length) return hits;
  return hits.flatMap((hit) => {
    if (hit.lane !== "note" || !hit.locator.filePath) return [];
    const source = noteBody(store, hit.locator.filePath);
    if (!source) return [];
    let startLine: number | undefined;
    let startChar: number | undefined;
    for (const predicate of predicates) {
      const body = source.body;
      let line: number | undefined;
      if (predicate.field === "section") {
        const range = sectionRange(body, predicate.value);
        if (!range) return [];
        line = range.start;
      } else if (predicate.field === "block") {
        line = lineFor(body, `^${predicate.value}`) ?? lineFor(body, `^${predicate.value} `);
        if (!line) return [];
      } else if (predicate.field === "task") {
        const task = predicate.value.toLocaleLowerCase() === "open" ? "- [ ]" : predicate.value.toLocaleLowerCase() === "done" ? "- [x]" : predicate.value;
        line = lineFor(body, task);
        if (!line) return [];
      } else {
        line = lineFor(body, predicate.value);
        if (!line) return [];
      }
      if (startLine === undefined || predicate.field !== "section") startLine = line;
      if (startChar === undefined || predicate.field !== "section") startChar = body.split(/\r?\n/).slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0);
    }
    const byte = startChar === undefined ? undefined : Buffer.byteLength(source.body.slice(0, startChar), "utf8");
    const endByte = byte === undefined ? undefined : byte + Buffer.byteLength(predicates[0].value, "utf8");
    return [{ ...hit, locator: { ...hit.locator, ...(startLine === undefined ? {} : { startLine, endLine: startLine }), ...(byte === undefined ? {} : { startByte: byte, endByte }) }, rankReasons: [...hit.rankReasons, "exact Markdown line/section/block locator"] }];
  });
}
