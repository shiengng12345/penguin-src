import type { Lang } from "./registry.js";

// tree-sitter tags queries per language. Capture conventions:
//   @definition.<kind>  — the symbol's def node (kind = function|method|class|…)
//   @name               — the symbol's leaf name (paired within one match)
//   @reference.call     — a call callee name (2c resolves to a `calls` edge)
//   @reference.type     — a type used (annotation/generic/extends/implements);
//                         resolves to a `references` edge so DTOs/interfaces/
//                         types connect to their users (Plan B), not just fns.
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
(type_annotation (type_identifier) @reference.type)
(type_arguments (type_identifier) @reference.type)
(generic_type name: (type_identifier) @reference.type)
(extends_clause (identifier) @reference.type)
(implements_clause (type_identifier) @reference.type)
(extends_type_clause (type_identifier) @reference.type)
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

const RUBY_QUERY = `
(method name: (identifier) @name) @definition.method
(singleton_method name: (identifier) @name) @definition.method
(class name: (constant) @name) @definition.class
(module name: (constant) @name) @definition.module
(call method: (identifier) @reference.call)
`;

const PHP_QUERY = `
(function_definition name: (name) @name) @definition.function
(method_declaration name: (name) @name) @definition.method
(class_declaration name: (name) @name) @definition.class
(interface_declaration name: (name) @name) @definition.interface
(trait_declaration name: (name) @name) @definition.class
(function_call_expression function: (name) @reference.call)
(member_call_expression name: (name) @reference.call)
`;

const C_QUERY = `
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(struct_specifier name: (type_identifier) @name) @definition.struct
(call_expression function: (identifier) @reference.call)
`;

const CPP_QUERY = `
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(class_specifier name: (type_identifier) @name) @definition.class
(struct_specifier name: (type_identifier) @name) @definition.struct
(call_expression function: (identifier) @reference.call)
`;

const CSHARP_QUERY = `
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(struct_declaration name: (identifier) @name) @definition.struct
(enum_declaration name: (identifier) @name) @definition.enum
(method_declaration name: (identifier) @name) @definition.method
(invocation_expression function: (identifier) @reference.call)
`;

export const TAGS_QUERY: Partial<Record<Lang, string>> = {
  ts: TS_QUERY,
  tsx: TS_QUERY,
  js: JS_QUERY,
  python: PYTHON_QUERY,
  go: GO_QUERY,
  rust: RUST_QUERY,
  java: JAVA_QUERY,
  ruby: RUBY_QUERY,
  php: PHP_QUERY,
  c: C_QUERY,
  cpp: CPP_QUERY,
  csharp: CSHARP_QUERY,
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
  ruby: ["class", "module"],
  php: ["class_declaration", "interface_declaration", "trait_declaration"],
  c: [],
  cpp: ["class_specifier", "struct_specifier", "namespace_definition"],
  csharp: ["class_declaration", "interface_declaration", "struct_declaration", "namespace_declaration"],
};
