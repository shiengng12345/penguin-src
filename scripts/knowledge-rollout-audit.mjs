import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const files = ["package.json", "pnpm-lock.yaml", "packages/mcp/dist/index.js", "packages/knowledge-cli/dist/bin.js"];
const report = { capturedAt: new Date().toISOString(), files: files.map((path) => ({ path, exists: existsSync(path), sha256: existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null })), externalRemovalApproved: process.env.PENGUIN_EXTERNAL_REMOVAL_APPROVED === "true", status: "audit_only" };
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--gate") && !report.externalRemovalApproved) process.exitCode = 1;
