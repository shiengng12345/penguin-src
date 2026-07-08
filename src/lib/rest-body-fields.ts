import type { RestBodyField, RestBodyValueType } from "@/components/rest/rest-types";

// Serialize the REST "key-value" body editor into a JSON body. Each row carries
// a `type` so the form can express anything JSON can (string/number/boolean/
// null, plus object/array whose `value` is a JSON snippet). Disabled rows and
// rows with a blank key are skipped. Duplicate keys: last one wins (matches how
// a JSON object would collapse them).

let idCounter = 0;

export function newBodyField(): RestBodyField {
  idCounter += 1;
  return { id: `f${idCounter}_${idCounter}`, key: "", type: "string", value: "", enabled: true };
}

// Coerce one row's string `value` into its JSON value per `type`. object/array
// parse the value as JSON; if that fails we fall back to the raw string so the
// build never throws (the user sees their text rather than losing the field).
export function coerceFieldValue(type: RestBodyValueType, value: string): unknown {
  switch (type) {
    case "number": {
      const n = Number(value);
      return Number.isFinite(n) ? n : value; // non-numeric → keep as-is (visible)
    }
    case "boolean":
      return value.trim().toLowerCase() === "true";
    case "null":
      return null;
    case "object":
    case "array": {
      try {
        return JSON.parse(value);
      } catch {
        return value; // invalid JSON snippet → keep raw string
      }
    }
    case "string":
    default:
      return value;
  }
}

// Build the JSON body string from the rows. Pretty-printed so the sent body is
// inspectable; empty when no usable rows.
export function fieldsToJson(fields: RestBodyField[]): string {
  const obj: Record<string, unknown> = {};
  for (const f of fields) {
    if (!f.enabled) continue;
    const key = f.key.trim();
    if (!key) continue;
    obj[key] = coerceFieldValue(f.type, f.value);
  }
  return JSON.stringify(obj, null, 2);
}

// Move a row from one index to another (drag-reorder). Returns a new array;
// out-of-range / equal indices return the input unchanged. The JSON body key
// order follows this array order (fieldsToJson emits keys in order).
export function moveField(fields: RestBodyField[], from: number, to: number): RestBodyField[] {
  if (from === to || from < 0 || from >= fields.length || to < 0 || to >= fields.length) {
    return fields;
  }
  const next = [...fields];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// Infer a row's type + string value from a parsed JSON value (the reverse of
// coerceFieldValue). object/array become a JSON snippet in `value`.
function inferField(value: unknown): { type: RestBodyValueType; value: string } {
  if (value === null) return { type: "null", value: "" };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "number") return { type: "number", value: String(value) };
  if (typeof value === "boolean") return { type: "boolean", value: String(value) };
  if (Array.isArray(value)) return { type: "array", value: JSON.stringify(value) };
  if (typeof value === "object") return { type: "object", value: JSON.stringify(value) };
  return { type: "string", value: String(value) };
}

// Parse a JSON body string into typed rows — the reverse of fieldsToJson, so the
// JSON editor and the key→value editor stay in sync when switching. A non-object
// / unparseable body yields no rows (caller falls back to a blank row).
export function jsonToFields(json: string): RestBodyField[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.entries(parsed as Record<string, unknown>).map(([key, v]) => {
    const { type, value } = inferField(v);
    const f = newBodyField();
    return { ...f, key, type, value };
  });
}
