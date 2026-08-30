# Task 2B — MCP 状态/UI 语义与 runtime outdated 指引

## 状态

**完成，带一个既有的非 Task 2B Node 合约失败。** 已保留 Task 2A 已通过的 stable launcher 与启动 preflight 行为。

## 实现

- `mcp_status` 继续分离 `configured`、`launcherHealthy`、`initializeHealthy`、`clientRestartRequired` 和 `runtimeOutdated`；新增 `launcher_path` 供 Settings 和手工配置片段使用。
- Claude Desktop、Claude Code、Codex 的自动写入与 Settings 复制片段均使用 home-directory-derived `~/.penguin/bin/penguin-mcp` stable launcher，并使用空 `args`；不再写入固定 `runtimes/<version>` 路径。
- 保留无关 MCP server，只移除可识别的 Penguin-owned `pengvi` alias；既有 idempotency、alias migration 和 launcher 权限测试保持通过。
- MCP `mcp_health` 明确表示本地 MCP initialize/session 状态，不冒充外部客户端已加载配置；generation 变化时返回 `status: "outdated"`、running/available build id 和 `restart_mcp_session` action/notice。
- Settings 不再显示会暗示 live client session 的 `MCP Ready`。现在分别显示 config written、stable launcher、local initialize，并明确提示完全退出并重启客户端；outdated 时提示重启 MCP session，仍 outdated 则 reconfigure。
- 更正 `task-2a-report.md` 中 `startup_preflight` 的 `2 passed` 为实际 `4 passed`。

## TDD / 回归证据

- 新增 Settings 状态分离与 stable launcher snippet 断言；先运行时按预期失败，随后实现后通过。
- Rust 既有配置回归覆盖：canonical launcher、无 versioned runtime path、保留其他 server、alias migration、byte-stable second run。
- MCP generation-watch 回归覆盖：manifest 变化、sticky outdated、action/notice、generation lease。

## 验证

1. `rtk cargo test --manifest-path src-tauri/Cargo.toml mcp`
   - **27 passed, 96 filtered out**（2 suites）。
2. `rtk cargo test --manifest-path src-tauri/Cargo.toml client_configs_use_the_stable_launcher_without_versioned_runtime_paths`
   - **1 passed, 122 filtered out**。
3. `rtk pnpm run typecheck`
   - **exit 0**，workspace builds 与 root `tsc -b` 通过。
4. 编译后针对新增/相关合约运行 `node --test --test-name-pattern 'MCP health|Settings'`
   - **4 passed**。
5. `rtk node --test tests/mcp-generation-watch.test.mjs`
   - **8 passed**。
6. `rtk node --test tests/settings-dialog.test.mjs`
   - **8 passed**。
7. 指定的完整 `rtk node --test packages/mcp/dist/__tests__/round13-mcp-contracts.test.js`
   - **10 passed, 1 failed**：既有 resolver 断言实际返回 `TARGET_NOT_FOUND`，测试期望 `TARGET_NOT_RESOLVED`；与 Task 2B launcher/status/UI 变更无关，未扩大范围修改。
8. `rtk proxy git diff --check`
   - 只报告工作树已有的 `docs/quality/index-evaluation-brief.md` trailing whitespace，未由本 Task 引入。

## Concerns

- 完整 MCP Node 合约仍有上述既有 resolver mismatch；它不是本 Task 2B 回归，但指定命令因此不是全绿。
- Rust 测试仍有当前工作树已有的 unused-import/dead-code warnings。
- `mcp_status` 的 `initializeHealthy`/`runtimeOutdated` 在快速 Tauri probe 中保持 `null`，因为它不能观测外部客户端 live session；真实 session 的 generation/outdated 信号由 `mcp_health` 提供。这是防止误报的有意边界。
- 未构造 release bundle/Tauri 外部客户端重启流程；本轮验证的是源码、构建产物、Rust config/status seam 和独立 MCP generation 行为。

## Round 1 修复与验证（2026-08-30）

### 修复

- 统一 MCP generation watcher 的来源：优先读取 `PENGUIN_RUNTIME_ROOT/manifest.json`；未设置时保留开发环境的 `~/.penguin/mcp/manifest.json`。versioned runtime lease 也写入对应的 `<runtimeRoot>/<buildId>/.leases`，不再落到无关的 `generations/` 根目录。
- Tauri 本地 MCP probe 为真实 stdio session 发送 `initialize`、`notifications/initialized` 和 `mcp_health`，透传 `serverGeneration`、`runtimeOutdated` 与 restart action；`mcp_status` 对外部 client live session 仍返回 `null`，避免误报。
- install 返回 `wroteConfig`、changed/unchanged clients；Settings 将 `configuration present`、本次 write result 和可清除的 client reload reminder 分开显示。
- Settings 的 setup snippet 复制条件改为 `launcherHealthy === true`，launcher 不可用时显示明确提示；runtime outdated 优先于 partial setup 标签。

### Round 1 命令结果

1. `rtk pnpm run typecheck`
   - **exit 0**，workspace builds、MCP bundle 与 root `tsc -b` 通过。
2. `rtk node --test tests/settings-dialog.test.mjs tests/mcp-status.test.mjs`
   - **12 passed, 0 failed**。
3. `rtk node --test tests/mcp-generation-watch.test.mjs`
   - **9 passed, 0 failed**，包含真实 `scripts/knowledge-mcp-launcher.mjs` + 临时 `~/.penguin/runtimes` 版本化根目录；验证旧 `runningBuildId`、新 `availableBuildId`、`outdated: true` 和 restart action。
4. `rtk cargo test --manifest-path src-tauri/Cargo.toml mcp`
   - **28 passed, 96 filtered out**（2 suites）。
5. `rtk node --test packages/mcp/dist/__tests__/round13-mcp-contracts.test.js`
   - **10 passed, 1 failed**：既有 resolver mismatch，实际 `TARGET_NOT_FOUND`、断言期望 `TARGET_NOT_RESOLVED`；未扩大 Task 2B 范围。

### Round 1 concerns

- 完整 Node MCP 合约仍有上述既有 resolver mismatch，因此该命令不是全绿。
- Rust 测试保留当前工作树已有的 unused-import/dead-code warnings。
- 未执行真实发布包安装和外部 Claude/Codex client 重启；本轮已执行真实 stable launcher 的 versioned-runtime stdio E2E，外部 client live session 仍由 MCP health 明确标记为不可观测。
