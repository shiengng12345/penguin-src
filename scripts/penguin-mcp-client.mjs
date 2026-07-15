import { spawn } from "node:child_process";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 5_000;
const MCP_PROTOCOL_VERSION = "2025-11-25";

// Calls one tool through the same stdio protocol used by Codex and Claude.
// This keeps CLI-vs-MCP benchmarks independent from any host client's cached process.
export async function callPenguinMcpTool(payload) {
  const child = spawn(payload.nodePath, [payload.serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const outputLines = readline.createInterface({ input: child.stdout });
  const pendingRequests = new Map();
  const timeoutMs = payload.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let nextRequestId = 1;
  let stderr = "";

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  outputLines.on("line", (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }
    const completeRequest = pendingRequests.get(response.id);
    if (completeRequest) {
      pendingRequests.delete(response.id);
      completeRequest(response);
    }
  });

  // Each request has its own timeout so a hung server produces an actionable result.
  const request = (method, params) => new Promise((resolveRequest) => {
    const requestId = nextRequestId++;
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolveRequest({ error: { message: `${method} timed out after ${timeoutMs}ms` } });
    }, timeoutMs);
    pendingRequests.set(requestId, (response) => {
      clearTimeout(timeout);
      resolveRequest(response);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  });

  try {
    const initialized = await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "penguin-differential-benchmark", version: "1.0.0" },
    });
    if (initialized.error) {
      return { healthy: false, code: "initialize_failed", error: initialized.error.message, stderr };
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    const called = await request("tools/call", {
      name: payload.toolName,
      arguments: payload.arguments,
    });
    if (called.error) {
      return { healthy: false, code: "tool_call_failed", error: called.error.message, stderr };
    }
    return {
      healthy: true,
      code: "ok",
      toolName: payload.toolName,
      content: called.result?.content ?? [],
      isError: called.result?.isError === true,
      stderr,
    };
  } finally {
    outputLines.close();
    child.kill();
  }
}
