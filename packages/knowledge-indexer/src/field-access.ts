export type FieldAccessKind = "reads_field" | "writes_field" | "passes_field";

export interface FieldAccess {
  object: string;
  field: string;
  kind: FieldAccessKind;
  startLine: number;
  method: "EXTRACTED" | "INFERRED";
}

/** Conservative field access extraction for JS/TS. Static property names are
 * exact; computed names deliberately become inferred candidates. */
export function extractFieldAccesses(source: string): FieldAccess[] {
  const out: FieldAccess[] = [];
  const seen = new Set<string>();
  const add = (access: FieldAccess) => {
    const key = `${access.startLine}:${access.object}:${access.field}:${access.kind}:${access.method}`;
    if (!seen.has(key)) { seen.add(key); out.push(access); }
  };
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.replace(/\/\/.*$/, "");
    const lineNumber = index + 1;
    for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\b/g)) {
      const assignment = new RegExp(`\\b${match[1]}\\.${match[2]}\\s*=`).test(line);
      add({ object: match[1], field: match[2], kind: assignment ? "writes_field" : "reads_field", startLine: lineNumber, method: "EXTRACTED" });
    }
    for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\[\s*(["'])([^"']+)\2\s*\]/g)) {
      const assignment = /\]\s*=/.test(line.slice(match.index ?? 0));
      add({ object: match[1], field: match[3], kind: assignment ? "writes_field" : "reads_field", startLine: lineNumber, method: "EXTRACTED" });
    }
    for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\[\s*([^\]"'][^\]]*)\]/g)) {
      add({ object: match[1], field: "<computed>", kind: /\]\s*=/.test(line.slice(match.index ?? 0)) ? "writes_field" : "reads_field", startLine: lineNumber, method: "INFERRED" });
    }
    const destructuring = line.match(/\{\s*([A-Za-z_$][\w$]*)[^}]*\}\s*=\s*([A-Za-z_$][\w$]*)/);
    if (destructuring) add({ object: destructuring[2], field: destructuring[1], kind: "reads_field", startLine: lineNumber, method: "EXTRACTED" });
    for (const match of line.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) add({ object: match[1], field: "<spread>", kind: "passes_field", startLine: lineNumber, method: "EXTRACTED" });
    for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*:/g)) {
      if (!/^\s*(?:case|default)\b/.test(line)) add({ object: "<object>", field: match[1], kind: "writes_field", startLine: lineNumber, method: "EXTRACTED" });
    }
  }
  return out;
}
