export interface MarkdownProperty { key: string; ordinal: number; valueType: "string" | "number" | "boolean" | "date" | "list" | "null"; valueText: string | null; valueNumber: number | null; valueBoolean: boolean | null; valueDate: string | null; sourceLine: number; }

export interface MarkdownPropertyValidation { valid: boolean; errors: Array<{ key: string; code: "invalid_type" | "invalid_value"; message: string }>; }

const RESERVED_PROPERTY_RULES: Record<string, { types: MarkdownProperty["valueType"][]; values?: string[] }> = {
  id: { types: ["string"] }, title: { types: ["string"] }, type: { types: ["string"], values: ["why", "evidence", "decision", "incident", "compliance", "bug", "requirement", "saved-query", "credential"] },
  aliases: { types: ["list"] }, tags: { types: ["list"] }, status: { types: ["string"], values: ["draft", "reviewed", "verified", "resolved", "archived", "open", "closed"] },
  repo: { types: ["string", "list"] }, revision: { types: ["string"] }, owners: { types: ["string", "list"] }, sensitive: { types: ["boolean"] }, mcp_access: { types: ["string"], values: ["allowed", "denied"] },
};

/** Validate reserved Obsidian/Penguin properties without dropping unknown keys. */
export function validateMarkdownProperties(frontmatter: Record<string, unknown>): MarkdownPropertyValidation {
  const errors: MarkdownPropertyValidation["errors"] = [];
  for (const property of extractMarkdownProperties(frontmatter, "")) {
    const rule = RESERVED_PROPERTY_RULES[property.key];
    if (!rule) continue;
    if (!rule.types.includes(property.valueType)) errors.push({ key: property.key, code: "invalid_type", message: `${property.key} must be ${rule.types.join(" or ")}` });
    if (rule.values && property.valueText !== null && !rule.values.includes(property.valueText)) errors.push({ key: property.key, code: "invalid_value", message: `${property.key} has an unsupported value` });
  }
  return { valid: errors.length === 0, errors };
}

function typed(value: unknown): MarkdownProperty["valueType"] {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return "date";
  return "string";
}

export function extractMarkdownProperties(frontmatter: Record<string, unknown>, source: string): MarkdownProperty[] {
  const lineByKey = new Map<string, number>();
  for (const [index, line] of source.split(/\r?\n/).entries()) { const match = line.match(/^([A-Za-z0-9_.-]+):/); if (match && !lineByKey.has(match[1])) lineByKey.set(match[1], index + 1); }
  const out: MarkdownProperty[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    const values = Array.isArray(value) ? value : [value];
    values.forEach((item, ordinal) => { const valueType = Array.isArray(value) ? "list" : typed(item); out.push({ key, ordinal, valueType, valueText: valueType === "string" || valueType === "list" || valueType === "date" ? String(item) : null, valueNumber: typeof item === "number" ? item : null, valueBoolean: typeof item === "boolean" ? item : null, valueDate: valueType === "date" ? String(item) : null, sourceLine: lineByKey.get(key) ?? 1 }); });
  }
  return out;
}
