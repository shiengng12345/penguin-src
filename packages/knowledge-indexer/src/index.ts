export const KNOWLEDGE_INDEXER_VERSION = "0.0.1";
export { loadParser, loadLanguage } from "./parser.js";
export { langForExtension, LANGS, WASM_FILE, type Lang } from "./registry.js";
export {
  extractSymbols,
  type ExtractedFile,
  type ExtractedSymbol,
  type ExtractedRef,
} from "./extract.js";
