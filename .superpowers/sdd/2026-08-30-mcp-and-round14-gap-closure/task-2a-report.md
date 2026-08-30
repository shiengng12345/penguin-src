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

## Round 1 修复（审查 Important）

### 修复内容

- 将 launcher 安装核心改为接收显式 home 路径；生产入口仍从 `dirs::home_dir()` 解析，Rust 权限回归测试使用唯一临时 home，真实写入后读取 wrapper 和 `penguin-mcp-launcher.mjs` 的 metadata mode，未写入真实 `~/.penguin/bin`。
- 将启动顺序抽为可测试的 preflight seam；生产路径仍按 `bundled runtime sync -> ensure stable MCP server -> Node/initialize health gate -> launcher install` 执行。sync、migration、无 Node、initialize 失败均保持 best-effort，launcher install 仍会继续尝试。
- 诊断记录新增 `launcherReadback.wrapperMode` 与 `launcherReadback.launcherTargetMode`，并同步输出 Markdown 摘要。

### Round 1 命令与结果

1. RED（新增测试在 seam 尚不存在时）：

   ```bash
   rtk cargo test --manifest-path src-tauri/Cargo.toml startup_preflight
   ```

   预期失败：缺少 `install_stable_mcp_launcher_at` 与 `run_mcp_startup_preflight`；不是测试断言或环境失败。

2. 针对性 Rust 测试：

   ```bash
   rtk cargo test --manifest-path src-tauri/Cargo.toml stable_launcher_install
   rtk cargo test --manifest-path src-tauri/Cargo.toml startup_preflight
   ```

   结果：分别 `1 passed`、`4 passed`。

3. 完整 Rust MCP tests：

   ```bash
   rtk cargo test --manifest-path src-tauri/Cargo.toml mcp
   ```

   结果：`27 passed, 96 filtered`。

4. Typecheck：

   ```bash
   rtk pnpm run typecheck
   ```

   结果：exit `0`，workspace package builds 与 root `tsc -b` 通过。

5. 真实 diagnostic：

   ```bash
   rtk env PENGUIN_MCP_DIAGNOSTIC_REPORT=/tmp/penguin-task2a-round1-diagnostic.md node scripts/knowledge-mcp-session-diagnostic.mjs
   ```

   结果：exit `0`，`failureClass=NONE`；`initialize.ok=true`、`tools/list` 成功（75 tools）、`mcp_health` 成功；结构化记录和 Markdown 均记录 `wrapperMode=493`、`launcherTargetMode=493`（0755），running/available build id 均为 `12765c69a2ed6a33`。

### Round 1 concerns

- Rust 测试仍显示 worktree 既有的 unused-import/dead-code warnings；本轮未扩大范围处理。
- 启动 preflight 测试覆盖了生产调用顺序和错误分支，但不构造完整 Tauri `AppHandle` 或 release bundle；真实 diagnostic 覆盖的是当前用户目录下已安装 runtime。
- `rtk cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 仍会报告其他既有文件的格式差异；未对无关文件执行格式化。
