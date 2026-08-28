import { parentPort } from "node:worker_threads";
import { extractSymbols } from "./extract.js";
import type { Lang } from "./registry.js";

// Parse-only worker. It touches no database: it receives source text and
// returns the ExtractedFile, which is plain data and therefore structured-
// cloneable across the thread boundary. Keeping SQLite entirely on the main
// thread preserves the single-writer model — the only thing being parallelised
// is the tree-sitter/WASM CPU work, which a CPU profile showed dominating the
// native share of index time.

interface ParseRequest {
  type: "parse";
  id: number;
  lang: Lang;
  source: string;
  relPath: string;
}

if (!parentPort) throw new Error("PARSE_WORKER_PARENT_PORT_REQUIRED");

parentPort.on("message", (request: ParseRequest) => {
  if (request.type !== "parse") return;
  void extractSymbols({ lang: request.lang, source: request.source, relPath: request.relPath })
    .then((extracted) => {
      parentPort!.postMessage({ type: "parsed", id: request.id, ok: true, extracted });
    })
    .catch((error: unknown) => {
      // A parse failure is data, not a crash: the pipeline records it as the
      // file's parseError exactly as it would from an in-process parse.
      parentPort!.postMessage({
        type: "parsed",
        id: request.id,
        ok: false,
        message: String((error as Error)?.message ?? error),
      });
    });
});
