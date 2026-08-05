# Phase 1B 承接清单（来自 Phase 1A 终审与任务台账）

来源：Phase 1A（trust plumbing，5a682e6..b5e5bde）全分支终审 + SDD 台账。1B 规划时逐项处理。

## 必须项（1B 不完成不得收紧 UI）

1. **移除 Wiki 桥的 `--allow-fallback` 强制注入并渲染 blocker**（`query-server.ts` knowledge.cli 分支，代码内有注释标记）。这是 1A 的临时保护；1B 的 Wiki 必须学会渲染 `BRANCH_NOT_INDEXED` blocker（含 `penguin index` 指引与 fallback 按钮）后才移除。

## 终审列出的五个 Important（全部路由到 1B）

2. **长驻读服务的迁移豁免要么修掉要么记录为决策**：`query-server.ts:34` 与 `packages/mcp/src/knowledge-tools.ts:110` 打开 store 时允许 schema mutation——启动 App/MCP 会静默迁移 DB（"reads never migrate" 的两个大漏洞）。修法：传 `allowSchemaMutation:false` 并把 SCHEMA_OUTDATED 做成 hello/error frame 由 UI 渲染；或在 spec 里明确记录豁免。
3. **search 的 repo 推断顺序反了**：查询文本的唯一符号匹配优先于 cwd，`penguin search Alpha` 在 repo A 里可能静默作用到 repo B 且标 aligned。修法：search 动词 cwd 优先，或推断 repo ≠ cwd repo 时发披露警告。
4. **GitState 无缓存、同步、每查询 3 个子进程**：`readGitStateDefault`（query-scope.ts:50）在长驻服务事件循环里阻塞（大仓 `git status` 50-500ms）。修法：per-rootPath 短 TTL 缓存；顺带把 `WikiNoteEditor.tsx:35` 的 legacy knowledgeSearch 迁到 canonical knowledge.search。
5. **worktree checkout 对 chokepoint 不可见**（spec 级修正）：`resolveQueryScope` 只读 `repos.root_path` 的 git 状态，worktree 用户会被误报 aligned。修法：cwd 存在时用 `git rev-parse --show-toplevel` 就地解析，与 branch 的 `checkout_path` 匹配。
6. **MCP `knowledge_search` 完全在 trust plumbing 之外**：agent 在未索引 branch 上得到静默 live-branch 结果，无 locator/警告——1B/Phase 2 动 MCP 时第一优先。

## 其他承接

7. `explore_graph` 的 canonical schema 本就是坏的（别名到 knowledge.graph.query、additionalProperties:false、缺真实字段）——修好它之后再统一 `get_node`/`explore_graph`/`compare_branches` 的 scope 语义（+ allow_fallback + envelope + git fixture 测试；1A 已对这三个工具恢复 selector 门槛，见 `legacyGatedRepoId`）。
8. CLI↔MCP 的 `scopeFallback` 语义分叉：CLI 合成 FALLBACK_LIVE_BRANCH 警告，MCP 只回原始字段——抽共享 helper。
9. exit code 3 承载三种含义（no-DB / SCHEMA_OUTDATED / v2 search error）+ files 动词 2/4 并存——1B 统一并写一张 exit-code 表。
10. 搜索 payload 两套 warnings 词汇（顶层 StructuredWarning[] vs diagnostics.warnings）——UI 渲染时写明读哪个。
11. `packages/mcp/src/index.ts:353` 的 `schemaVersion: 14` 手工字面量加一个 pin 测试防再漂移。
12. `penguin doctor` 在旧 schema 上拒绝运行（健康检查工具查不了不健康的库）——考虑豁免。
13. 廉价补测：`indexRepo` 对 `indexed_schema_version: 13` 的 branch 行真实走 rebuild 路径的集成测试（Task 3 只测了纯函数）。
14. 环境备忘：本机 `tests/knowledge-surface-parity.test.mjs` 无限挂死（断言全过但进程不退出，watcher 泄漏），所有测试门槛须排除或加超时；`search-engine.ts` 自身的 repoName/branch 匹配仍有尖角（Task 9 报告有记录）。

## 合并后手工冒烟（终审建议，动真实 ~/.penguin/knowledge v13 库）

```bash
penguin status            # 预期 exit 3 + SCHEMA_OUTDATED + penguin index 提示
penguin index             # 预期 迁移 + 强制全量重建，notes/evidence/ledger 保留
penguin context WikiSearchPage --json   # 预期 locator.branchName=main, alignment=aligned
```

之后**必须 kill 并重启**长驻 query-server / MCP 进程——旧进程会对已迁移的库继续报 schemaVersion 13 的 hello。
