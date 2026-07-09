// Bundle the `penguin` knowledge CLI into ONE self-contained ESM file so a
// packaged Tauri app doesn't need the pnpm node_modules tree at runtime.
//
// Two deps can't be inlined and are handled out-of-band:
//   - better-sqlite3 — a NATIVE .node addon; kept external and resolved at
//     runtime from a vendored node_modules beside the bundle (see
//     vendor-node-runtime.mjs).
//   - tree-sitter wasm — web-tree-sitter's JS IS bundled, but the .wasm files
//     it loads are data; parser.ts resolves them from PENGUIN_WASM_DIR at
//     runtime (set by the Tauri bridge to the packaged resource dir).
import { build } from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "packages/knowledge-cli/dist/bin.js");
const outdir = join(repoRoot, "packages/knowledge-cli/bundle");
const outfile = join(outdir, "penguin.mjs");

mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  // Native addon — resolved at runtime from the vendored node_modules that
  // ships next to this bundle. Everything else is inlined.
  external: ["better-sqlite3"],
  // Always invoked as `node penguin.mjs` by the Tauri bridge, so no shebang
  // (a second shebang from the entry would be a syntax error anyway).
  // esbuild may emit `require`/`__dirname` for bundled CJS deps; ESM output
  // has neither, so shim them from import.meta.url.
  banner: {
    js: [
      "import { createRequire as __pgvCreateRequire } from 'node:module';",
      "import { fileURLToPath as __pgvFileURLToPath } from 'node:url';",
      "import { dirname as __pgvDirname } from 'node:path';",
      "const require = __pgvCreateRequire(import.meta.url);",
      "const __filename = __pgvFileURLToPath(import.meta.url);",
      "const __dirname = __pgvDirname(__filename);",
    ].join("\n"),
  },
  logLevel: "info",
});

chmodSync(outfile, 0o755);
console.log(`[bundle] wrote ${outfile}`);
