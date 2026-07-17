import { readFileSync } from "node:fs";
import { CAPABILITIES, listCliRegistrations, listMcpRegistrations } from "../packages/knowledge-contracts/dist/index.js";

const source = readFileSync(new URL("../packages/mcp/src/knowledge-tool-defs.ts", import.meta.url), "utf8");
const mcpNames = new Set([...source.matchAll(/name:\s*["']([^"']+)["']/g)].map((match) => match[1]));
if (source.includes("for (const capability of CAPABILITIES)")) for (const capability of CAPABILITIES) mcpNames.add(capability.id.replaceAll(".", "_"));
const cliIds = new Set(listCliRegistrations().map((registration) => registration.capabilityId));
const cliUnimplemented = listCliRegistrations().filter((registration) => registration.status !== "implemented").map((registration) => registration.capabilityId);
const mcpUnimplemented = listMcpRegistrations().filter((registration) => registration.status !== "implemented").map((registration) => registration.capabilityId);
const missingCli = CAPABILITIES.filter((capability) => capability.requiredOn.includes("cli") && !cliIds.has(capability.id)).map((capability) => capability.id);
const missingMcp = CAPABILITIES.filter((capability) => capability.requiredOn.includes("mcp") && !mcpNames.has(capability.id.replaceAll(".", "_"))).map((capability) => capability.id);
const report = { capabilityCount: CAPABILITIES.length, cliRegistrationCount: cliIds.size, mcpToolCount: mcpNames.size, missingCli, missingMcp, cliUnimplemented, mcpUnimplemented, mismatchCount: missingCli.length + missingMcp.length + cliUnimplemented.length + mcpUnimplemented.length };
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--gate") && report.mismatchCount !== 0) process.exitCode = 1;
