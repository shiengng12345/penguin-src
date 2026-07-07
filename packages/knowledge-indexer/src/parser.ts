import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import { WASM_FILE, type Lang } from "./registry.js";

// Grammar wasm ships in the tree-sitter-wasms package; resolve its dir at
// runtime so the location is install-independent (works from dist/ + when the
// indexer is bundled as a sidecar).
const require = createRequire(import.meta.url);

function wasmsOutDir(): string {
  return join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
}

let initPromise: Promise<void> | null = null;
const languageCache = new Map<Lang, Language>();

// web-tree-sitter's runtime must be initialized once per process.
async function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
}

// Load (and cache) the grammar for a language, returning a fresh Parser bound
// to it. Language objects are cached across calls; Parser objects are cheap.
export async function loadParser(lang: Lang): Promise<Parser> {
  await ensureInit();
  let language = languageCache.get(lang);
  if (!language) {
    language = await Language.load(join(wasmsOutDir(), WASM_FILE[lang]));
    languageCache.set(lang, language);
  }
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
