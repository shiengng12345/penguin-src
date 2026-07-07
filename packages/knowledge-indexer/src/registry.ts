// Language registry: one row per bundled grammar. Adding a language = one wasm
// (in tree-sitter-wasms) + one row here + one extension mapping (§6.1).
// proto + SQL are in the spec's first wave but not in tree-sitter-wasms 0.1.13;
// they get added the same way once their wasm is bundled.
export type Lang =
  | "ts" | "tsx" | "js" | "rust" | "go" | "java" | "php" | "python"
  | "c" | "cpp" | "csharp" | "ruby" | "kotlin" | "swift"
  | "bash" | "html" | "css" | "json" | "yaml";

// Lang → grammar wasm filename under tree-sitter-wasms/out/.
export const WASM_FILE: Record<Lang, string> = {
  ts: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  js: "tree-sitter-javascript.wasm",
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  php: "tree-sitter-php.wasm",
  python: "tree-sitter-python.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  swift: "tree-sitter-swift.wasm",
  bash: "tree-sitter-bash.wasm",
  html: "tree-sitter-html.wasm",
  css: "tree-sitter-css.wasm",
  json: "tree-sitter-json.wasm",
  yaml: "tree-sitter-yaml.wasm",
};

export const LANGS = Object.keys(WASM_FILE) as Lang[];

const EXT_TO_LANG: Record<string, Lang> = {
  ts: "ts", mts: "ts", cts: "ts",
  tsx: "tsx",
  js: "js", jsx: "js", mjs: "js", cjs: "js",
  rs: "rust",
  go: "go",
  java: "java",
  php: "php",
  py: "python", pyi: "python",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp",
  rb: "ruby",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  sh: "bash", bash: "bash",
  html: "html", htm: "html",
  css: "css",
  json: "json",
  yaml: "yaml", yml: "yaml",
};

// Map a file path to its language by extension; null when unsupported.
export function langForExtension(filePath: string): Lang | null {
  const m = filePath.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  return EXT_TO_LANG[m[1]] ?? null;
}
