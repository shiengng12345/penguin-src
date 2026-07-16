import protobuf from "protobufjs";
import { logger } from "./logger.js";
import type { ProtoService, ProtoMethod, FieldInfo, SchemaGap } from "./types.js";

export function parseProtoContent(
  files: { name: string; content: string }[]
): ProtoService[] {
  const protoFiles = files.filter((f) => f.name.endsWith(".proto"));
  const connectFiles = files.filter((f) => f.name.endsWith("_connect.d.ts"));
  const pbFiles = files.filter((f) => f.name.endsWith("_pb.d.ts"));

  if (protoFiles.length > 0) {
    return parseRawProtos(protoFiles);
  }

  if (connectFiles.length > 0) {
    return parseConnectDts(connectFiles, pbFiles);
  }

  return [];
}

// ---- Raw .proto parsing via protobufjs ----

function parseRawProtos(
  files: { name: string; content: string }[]
): ProtoService[] {
  const root = new protobuf.Root();

  for (const file of files) {
    try {
      protobuf.parse(file.content, root, { keepCase: true });
    } catch (err) {
      logger.warn("proto-parser", "skip unparseable proto", { file: file.name, error: String(err) });
    }
  }

  try {
    root.resolveAll();
  } catch {
    // Some types (e.g. google.protobuf.Struct) may not resolve -- non-fatal
  }
  const services: ProtoService[] = [];

  function walkNamespace(ns: protobuf.NamespaceBase, prefix: string) {
    for (const nested of ns.nestedArray) {
      const fullPrefix = prefix ? `${prefix}.${nested.name}` : nested.name;

      if (nested instanceof protobuf.Service) {
        const methods: ProtoMethod[] = [];

        for (const method of nested.methodsArray) {
          let requestFields: FieldInfo[] = [];
          let responseFields: FieldInfo[] = [];
          try {
            requestFields = extractProtoFields(root.lookupType(method.requestType));
          } catch { /* unresolvable type */ }
          try {
            responseFields = extractProtoFields(root.lookupType(method.responseType));
          } catch { /* unresolvable type */ }

          methods.push({
            name: method.name,
            fullName: `${fullPrefix}.${method.name}`,
            requestType: method.requestType,
            responseType: method.responseType,
            requestFields,
            responseFields,
            schemaSource: "raw_proto",
          });
        }

        services.push({
          name: nested.name,
          fullName: fullPrefix,
          methods,
        });
      }

      if (nested instanceof protobuf.Namespace) {
        walkNamespace(nested, fullPrefix);
      }
    }
  }

  walkNamespace(root, "");
  return services;
}

function extractProtoFields(
  type: protobuf.Type,
  seen: Set<string> = new Set()
): FieldInfo[] {
  // Cycle guard: self/mutually-referencing messages (e.g. tree nodes) would
  // otherwise recurse forever.
  if (seen.has(type.fullName)) return [];
  const nextSeen = new Set(seen);
  nextSeen.add(type.fullName);

  return type.fieldsArray.map((field) => {
    const resolved = (() => { try { return field.resolve(); } catch { return null; } })();
    const resolvedType = resolved?.resolvedType;
    const explicitOptional = (field.options as Record<string, unknown> | undefined)?.proto3_optional === true;
    const presence: FieldInfo["presence"] = field.required
      ? "required"
      : explicitOptional || resolvedType instanceof protobuf.Type || field.partOf
        ? "optional"
        : "implicit";
    const info: FieldInfo = {
      name: field.name,
      type: field.type,
      repeated: field.repeated,
      optional: presence === "optional",
      presence,
      fieldNumber: field.id,
      jsonName: (field as unknown as { jsonName?: string }).jsonName ?? field.name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      ...((field.options as Record<string, unknown> | undefined)?.default !== undefined ? { defaultValue: (field.options as Record<string, unknown>).default as string | number | boolean } : {}),
      ...(field.partOf ? { oneof: field.partOf.name } : {}),
      schemaSource: "raw_proto",
    };

    if (field.map) {
      const mapValue = resolvedType;
      info.type = "map";
      info.map = { keyType: (field as unknown as { keyType?: string }).keyType ?? "unknown", valueType: field.type || (resolvedType as { name?: string } | null)?.name || "unknown" };
      if (mapValue instanceof protobuf.Type) info.map.valueFields = extractProtoFields(mapValue, nextSeen);
      else if (mapValue instanceof protobuf.Enum) {
        info.map.valueEnumValues = Object.keys(mapValue.values);
      } else {
        info.schemaGaps = ["map_value_type_missing"];
      }
    } else if (resolvedType instanceof protobuf.Type) {
      info.fields = extractProtoFields(resolvedType, nextSeen);
    } else if (resolvedType instanceof protobuf.Enum) {
      info.enumValues = Object.keys(resolvedType.values);
      info.enumNumbers = { ...resolvedType.values };
    }

    return info;
  });
}

export function methodSchemaCompleteness(method: ProtoMethod): { complete: boolean; gaps: SchemaGap[] } {
  const gaps: SchemaGap[] = [];
  const check = (fields: FieldInfo[], side: "request" | "response") => {
    if (fields.length === 0) gaps.push({ code: side === "request" ? "request_schema_empty" : "response_schema_empty", fieldPath: side, schemaSource: method.schemaSource ?? "generated_dts" });
    const visit = (items: FieldInfo[], prefix: string) => items.forEach((field) => {
      const path = `${prefix}.${field.name}`;
      if (field.schemaGaps?.includes("map_value_type_missing")) gaps.push({ code: "map_value_type_missing", fieldPath: path, schemaSource: field.schemaSource ?? method.schemaSource ?? "generated_dts" });
      if (field.type === "map" && !field.map?.valueType) gaps.push({ code: "map_value_type_missing", fieldPath: path, schemaSource: field.schemaSource ?? method.schemaSource ?? "generated_dts" });
      if (field.type !== "map" && field.enumValues === undefined && /enum/i.test(field.type)) gaps.push({ code: "enum_values_missing", fieldPath: path, schemaSource: field.schemaSource ?? method.schemaSource ?? "generated_dts" });
      if (field.presence === undefined) gaps.push({ code: "presence_unknown", fieldPath: path, schemaSource: field.schemaSource ?? method.schemaSource ?? "generated_dts" });
      if (field.fields) visit(field.fields, path);
    });
    visit(fields, side);
  };
  check(method.requestFields, "request"); check(method.responseFields, "response");
  return { complete: gaps.length === 0, gaps };
}

// ---- ConnectRPC _connect.d.ts +_pb.d.ts parsing ----

interface ParsedField {
  name: string;
  protoType: string;
  repeated: boolean;
  optional: boolean;
  enumValues?: string[];
  map?: { keyType: string; valueType: string };
}

interface ParsedMessage {
  className: string;
  fields: ParsedField[];
}

const SERVICE_HEADER_RE =
  /export declare const (\w+):\s*\{/;
const TYPE_NAME_RE = /readonly typeName:\s*"([^"]+)"/;
const METHOD_ENTRY_RE =
  /readonly (\w+):\s*\{\s*readonly name:\s*"(\w+)";\s*readonly I:\s*typeof (\w+);\s*readonly O:\s*typeof (\w+);\s*readonly kind:\s*MethodKind\.(\w+)/g;

function parseConnectDts(
  connectFiles: { name: string; content: string }[],
  pbFiles: { name: string; content: string }[]
): ProtoService[] {
  const messageMap = parsePbDtsFiles(pbFiles);
  const services: ProtoService[] = [];

  for (const file of connectFiles) {
    const content = file.content;

    const typeNameMatch = content.match(TYPE_NAME_RE);
    if (!typeNameMatch) continue;

    const serviceHeaderMatch = content.match(SERVICE_HEADER_RE);
    if (!serviceHeaderMatch) continue;

    const typeName = typeNameMatch[1];
    const parts = typeName.split(".");
    const serviceName = parts[parts.length - 1];

    const methods: ProtoMethod[] = [];
    METHOD_ENTRY_RE.lastIndex = 0;

    let m;
    while ((m = METHOD_ENTRY_RE.exec(content)) !== null) {
      const methodName = m[2];
      const inputType = m[3];
      const outputType = m[4];

      methods.push({
        name: methodName,
        fullName: `${typeName}.${methodName}`,
        requestType: inputType,
        responseType: outputType,
        requestFields: resolveFields(inputType, messageMap),
        responseFields: resolveFields(outputType, messageMap),
      });
    }

    if (methods.length > 0) {
      services.push({
        name: serviceName,
        fullName: typeName,
        methods,
      });
    }
  }

  return services;
}

function resolveFields(
  className: string,
  messageMap: Map<string, ParsedMessage>,
  seen: Set<string> = new Set()
): FieldInfo[] {
  const msg = messageMap.get(className);
  // Cycle guard: self/mutually-referencing messages would recurse forever.
  if (!msg || seen.has(className)) return [];
  const nextSeen = new Set(seen);
  nextSeen.add(className);

  return msg.fields.map((f) => {
    const info: FieldInfo = {
      name: f.name,
      type: mapProtoType(f.protoType),
      repeated: f.repeated,
      optional: f.optional,
      presence: f.optional ? "optional" : "implicit",
      schemaSource: "generated_dts",
      ...(f.enumValues ? { enumValues: f.enumValues } : {}),
      ...(f.map ? { map: f.map, ...(f.map.valueType ? {} : { schemaGaps: ["map_value_type_missing"] }) } : {}),
    };

    const nestedClassName = findMessageClassName(f.protoType, messageMap);
    if (nestedClassName) {
      info.fields = resolveFields(nestedClassName, messageMap, nextSeen);
    }

    return info;
  });
}

// Map a proto type reference to the protoc-gen-es class name. Top-level
// messages keep their name ("common.BaseResponse" → "BaseResponse"), but
// NESTED messages join the nesting path with underscores:
// "player.GetPlayerProfileByJwtRes.Player" → "GetPlayerProfileByJwtRes_Player".
// The package prefix length is unknown, so probe suffixes from shortest to
// longest until one matches a generated class.
function findMessageClassName(
  protoType: string,
  messageMap: Map<string, ParsedMessage>
): string | null {
  const parts = protoType.split(".");
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = parts.slice(i).join("_");
    if (messageMap.has(candidate)) return candidate;
  }
  return null;
}

const GENERATED_FIELD_RE =
  /@generated from field:\s*(optional\s+)?(repeated\s+)?(?:map<[^>]+>|[\w.]+)\s+(\w+)\s*=/;

function parsePbDtsFiles(
  pbFiles: { name: string; content: string }[]
): Map<string, ParsedMessage> {
  const map = new Map<string, ParsedMessage>();

  for (const file of pbFiles) {
    const enumMap = new Map<string, string[]>();
    for (const enumMatch of file.content.matchAll(/export declare enum (\w+)\s*\{([\s\S]*?)\n\}/g)) {
      enumMap.set(enumMatch[1], [...enumMatch[2].matchAll(/^\s*(\w+)\s*=/gm)].map((match) => match[1]));
    }
    const lines = file.content.split("\n");
    let currentClass: string | null = null;
    let fields: ParsedField[] = [];
    let pendingFieldComment: {
      name: string;
      protoType: string;
      repeated: boolean;
      optional: boolean;
    } | null = null;

    for (const line of lines) {
      const classMatch = line.match(
        /export declare class (\w+)\s+extends\s+Message/
      );
      if (classMatch) {
        if (currentClass && fields.length > 0) {
          map.set(currentClass, { className: currentClass, fields: [...fields] });
        }
        currentClass = classMatch[1];
        fields = [];
        pendingFieldComment = null;
        continue;
      }

      const fieldAnnotation = line.match(GENERATED_FIELD_RE);
      if (fieldAnnotation) {
        const isOptional = !!fieldAnnotation[1];
        const isRepeated = !!fieldAnnotation[2];
        const fieldName = fieldAnnotation[3];

        const fullMatch = line.match(
          /@generated from field:\s*(?:optional\s+)?(?:repeated\s+)?([\w.<>, ]+)\s+\w+\s*=/
        );
        const protoType = fullMatch ? fullMatch[1].trim() : "string";

        const mapMatch = protoType.match(/^map<\s*([^,>]+)\s*,\s*([^>]+)>$/);
        pendingFieldComment = {
          name: fieldName,
          protoType,
          repeated: isRepeated,
          optional: isOptional,
          ...(mapMatch ? { map: { keyType: mapMatch[1].trim(), valueType: mapMatch[2].trim() } } : {}),
        };
        continue;
      }

      if (pendingFieldComment) {
        const propMatch = line.match(/^\s*(\w+)[\?]?\s*:/);
        if (propMatch) {
          const enumName = pendingFieldComment.protoType.split(".").pop() ?? pendingFieldComment.protoType;
          fields.push({ ...pendingFieldComment, ...(enumMap.has(enumName) ? { enumValues: enumMap.get(enumName) } : {}) });
          pendingFieldComment = null;
        }
      }
    }

    if (currentClass && fields.length > 0) {
      map.set(currentClass, { className: currentClass, fields: [...fields] });
    }
  }

  return map;
}

function mapProtoType(protoType: string): string {
  if (protoType.startsWith("map<")) return "map";

  const base = protoType.split(".").pop() || protoType;
  switch (base) {
    case "string":
      return "string";
    case "bool":
      return "bool";
    case "int32":
    case "sint32":
    case "uint32":
    case "fixed32":
    case "sfixed32":
      return "int32";
    case "int64":
    case "sint64":
    case "uint64":
    case "fixed64":
    case "sfixed64":
      return "int64";
    case "float":
      return "float";
    case "double":
      return "double";
    case "bytes":
      return "bytes";
    default:
      return protoType;
  }
}

// ---- Shared utilities ----

export function generateDefaultJson(
  fields: FieldInfo[]
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};

  for (const field of fields) {
    if (field.optional) continue;
    if (field.repeated) {
      obj[field.name] = field.fields
        ? [generateDefaultJson(field.fields)]
        : [];
    } else if (field.fields) {
      obj[field.name] = generateDefaultJson(field.fields);
    } else if (field.enumValues && field.enumValues.length > 0) {
      obj[field.name] = field.enumValues[0];
    } else {
      switch (field.type) {
        case "string":
          obj[field.name] = "";
          break;
        case "int32":
        case "int64":
        case "uint32":
        case "uint64":
        case "sint32":
        case "sint64":
        case "fixed32":
        case "fixed64":
        case "sfixed32":
        case "sfixed64":
          obj[field.name] = 0;
          break;
        case "float":
        case "double":
          obj[field.name] = 0.0;
          break;
        case "bool":
          obj[field.name] = false;
          break;
        case "bytes":
          obj[field.name] = "";
          break;
        case "map":
          obj[field.name] = {};
          break;
        default:
          obj[field.name] = null;
          break;
      }
    }
  }

  return obj;
}

export function generateMethodPath(
  packageName: string,
  serviceName: string,
  methodName: string
): string {
  return `/${packageName}.${serviceName}/${methodName}`;
}
