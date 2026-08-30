# Task 1 — 真实 MCP session 边界诊断

- failureClass: `LAUNCHER_EXECUTION_FAILED`
- configuredCommand: `~/.penguin/bin/penguin-mcp`
- launcherTarget: `~/.penguin/bin/penguin-mcp-launcher.mjs`
- capabilityHash: `未取得`
- runningBuildId: `未取得`
- availableBuildId: `未取得`

## Redacted diagnostic record

```json
{
  "generatedAt": "2026-08-30T06:01:35.047Z",
  "configuredCommand": "~/.penguin/bin/penguin-mcp",
  "launcherTarget": "~/.penguin/bin/penguin-mcp-launcher.mjs",
  "initialize": {
    "ok": false,
    "response": null,
    "error": "mcp-session-diagnostic exited code=126 signal=none"
  },
  "tools/list": null,
  "mcp_health": null,
  "knowledge_capabilities": null,
  "capabilityHash": null,
  "runningBuildId": null,
  "availableBuildId": null,
  "failureClass": "LAUNCHER_EXECUTION_FAILED",
  "session": {
    "command": "~/.penguin/bin/penguin-mcp",
    "args": [],
    "pid": 90701,
    "stdout": "",
    "stderr": "~/.penguin/bin/penguin-mcp: line 4: ~/.penguin/bin/penguin-mcp-launcher.mjs: Permission denied\n~/.penguin/bin/penguin-mcp: line 4: exec: ~/.penguin/bin/penguin-mcp-launcher.mjs: cannot execute: Undefined error: 0\n",
    "protocolLines": [],
    "messages": [],
    "spawnError": null,
    "exitCode": 126,
    "exitSignal": null
  }
}
```

## Round 1 fix evidence

- C1: 脱敏先处理 JSON 字符串，再递归处理对象；覆盖合成的 Bearer token、嵌套 `name/value` headers，报告与安全 sidecar 均不保存真实 token。
- I1: focused test 的 fixture 通过可执行 shebang 目标和 shell `exec` wrapper；目标权限为 `755` 时成功，改为 `644` 时返回 `LAUNCHER_EXECUTION_FAILED` / exit code `126`。
- I2: `McpSession` 的完整 stdout/stderr 先脱敏后保留；超过 256 KiB 时主报告引用 `${reportPath}.streams.json`，sidecar 保存完整安全 session 流并已读回校验。

### Required verification

1. Typecheck

   Command:

   ```bash
   rtk pnpm run typecheck
   ```

   Exit code: `0`

   Result: all workspace builds and the root `tsc -b` completed successfully.

2. Focused test

   Command:

   ```bash
   rtk pnpm exec esbuild packages/mcp/src/__tests__/round13-mcp-contracts.test.ts --bundle --platform=node --target=node24 --format=esm --external:better-sqlite3 --outfile=/tmp/penguin-round13-mcp-contracts.test.mjs && rtk env NODE_PATH=/Users/shieng/Desktop/Pengvi/packages/mcp/node_modules node --test --test-name-pattern='diagnostic' /tmp/penguin-round13-mcp-contracts.test.mjs
   ```

   Exit code: `0`

   Result: `5` diagnostic tests passed, `0` failed, covering successful session, launcher permission failure, Bearer/nested-header redaction, complete large-stream sidecar readback, and initialize failure classification.

3. Second diagnostic against the installed launcher

   Command:

   ```bash
   rtk node scripts/knowledge-mcp-session-diagnostic.mjs
   ```

   Exit code: `1`

   Result: expected current-environment failure classification `LAUNCHER_EXECUTION_FAILED`; launcher exited `126`, stdout was empty, and stderr retained both permission-denied lines in redacted form. No MCP parity failure was reported.
