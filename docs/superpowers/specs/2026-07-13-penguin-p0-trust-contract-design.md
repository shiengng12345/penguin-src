# Penguin P0 可信回答契约设计

## 状态

- 日期：2026-07-13
- 设计依据：`.codex/penguin-wiki-optimization-review.md`
- 授权：用户在阅读对比审查后明确要求“plan and do for me”，视为批准先实施 P0 tranche。
- 边界：本轮不实现 Hero MCP、LSP/SCIP、WHY lifecycle、向量检索或社区算法替换。

## 问题

Penguin 的图谱能力已经丰富，但结果目前缺少统一的可信度边界：MCP 可能由不匹配的 Node/native ABI 启动；dirty worktree 内容会被归因给 HEAD；不同查询入口的 branch 默认值不完全一致；现有测试没有量化召回/误报。

## 成功标准

1. MCP 安装路径只配置 vendored Node，并能通过真实 initialize/tools/list/knowledge smoke。
2. indexer 能区分 clean、dirty、unknown worktree；dirty 文件的 symbol version 不再声称来自 HEAD commit。
3. 索引报告返回 repo/branch/HEAD/dirty/fingerprint/parser/schema 等信任元数据，供 CLI、MCP、UI 共享。
4. deterministic fixture 输出 TP/FP/FN、precision/recall，并覆盖 TS/TSX、test mapping、route/gRPC、branch、rename/delete。
5. 新增测试先红后绿；不新增依赖；不修改用户全局配置。

## 架构决定

### AD-1：HEAD + worktree overlay

将 `GitContext.commit` 明确为 `headCommit` 的来源，同时新增 worktree 状态、dirty file list 和 fingerprint。clean 文件可以记录 HEAD；dirty/untracked 文件的 `symbol_versions.commit_sha` 使用 `(worktree)`，避免伪造提交归属。

如果 git 状态不可读取，返回 `unknown`，而不是默认为 clean。非 Git 目录保持 `(workdir)`。

### AD-2：复用现有边界

不新增独立 trust service。扩展已有 `GitContext` 与 `IndexReport`，复用 `branches.head_commit`、`symbol_versions.commit_sha/content_hash`、schema version 和 parser registry。查询层后续从这些原语组装完整 Trust Envelope；本批先保证索引事实正确且可被所有入口消费。

### AD-3：vendored runtime 为唯一支持组合

安装器已有稳定目录同步和 MCP initialize 检查。本批补机器可执行的 runtime manifest/doctor smoke，验证 Node ABI、native addon、server initialize、tools/list 和只读 knowledge tool。系统 Node 仅可用于开发构建，不写入生成的 MCP 配置。

### AD-4：benchmark 与 live DB 隔离

质量基准在临时 repo + 临时 DB 上运行，固定预期边集合并输出 JSON。失败时同时报告 FP/FN，避免“节点数很多”等代理指标。

## 风险与缓解

- 当前工作树已有 knowledge 改动：逐文件检查 diff，只追加最小变更；不重写已有代码。
- `git status` 不可用：降级为 `unknown` 并暴露原因；索引仍可继续。
- benchmark 过度拟合：fixture 覆盖正例、负例和 lifecycle；不把 live repo 结果写成 golden。
- runtime smoke 误改用户配置：测试只使用临时目录或现有 bundle，绝不写 `~/.codex`。

## QA 范围

- 自动化：Git clean/modified/untracked/unknown；dirty commit attribution；runtime manifest/ABI；MCP protocol handshake；benchmark JSON 与阈值。
- 回归：knowledge-core、knowledge-indexer、MCP、CLI build 与现有 Node tests。
- 不做：GUI/Playwright（本批无 UI 变更）、发布和真实用户配置迁移。

