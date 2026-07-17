import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const files = ["package.json", "pnpm-lock.yaml", "packages/knowledge-core/package.json", "packages/knowledge-cli/package.json", "packages/mcp/package.json"];
const entries = files.map((path) => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }));
const report = { generatedAt: new Date().toISOString(), entries };
if (process.argv.includes("--out")) writeFileSync(process.argv[process.argv.indexOf("--out") + 1], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
