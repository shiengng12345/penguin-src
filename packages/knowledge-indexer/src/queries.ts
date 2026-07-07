import type { Lang } from "./registry.js";

// tree-sitter tags queries per language. Capture conventions:
//   @definition.<kind>  — the symbol's def node (kind = function|method|class|…)
//   @name               — the symbol's leaf name (paired within one match)
//   @reference.call     — a call callee name (2c resolves to a `calls` edge)
//   @reference.import   — a raw import target (2c resolves to `imports`)
// Only node types that exist in the corresponding grammar may appear, or the
// Query constructor throws. A language without a row here still parses (file
// node + degrade), it just yields no symbols (§9 grammar-present/no-query).

// TS + TSX share the same definition/reference node types.
const TS_QUERY = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(method_definition name: (property_identifier) @name) @definition.method
(class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(variable_declarator name: (identifier) @name value: (arrow_function)) @definition.function
(variable_declarator name: (identifier) @name value: (function_expression)) @definition.function
(call_expression function: (identifier) @reference.call)
(call_expression function: (member_expression property: (property_identifier) @reference.call))
(import_statement source: (string (string_fragment) @reference.import))
`;

const JS_QUERY = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(method_definition name: (property_identifier) @name) @definition.method
(class_declaration name: (identifier) @name) @definition.class
(variable_declarator name: (identifier) @name value: (arrow_function)) @definition.function
(variable_declarator name: (identifier) @name value: (function_expression)) @definition.function
(call_expression function: (identifier) @reference.call)
(call_expression function: (member_expression property: (property_identifier) @reference.call))
(import_statement source: (string (string_fragment) @reference.import))
`;

const PYTHON_QUERY = `
(function_definition name: (identifier) @name) @definition.function
(class_definition name: (identifier) @name) @definition.class
(call function: (identifier) @reference.call)
(call function: (attribute attribute: (identifier) @reference.call))
(import_from_statement module_name: (dotted_name) @reference.import)
(import_statement name: (dotted_name) @reference.import)
`;

const GO_QUERY = `
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(type_declaration (type_spec name: (type_identifier) @name)) @definition.type
(call_expression function: (identifier) @reference.call)
(call_expression function: (selector_expression field: (field_identifier) @reference.call))
(import_spec path: (interpreted_string_literal) @reference.import)
`;

const RUST_QUERY = `
(function_item name: (identifier) @name) @definition.function
(struct_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.interface
(call_expression function: (identifier) @reference.call)
(call_expression function: (field_expression field: (field_identifier) @reference.call))
(use_declaration argument: (scoped_identifier) @reference.import)
`;

const JAVA_QUERY = `
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(method_declaration name: (identifier) @name) @definition.method
(method_invocation name: (identifier) @reference.call)
(import_declaration (scoped_identifier) @reference.import)
`;

export const TAGS_QUERY: Partial<Record<Lang, string>> = {
  ts: TS_QUERY,
  tsx: TS_QUERY,
  js: JS_QUERY,
  python: PYTHON_QUERY,
  go: GO_QUERY,
  rust: RUST_QUERY,
  java: JAVA_QUERY,
};

// Per-language nesting nodes that contribute to a qualified name (their `name`
// field is prepended, outermost first). A def with no scope ancestor = bare name.
export const SCOPE_NODES: Partial<Record<Lang, string[]>> = {
  ts: ["class_declaration", "interface_declaration", "internal_module", "module"],
  tsx: ["class_declaration", "interface_declaration", "internal_module", "module"],
  js: ["class_declaration"],
  python: ["class_definition"],
  go: [],
  rust: ["mod_item", "impl_item"],
  java: ["class_declaration", "interface_declaration", "enum_declaration"],
};
