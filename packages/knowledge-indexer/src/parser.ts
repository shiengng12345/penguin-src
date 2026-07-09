import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import { WASM_FILE, type Lang } from "./registry.js";

// Grammar wasm ships in the tree-sitter-wasms package; resolve its dir at
// runtime so the location is install-independent (works from dist/ + when the
// indexer is bundled as a sidecar).
const require = createRequire(import.meta.url);

// A packaged app has no node_modules, so require.resolve("tree-sitter-wasms")
// fails there. The Tauri bridge sets PENGUIN_WASM_DIR to the resource dir that
// holds tree-sitter.wasm (web-tree-sitter runtime) + the grammar *.wasm files;
// dev falls back to the installed package.
function wasmDir(): string {
  const override = process.env.PENGUIN_WASM_DIR;
  if (override) return override;
  return join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
}

let initPromise: Promise<void> | null = null;
const languageCache = new Map<Lang, Language>();

// web-tree-sitter's runtime must be initialized once per process. When bundled
// there is no module-adjacent tree-sitter.wasm to auto-locate, so point
// emscripten's locateFile at PENGUIN_WASM_DIR (no-op in dev — the default
// resolution still works).
async function ensureInit(): Promise<void> {
  if (!initPromise) {
    const override = process.env.PENGUIN_WASM_DIR;
    initPromise = override
      ? Parser.init({ locateFile: (name: string) => join(override, name) })
      : Parser.init();
  }
  await initPromise;
}

// Load (and cache) the grammar Language for a language. Cached across calls.
export async function loadLanguage(lang: Lang): Promise<Language> {
  await ensureInit();
  let language = languageCache.get(lang);
  if (!language) {
    language = await Language.load(join(wasmDir(), WASM_FILE[lang]));
    languageCache.set(lang, language);
  }
  return language;
}

// A fresh Parser bound to the language (Parser objects are cheap; Language is cached).
export async function loadParser(lang: Lang): Promise<Parser> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
