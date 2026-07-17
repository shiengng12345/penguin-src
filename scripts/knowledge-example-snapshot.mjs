import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

const snapshotPath = join(new URL("..", import.meta.url).pathname, "tests/snapshots/knowledge-capabilities.json");
const captureCli = async () => {
  let output = "";
  await runCli(["capabilities", "--json"], {
    out: (value) => { output = value; },
    err: () => {},
    openStore: () => { throw new Error("capabilities must not open a store"); },
    storeExists: () => false,
    cwd: process.cwd(),
  });
  return JSON.parse(output);
};
const captureMcp = async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-mcp-example-"));
  try {
    const handler = join(root, "handler.mjs");
    const defs = join(root, "defs.mjs");
    const coreDist = new URL("../packages/knowledge-core/dist/index.js", import.meta.url).pathname;
    await build({ entryPoints: [new URL("../packages/mcp/src/knowledge-tools.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", outfile: handler, alias: { "@penguin/knowledge-core": coreDist } });
    await build({ entryPoints: [new URL("../packages/mcp/src/knowledge-tool-defs.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", outfile: defs });
    const { handleKnowledgeTool } = await import(`file://${handler}`);
    return handleKnowledgeTool("knowledge_capabilities", {}, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
};
const normalize = (value) => JSON.parse(JSON.stringify(value));
const expected = { cli: normalize(await captureCli()), mcp: normalize(await captureMcp()) };
if (process.argv.includes("--update")) {
  writeFileSync(snapshotPath, `${JSON.stringify(expected, null, 2)}\n`);
  console.log(JSON.stringify({ updated: snapshotPath }));
} else {
  if (!existsSync(snapshotPath)) throw new Error(`missing snapshot: ${snapshotPath}`);
  const actual = JSON.parse(readFileSync(snapshotPath, "utf8"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("knowledge capability example snapshot drift");
  console.log(JSON.stringify({ snapshot: snapshotPath, ok: true }));
}
