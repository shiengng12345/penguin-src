# Penguin P0 可信回答契约实施计划

> 执行方式：在当前 `feature/knowledge-core` 分支顺序执行。因存在用户未提交且重叠的改动，不创建 worktree；代理不执行 `git add/commit/push/stash`。

## 全局约束

- 所有 shell 命令以 `rtk` 开头。
- 理解代码优先 CodeGraph/Penguin/Graphify。
- 每个任务严格 RED → GREEN → REFACTOR。
- 不新增 npm package，不读取 `.env*`，不修改全局 Codex/Claude 配置。
- 修改后输出 diff/status，由用户自行决定提交。

## Task 1：Runtime doctor 与真实 MCP smoke

**预计文件**

- `scripts/check-knowledge-runtime.mjs`（新增）
- `tests/knowledge-runtime-doctor.test.mjs`（新增）
- `package.json`（新增可重复命令）

**步骤**

1. 写失败测试：缺 Node、ABI 不匹配、有效 vendored closure，以及 protocol smoke 的错误分类。
2. 运行单测，确认因 doctor 不存在/行为缺失而失败。
3. 实现只读 doctor：输出 JSON manifest，校验 Node version/ABI、native addon load、MCP initialize、tools/list、knowledge index status/search。
4. 运行单测和实际 bundle smoke；保持不写用户配置。

## Task 2：Dirty/branch/freshness 索引契约

**预计文件**

- `packages/knowledge-indexer/src/git.ts`
- `packages/knowledge-indexer/src/pipeline.ts`
- `tests/knowledge-indexer-pipeline.test.mjs`

**步骤**

1. 写失败测试：真实临时 Git repo 的 clean、modified、untracked；dirty 文件 version 不可记录 HEAD；IndexReport 返回 trust metadata。
2. 构建 indexer 并运行目标测试，确认预期失败。
3. 扩展 `GitContext`：`worktreeState`、`dirtyFiles`、`worktreeFingerprint`、`statusError`。
4. 扩展 `IndexReport`：明确 `headCommit/indexedCommit`、dirty/pending、parser/schema version 与 stale reason。
5. 对每个文件按 dirty set 选择 HEAD 或 `(worktree)` 归属；默认 branch scope 继续复用 live branch。
6. 运行目标测试、branch lifecycle 与 graph query 回归。

## Task 3：Golden graph quality benchmark

**预计文件**

- `tests/fixtures/knowledge-quality/**`（新增）
- `scripts/knowledge-quality-benchmark.mjs`（新增）
- `tests/knowledge-quality-benchmark.test.mjs`（新增）
- `package.json`（新增命令）

**步骤**

1. 写失败测试，固定预期 edges/affected/tests/routes 与 TP/FP/FN schema。
2. 实现临时 DB harness，索引 fixture 并比较实际/预期集合。
3. 覆盖 TS/TSX、React JSX、Nest route/gRPC、tests、branch isolation、rename/delete；无法可靠解析的动态边必须标为 coverage gap，不可静默计为成功。
4. 输出机器可读 JSON；设置第一阶段守门阈值并运行两次确认 deterministic。

## 最终验证

1. 运行三个新增目标测试。
2. 运行 knowledge-core/indexer/MCP/CLI build 与 typecheck。
3. 运行完整 `node --test tests/`。
4. 检查 diff 只包含本批文件和原有用户改动；不执行 commit。
5. `penguin index`/`graphify update .` 会写图数据库或生成物，本轮仅在确认不会污染用户状态时执行；否则在交付中明确列为用户后续动作。

