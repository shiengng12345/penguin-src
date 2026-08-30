# Task 2A — stable MCP launcher 权限与真实启动

## 状态

**完成。** Task 1 已确认的 `LAUNCHER_EXECUTION_FAILED` / exit 126 根因是：
`~/.penguin/bin/penguin-mcp` wrapper 可执行，但它 `exec` 的
`~/.penguin/bin/penguin-mcp-launcher.mjs` 没有执行位。

## 实现

`src-tauri/src/mcp.rs` 的 `install_stable_mcp_launcher` 在 atomic write 后，
Unix 下对以下两个文件统一设置 `0o755`：

- `~/.penguin/bin/penguin-mcp`
- `~/.penguin/bin/penguin-mcp-launcher.mjs`

Rust 回归测试 `stable_launcher_install_makes_wrapper_and_target_executable`
对 wrapper 与 launcherTarget 都断言实际 mode 为 `0755`。

## TDD 证据

- Red：临时将生产权限值改为 `0644`，运行
  `rtk cargo test --manifest-path src-tauri/Cargo.toml stable_launcher_install`；
  测试按预期失败，报告 wrapper 实际 mode `0644`（420），期望 `0755`（493）。
- Green：恢复生产值 `0755` 后，同一测试通过：`1 passed`。

## 验证

1. `rtk cargo test --manifest-path src-tauri/Cargo.toml stable_launcher_install`
   - `1 passed`。
2. `rtk cargo test --manifest-path src-tauri/Cargo.toml mcp`
   - `22 passed, 96 filtered`。
3. `rtk pnpm run typecheck`
   - exit `0`，workspace builds 与 root `tsc -b` 通过。
4. 真实 launcher diagnostic：
   `rtk env PENGUIN_MCP_DIAGNOSTIC_REPORT=/tmp/penguin-task2a-installed-diagnostic.md node scripts/knowledge-mcp-session-diagnostic.mjs`
   - exit `0`，`failureClass=NONE`。
   - wrapper 与 launcherTarget readback 均为 `-rwxr-xr-x` / `755`。
   - `initializeOk=true`。
   - `tools/list` 成功，返回 `75` 个工具。
   - `mcp_health` 成功。
   - `capabilityHash=40ae9528330e4e97d68072d3c40c1be3db9e40f8f52478b44c8de026be4487d0`。
   - `runningBuildId=availableBuildId=12765c69a2ed6a33`。

## Concerns

- Rust 测试输出当前工作树已有的 unused-import/dead-code warnings；本 Task 未扩大范围处理。
- 本次未新增或修改状态/UI 逻辑；工作树中已有的其他改动均保留。
- 真实 diagnostic 验证的是当前用户目录下已安装的 runtime；没有额外执行 Tauri release bundle republish。
