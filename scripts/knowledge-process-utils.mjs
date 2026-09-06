import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

export function defaultProcessPaths(root) {
  const cliBundle = process.env.PENGUIN_BUNDLE ?? resolve(root, "packages/knowledge-cli/bundle/penguin.mjs");
  const bundledMcp = resolve(root, "packages/mcp/bundle/dist/index.js");
  const mcpBundle = process.env.PENGUIN_MCP_BUNDLE ?? (existsSync(bundledMcp) ? bundledMcp : resolve(root, "packages/mcp/dist/index.js"));
  const bundledNode = resolve(root, "packages/knowledge-cli/bundle/node");
  const node = process.env.PENGUIN_NODE ?? (existsSync(bundledNode) ? bundledNode : process.execPath);
  return { cliBundle, mcpBundle, node };
}

export function processEnv(root, overrides = {}) {
  return {
    ...process.env,
    PENGUIN_WASM_DIR: process.env.PENGUIN_WASM_DIR ?? resolve(root, "packages/knowledge-cli/bundle/wasm"),
    ...overrides,
  };
}

export function runCli({ node, bundle, command, args, cwd, env, timeoutMs = 30_000 }) {
  const started = Date.now();
  const executable = command ?? node;
  const commandArgs = command ? args : [bundle, ...args];
  const result = spawnSync(executable, commandArgs, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    kind: "cli",
    args: commandArgs,
    exitCode: result.error?.code === "ETIMEDOUT" ? 124 : result.status ?? 1,
    signal: result.signal ?? null,
    durationMs: Date.now() - started,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function extractCliJson(row) {
  const lines = row.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const value = parseJson(lines[index]);
    if (value !== null) return value;
  }
  return parseJson(row.stdout);
}

export class McpSession {
  /**
   * 什么时候用：需要通过 JSON-RPC stdio 检查一个真实 MCP child process 时使用；command
   * 允许检查 stable launcher，node/server 继续兼容已有 bundle 直启调用方。
   */
  constructor({ node, server, command, args = [], cwd, env, label = "mcp", timeoutMs = 15_000 }) {
    this.label = label;
    this.timeoutMs = timeoutMs;
    const executable = command ?? node;
    const commandArgs = command ? args : [server];
    this.command = executable;
    this.args = commandArgs;
    this.stdout = "";
    this.stderr = "";
    this.protocolLines = [];
    this.messages = [];
    this.spawnError = null;
    this.exitCode = null;
    this.exitSignal = null;
    this.child = spawn(executable, commandArgs, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.stdout += text;
      this.#consume(text);
    });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
    this.child.on("error", (error) => {
      this.spawnError = error;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    this.child.on("exit", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      const error = new Error(`${this.label} exited code=${code} signal=${signal ?? "none"}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  #consume(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      this.protocolLines.push(line);
      const message = parseJson(line);
      if (!message || message.id === undefined) continue;
      this.messages.push(message);
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    const startupError = this.spawnError;
    if (startupError) return Promise.reject(startupError);
    const isStdinUnavailable = !this.child.stdin.writable;
    if (isStdinUnavailable) return Promise.reject(new Error(`${this.label} stdin is unavailable`));
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label} request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async initialize() {
    const response = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "penguin-task10", version: "1.0.0" },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    return response;
  }

  async callTool(name, args = {}) {
    return this.request("tools/call", { name, arguments: args });
  }

  close() {
    if (!this.child.killed) this.child.kill("SIGTERM");
  }

  evidence() {
    return {
      label: this.label,
      command: this.command,
      args: this.args,
      pid: this.child.pid ?? null,
      stdout: this.stdout,
      stderr: this.stderr,
      protocolLines: [...this.protocolLines],
      messages: [...this.messages],
      spawnError: this.spawnError ? String(this.spawnError.message ?? this.spawnError) : null,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
    };
  }
}

export function mcpStructured(response) {
  const result = response?.result ?? response;
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find((item) => item.type === "text")?.text;
  return text ? parseJson(text) ?? { text } : result;
}

export function normalizeForParity(value) {
  const volatile = new Set(["stats", "timingsMs", "rawBytesEstimate", "sentBytes", "compactRatio", "requestId", "collectedAt", "generatedAt", "durationMs"]);
  if (Array.isArray(value)) return value.map(normalizeForParity);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !volatile.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, normalizeForParity(item)]));
}

export function duplicateValues(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();
}

export function validKnowledgeErrorEnvelope(value, expectedCode) {
  return Boolean(value)
    && typeof value.code === "string"
    && value.code.length > 0
    && value.code !== "not-classified"
    && (!expectedCode || value.code === expectedCode)
    && typeof value.message === "string"
    && value.message.length > 0
    && typeof value.retryable === "boolean";
}
