import type { FieldInfo, ProtoService, ProtoMethod } from "./types.js";

const SKIP_CLASSES = new Set(["Notify", "WebSocketManager", "GlobalConfig"]);

const CLASS_DECLARE_RE = /export\s+declare\s+class\s+(\w+)\s*\{/g;
const TRADITIONAL_METHOD_RE =
  /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*:\s*Promise<([^>]+)>/gm;
const ARROW_PROPERTY_RE =
  /^\s*(\w+)\s*:\s*\([^)]*\)\s*=>\s*Promise<([^>]+)>/gm;
const STATIC_METHOD_RE =
  /^\s*static\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*:\s*Promise<([^>]+)>/gm;

// SDK method signatures all look like `(requestObj: any) => Promise<any>` —
// the real shape lives in dist/module/interfaces/request/*.d.ts as a TypeScript
// interface whose name is the PascalCase form of the method name. We parse
// those out separately and link them by name.
const INTERFACE_RE =
  /(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+([^{]+))?\s*\{([\s\S]*?)\n\}/g;

interface ParsedInterface {
  name: string;
  extends: string[];
  fields: FieldInfo[];
}

// Map a TS-style type token to the closest FieldInfo.type bucket used by the
// shared schema. We intentionally collapse JS numeric types onto "double" since
// the SDK is JSON-over-the-wire and the distinction is lossy anyway.
function mapTsType(raw: string): { type: string; repeated: boolean; map?: { keyType: string; valueType: string } } {
  let t = raw.trim();
  let repeated = false;
  if (t.endsWith("[]")) {
    repeated = true;
    t = t.slice(0, -2).trim();
  } else if (t.startsWith("Array<") && t.endsWith(">")) {
    repeated = true;
    t = t.slice(6, -1).trim();
  }
  // Strip leading `readonly ` or unions like `string | null` — keep the first
  // non-null branch so we don't lose all signal on optional-nullable fields.
  if (t.includes("|")) {
    const branches = t.split("|").map((s) => s.trim()).filter((s) => s !== "null" && s !== "undefined");
    t = branches[0] ?? t;
  }
  switch (t) {
    case "string": return { type: "string", repeated };
    case "number": return { type: "double", repeated };
    case "boolean": return { type: "bool", repeated };
    case "any":
    case "unknown": return { type: "any", repeated };
  }
  if (t.startsWith("Record<") && t.endsWith(">")) {
    const inner = t.slice("Record<".length, -1).split(",").map((part) => part.trim());
    return { type: "map", repeated, ...(inner.length === 2 ? { map: { keyType: inner[0], valueType: inner[1] } } : {}) };
  }
  if (t.startsWith("{")) return { type: "map", repeated };
  return { type: t, repeated };
}

// Parse one interface body line-at-a-time. Skips lines that look like nested
// object literals or method signatures — best-effort extraction, not a full
// TS parser. Goal is "AI can see field names and rough types," not validation.
function parseInterfaceBody(body: string): FieldInfo[] {
  const fields: FieldInfo[] = [];
  // Split on top-level semicolons. Naive but enough: most SDK fields are one
  // line, and we deliberately don't recurse into inline `{...}` shapes — they
  // map to `map`/`any` upstream anyway.
  const lines = body.split("\n");
  let depth = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // Track {} depth to avoid matching fields inside nested object types.
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    if (depth > 0) {
      depth += opens - closes;
      continue;
    }
    const match = /^(\w+)\s*(\??):\s*(.+?);?$/.exec(line);
    if (!match) {
      depth += opens - closes;
      continue;
    }
    const [, name, opt, typeRaw] = match;
    const { type, repeated, map } = mapTsType(typeRaw);
    fields.push({ name, type, repeated, optional: opt === "?", presence: opt === "?" ? "optional" : "implicit", schemaSource: "sdk_dts", ...(map ? { map } : {}) });
    depth += opens - closes;
  }
  return fields;
}

function collectInterfaces(files: { name: string; content: string }[]): Map<string, ParsedInterface> {
  const map = new Map<string, ParsedInterface>();
  for (const file of files) {
    INTERFACE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INTERFACE_RE.exec(file.content)) !== null) {
      const [, name, extendsRaw, body] = match;
      const extendsList = extendsRaw
        ? extendsRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      // Last-write-wins on duplicate names — interface re-declarations are
      // expected (request/auth.d.ts and src/interfaces/.../auth.d.ts often
      // ship the same shape).
      map.set(name, { name, extends: extendsList, fields: parseInterfaceBody(body) });
    }
  }
  return map;
}

// Recursively resolve `extends` chain. Guards against cycles and missing bases
// (a base might live in a file we didn't read).
function resolveInterfaceFields(
  name: string,
  interfaces: Map<string, ParsedInterface>,
  seen = new Set<string>(),
): FieldInfo[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const iface = interfaces.get(name);
  if (!iface) return [];
  const inherited = iface.extends.flatMap((base) =>
    resolveInterfaceFields(base, interfaces, seen),
  );
  const ownNames = new Set(iface.fields.map((f) => f.name));
  return [...inherited.filter((f) => !ownNames.has(f.name)), ...iface.fields];
}

function pascalCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function extractRequestTypeFromParams(params: string): string {
  const match = params.match(/:\s*([\w.]+)/);
  return match ? match[1].trim() : "unknown";
}

function parseMethodsInClassBody(
  className: string,
  classBody: string,
  interfaces: Map<string, ParsedInterface>,
): ProtoMethod[] {
  const methods: ProtoMethod[] = [];
  const seen = new Set<string>();

  const addMethod = (name: string, requestType: string, responseType: string) => {
    if (name.startsWith("_") || name === "constructor") return;
    if (seen.has(name)) return;
    seen.add(name);
    // SDK declarations always say `requestObj: any`, so requestType from the
    // class is useless. Convention: the matching request interface is the
    // method name in PascalCase — look it up and synthesize requestFields.
    const conventionType = pascalCase(name);
    const resolvedFields = interfaces.has(conventionType)
      ? resolveInterfaceFields(conventionType, interfaces)
      : interfaces.has(requestType)
        ? resolveInterfaceFields(requestType, interfaces)
        : [];
    methods.push({
      name,
      fullName: `${className}.${name}`,
      requestType: interfaces.has(conventionType) ? conventionType : requestType,
      responseType,
      requestFields: resolvedFields,
      responseFields: [],
      schemaSource: "sdk_dts",
      schemaGaps: [{ code: "response_schema_empty", fieldPath: "response", schemaSource: "sdk_dts" }],
    });
  };

  // Traditional: methodName(params): Promise<T>
  let m: RegExpExecArray | null;
  TRADITIONAL_METHOD_RE.lastIndex = 0;
  while ((m = TRADITIONAL_METHOD_RE.exec(classBody)) !== null) {
    const paramsMatch = m[0].match(/\(([^)]*)\)/);
    const paramStr = paramsMatch ? paramsMatch[1] : "";
    addMethod(m[1], extractRequestTypeFromParams(paramStr), m[2].trim());
  }

  // Arrow property: methodName: (params) => Promise<T> (main SDK pattern)
  ARROW_PROPERTY_RE.lastIndex = 0;
  while ((m = ARROW_PROPERTY_RE.exec(classBody)) !== null) {
    const paramsMatch = m[0].match(/\(([^)]*)\)/);
    const paramStr = paramsMatch ? paramsMatch[1] : "";
    addMethod(m[1], extractRequestTypeFromParams(paramStr), m[2].trim());
  }

  // Static methods
  STATIC_METHOD_RE.lastIndex = 0;
  while ((m = STATIC_METHOD_RE.exec(classBody)) !== null) {
    const paramsMatch = m[0].match(/\(([^)]*)\)/);
    const paramStr = paramsMatch ? paramsMatch[1] : "";
    addMethod(m[1], extractRequestTypeFromParams(paramStr), m[2].trim());
  }

  return methods;
}

function shouldSkipClassFile(name: string): boolean {
  if (name === "index.d.ts") return true;
  const parts = name.split("/");
  // Class declarations only live alongside the dist/module root — anything
  // inside interfaces/, utils/, or enum/ is exclusively type/helper material.
  return parts.some(
    (p) => p === "interfaces" || p === "utils" || p === "enum"
  );
}

export function parseSdkDts(
  files: { name: string; content: string }[]
): ProtoService[] {
  // First pass: collect every interface across all files (interface files are
  // included now so requestFields can be populated). Last-write-wins on dupes.
  const interfaces = collectInterfaces(files);
  // Many SDKs (e.g. @snsoft/js-sdk) declare the same class in both
  // dist/module/<class>.d.ts and dist/module/src/services/<class>.d.ts.
  // Keyed by className so cross-file duplicates merge into one service
  // instead of emitting duplicate ProtoService entries (which would in turn
  // produce duplicate React keys in the search/sidebar lists).
  const byClass = new Map<string, ProtoService>();

  for (const file of files) {
    if (shouldSkipClassFile(file.name)) continue;

    const content = file.content;
    CLASS_DECLARE_RE.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = CLASS_DECLARE_RE.exec(content)) !== null) {
      const className = match[1];
      if (SKIP_CLASSES.has(className)) continue;

      const classStart = match.index +match[0].length;
      let depth = 1;
      let pos = classStart;
      while (pos < content.length && depth > 0) {
        const open = content.indexOf("{", pos);
        const close = content.indexOf("}", pos);
        if (close === -1) break;
        if (open !== -1 && open < close) {
          depth++;
          pos = open +1;
        } else {
          depth--;
          if (depth === 0) {
            const classBody = content.slice(classStart, close);
            const methods = parseMethodsInClassBody(className, classBody, interfaces);
            if (methods.length > 0) {
              const existing = byClass.get(className);
              if (existing) {
                // Merge — keep methods we don't already have under this class.
                const seenNames = new Set(existing.methods.map((m) => m.name));
                for (const m of methods) {
                  if (!seenNames.has(m.name)) existing.methods.push(m);
                }
              } else {
                byClass.set(className, {
                  name: className,
                  fullName: className,
                  methods,
                });
              }
            }
            break;
          }
          pos = close +1;
        }
      }
    }
  }

  return Array.from(byClass.values());
}
