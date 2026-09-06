# Penguin Knowledge fresh-session checkpoint — 2026-09-01

## 目的

这是当前开发中的 **Checkpoint B1**，不是最终 95–100/100 验收。请在安装
最新 DMG 后，用一个全新的 Claude Code 或 Codex session，只通过 Penguin MCP
进行测试。不要把旧 session 的工具列表、旧 node ID、旧 capability 结果当作
本轮证据。

安装包：

`/Users/shieng/Desktop/Pengvi/src-tauri/target/release/bundle/dmg/Penguin_1.16.0_aarch64.dmg`

测试前必须：

1. 退出旧 Penguin app，并从 DMG 安装新版本。
2. 启动 Penguin，打开 Settings，点击一次 `Reconfigure MCP Clients`。
3. 完全退出并重新启动 Claude Code/Codex；然后创建一个全新的 session。
4. 先用 MCP `tools/list`，确认使用的是当前 session 刚加载的 Penguin server。
5. 记录 `mcp_health`、`knowledge_capabilities` 的完整结构化结果；不要只看自然语言摘要。

## A. Runtime identity（必须先测）

调用：

- `mcp_health`
- `knowledge_capabilities`，参数 `{"compact": true}`

记录并比较：

- MCP server version / build ID
- `schemaVersion`
- `contractVersion`
- `capabilityHash`
- `modelHash`
- `serverGeneration.runningBuildId` 与 `availableBuildId`
- `serverGeneration.outdated`
- native/model runtime 是否 ready（如果 health 返回该信息）

预期：

- server 可以 initialize，`tools/list` 非空。
- `mcp_health.status` 为 `ok`，且 `outdated` 为 false。
- compact capabilities 也必须包含 64 位十六进制 `modelHash`，不能出现 undefined。
- embedded MCP 与 stable launcher 的 build/capability/schema/model identity 应一致。

如果 A 失败，停止后续评分，标记为 **release/runtime identity failure**，并附上
完整的 MCP response。

## B. 正常 scoped knowledge 查询

先从 `index_status` 或 `knowledge_status_panel` 取得一个当前确实已索引的 repo、
branch 和 snapshot。再使用 `tools/list` 中实际公布的 canonical tool 名称完成：

1. `knowledge_search`：查询一个该 repo 中确定存在的 symbol、类名或文件路径。
2. `knowledge_context`：对搜索结果中的稳定 `nodeId` 查询 callers/callees/types/tests。
3. `knowledge_explore`：对同一个目标查询 Explore pack。
4. 如工具列表公布 `knowledge_get_node`，用同一个 `nodeId` 做一次 detail round-trip。

每个结果都记录：

- repo、branch、snapshot/commit
- revision trust/freshness/alignment
- coverage、gaps、evidence status
- 返回的 node ID 是否能在下一次查询中复用

预期：同一个 repo/branch/revision 内的 search → context → explore → detail 不会
改变目标身份，也不会混入其他 repo 的同名结果。空结果必须包含 diagnostics，
不能直接被解释成“不存在”。

## C. Working-tree overlay（本 checkpoint 的核心）

选择一个本机有权限、已经被 Penguin 索引、且当前 checkout 在已索引 branch 的
小型 Git repo。测试期间不要先执行 full rebuild。

1. 在该 repo 修改一个已有源码文件，加入一个容易唯一搜索的 marker，例如
   `penguin_checkpoint_overlay_20260901`。
2. 可选：新增一个未跟踪源码文件，并记录文件路径。
3. 在全新 MCP session 中调用 `knowledge_search`，使用工具 schema 支持的精确
   working-tree scope：

   ```json
   {
     "query": "penguin_checkpoint_overlay_20260901",
     "scope": { "revisions": [{ "repoId": "<当前 repo id>", "workingTree": true }] },
     "page": { "limit": 10 }
   }
   ```

4. 检查结果中的：

- `workingTree.applied == true`
- `revision.trust == "exact_worktree"`
- resolved scope 的 `revisionKind == "working_tree"`
- hit/snippet 能看到刚才的 marker
- modified/added/untracked paths 与实际修改一致
- 原 branch 的 durable `current_snapshot_id` 没有被 overlay 查询改写（可通过
  `index_status` 前后对比确认）

5. 删除或还原 marker，再重复查询；旧 overlay 结果不能继续被当成当前源码事实。

预期：工作区查询只建立 owner-local、revision-scoped 的 overlay；不会把未提交
内容伪装成 HEAD commit，也不会修改 durable ready snapshot。若当前 MCP schema
不接受上述 scope，记录实际 schema 和 typed error，不要改用旧 CLI 来替代本项。

## D. Scope safety（可选但建议）

如果当前索引有两个 repo，且能找到两个同名 symbol：

1. 用 repo A 的 snapshot 请求 repo B 的 `nodeId`，预期是 typed `SCOPE_MISMATCH`。
2. 对 repo A 的同名目标执行 `knowledge_explore`，候选、relations、evidence 不得
   泄漏 repo B。
3. 使用 cursor 时故意换 repo/branch/limit，预期是 cursor scope/request error，
   不能返回另一 scope 的数据。

## E. 并发 timeout（可选）

并发发起两个合法 MCP 查询，其中一个占用 query worker，再观察排队中的请求。
记录 timeout error 的 code、queue wait 和 execution time。排队等待不应被误算成
已经开始执行的 query timeout；如果请求尚未 dispatch，不能产生误导性的空成功结果。

## 本 checkpoint 的评分边界

本 checkpoint 只验证：

- 安装包内 MCP/CLI/runtime identity 一致；
- working-tree overlay 的核心可用性；
- revision scope 不串库；
- Explore、`get_node` 和 query timeout 的当前回归修复。

本 checkpoint **不宣称**以下项目已经完成：

- communities 全量分页与 total/truncated contract；
- environment/Vault/config → constructor → runtime lineage；
- Domain/Wiki 全部最终闭环；
- durable index job 的完整 pause/resume UI；
- full G13–G30、Rust/Domain/Onboarding ≥90；
- 最终两份独立 MCP-only 95–100 报告。

## 输出格式

请返回：

1. 安装包和新 session 的 runtime identity 表。
2. A–E 每项：PASS / FAIL / NOT TESTED。
3. 每个 FAIL 的完整 structured response、repo/branch/snapshot 和时间。
4. 分数时把本 checkpoint 分数与最终产品分数分开；不能用本 checkpoint 直接宣布
   Penguin 已达到 95–100。
