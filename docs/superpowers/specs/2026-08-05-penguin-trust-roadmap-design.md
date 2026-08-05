# Penguin 信任修复 Roadmap（20 条使用限制的解决方案）

- 日期：2026-08-05
- 输入：`penguin-wiki-limitations/2026-08-05-penguin-wiki-limitations.md`（20 条限制评估）
- 依据：对 schema/存储层、查询链路（CLI/MCP/query-server）、Wiki UI 三个方向的代码实勘
- 决策人：用户全权委托技术决策；产品决策已确认（见"已锁定的决策"）

## 已锁定的决策

1. **交付形态**：完整分阶段 roadmap，逐 Phase 实施。
2. **Schema 兼容**：bump `SCHEMA_VERSION` + 强制重建索引；只迁移人工数据（notes/ledger/evidence，现有 `migrate` 命令语义已是 "notes and ledger preserved"，`command-dispatch.ts:1059`）。
3. **严格度**：分级——只有「当前 branch 完全未索引」是硬 blocker（`--allow-fallback` 可显式降级）；其余一律返回结果 + 结构化 `warnings[]`。
4. **NestJS DI 深度**：标记动态边界 + 列出候选 providers（静态扫描 `@Module` 注册表），不做运行时推导。
5. **单用户环境**：无多用户兼容包袱；PII/secret 防护缩减为 Copy for AI 前的基本扫描。

## 核心发现（为什么这比文档预估的便宜）

实勘证明多数「正确机制」已存在，失效原因是**未接线或被绕过**：

| 机制 | 现状 | 病灶 |
|---|---|---|
| 严格 revision 解析器 `resolveRevisionContext` | 已实现，会拒绝 ambiguous（`knowledge-core/src/revision.ts:87,158-170`） | 只在显式传 `--repo/--branch/...` 时才被调用；默认路径落到 4+ 处各不相同的静默 fallback |
| DI/接口分发解析 `dispatch-resolution.ts` | 整个模块已写好（`verified/candidate/unavailable` + `dependency_injection` hop 类型） | 唯一 importer 是 index.ts 的 re-export，`buildFlow` 从未调用 |
| edge provenance/confidence | DB 列已存在（`schema.ts:168-171`：`origin/method/confidence/provenance`），indexer 在写 | 查询端 `GraphView` 只透传 `edgeType`；UI 类型层把 `sourceType` 丢弃（`knowledge-client.ts:240`） |
| 未解析引用计数 | `resolveRefs` 计算 `unresolved`/`unresolvedNames`（`resolve.ts:13-20`） | 计数从未持久化；`QueryDiagnostics.evidence.unresolvedReferenceCount` 硬编码 0（`query.ts:781`） |
| 搜索分阶段预算 | `planSearch` 产出 `budgetMs`（`search-planner.ts:15-18`） | `budgetMs` 全库无人读取；`timingsMs` 强制置空、`truncated:false` 硬编码（`search-engine.ts:245`） |
| Locator 契约 | `SearchLocator` 已是正确形状（`search.ts:93-110`） | 只有 search 用；其余每个查询各造各的 envelope |
| 快照按 schema 版本分键 | snapshot key 已内嵌 `SCHEMA_VERSION`（`pipeline.ts:686`） | `files_index` 检查点仍会短路解析；`indexed_schema_version` 写了但从不比较（`pipeline.ts:651`） |

另有实勘确认的文档外 bug：
- Wiki footer `Connected · SQLite` 是**硬编码静态文案**（`WikiPage.tsx:280-284`），未连任何真实状态。
- 搜索页 repo/branch 过滤框**静默失效**：query-server 只保留带 `snapshotId` 的 scope（`query-server.ts:54-56`），裸 repoName/branch 被丢弃。
- `affected` 的 snapshot 路径无条件返回 `tests:[]`、`routes:[]`（`query.ts:2035`）——相对 legacy 路径的静默功能回归。
- schema 版本升级后，**任何只读命令都会变成写入者**（`schema.ts:893-914`：probe 失败即执行 DDL+migrate）。
- 同一查询在不同入口可能解析到**不同 branch**（CLI search 用 `default_branch DESC, name`，query.ts `liveBranchOf` 用 `last_indexed_at DESC`）。

## 总体架构决策

### D1. 统一 Locator 与响应信封

把 `SearchLocator` 提升为共享 `KnowledgeLocator`（`knowledge-contracts`），字段：`repoId, repoName, rootPath, branchName, commitSha, snapshotId, worktreeState, indexedAt, filePath?, nodeId?, contentHash?`。所有查询结果携带：

```
{ locator: KnowledgeLocator, alignment: "aligned"|"revision_behind"|"fallback", warnings: StructuredWarning[] }
```

注入点选（ii）方案：在三个出口统一包裹——CLI `emit()`（`command-dispatch.ts:202`）、MCP `handleKnowledgeTool` 返回处（`knowledge-tools.ts:477`）、query-server `invoke`（`query-server.ts:45`）。`TrustEnvelope`/`QueryDiagnostics` 并入该信封而非并存。

### D2. 唯一作用域解析入口 `resolveQueryScope()`

新函数（knowledge-core），职责：

1. **查询时 git 自省**（目前全查询链路零处 `rev-parse`）：读 cwd 实际 branch + SHA + dirty 状态；
2. 委托现有严格 `resolveRevisionContext`；
3. 当前 git branch 未索引 → 抛 `BRANCH_NOT_INDEXED`（硬 blocker，提示 `penguin index`），`--allow-fallback` 显式降级且 warnings 必带 fallback 说明；
4. repo 歧义（同名/多 worktree）→ 沿用 core 已有 `ambiguous` 行为，列 `repoId + rootPath` 拒绝自选。

**替换清单**（全部静默 fallback 站点）：
- CLI search 裸 SQL fallback（`command-dispatch.ts:1331-1342`）
- `scopeRows` 全库兜底（`search-engine.ts:65-67,112`）
- `liveBranchOf` 的 4 个调用点：`buildFlow:1803`、`buildContextPack:1461`、`exploreGraph:881`、`buildQueryDiagnostics:735`
- MCP `resolveMcpRevision`（`knowledge-tools.ts:412`，与 CLI 重复实现——删除，改调共享入口）
- Wiki UI first-live-branch 捷径（`WikiPage.tsx:137`）、`compactIndexStatus:1315`、`getBranch(repoId, undefined)` 等 store 级默认

### D3. Schema 变更一次到位（bump 至 14）

- `pipeline.ts:651` 加 `|| (prior?.indexed_schema_version ?? 0) !== SCHEMA_VERSION` 强制 rebuild；
- 新列（全部 ALTER ADD COLUMN，遵循 migrate()/isSchemaCurrent() 双镜像同步的既有 gotcha）：
  - `branches`: 无需新列（拆分状态从既有列推导）
  - `coverage 层级`: 新表 `coverage_layers(repo_id, branch_id, layer, resolved, total, updated_at)`，layer ∈ file/symbol/edge/route/di/test
  - `edges`: `evidence_id TEXT`（关联 `trust_evidence`）、`boundary TEXT`（`di|interface|callback|event` 或 NULL）
  - `unresolved 计数`: 持久化到 `coverage_layers(layer='edge')`
- **只读打开模式**：`openDatabase` 增加 readonly 探针路径——probe 失败时只读命令报 `SCHEMA_OUTDATED` blocker 而不是就地跑 migration/DDL。

### D4. flow 断链诚实化

- `FlowStep` 增加 `boundary?: { kind, candidates: Array<{nodeId, title, registrationSite}> }`；
- 接通 `dispatch-resolution.ts` 到 `buildFlow`；
- 诊断不再只限根节点（现状 `steps.length === 1` 才发，`query.ts:1801,1835`）——interior 断链每一处都发；
- snapshot 路径 `dst: null` 边不再被静默过滤（`query.ts:1795`），转为 boundary 步骤；
- NestJS 候选 providers：indexer 增加 `@Module({providers})` 注册扫描，`useClass/useFactory/token` 记为 `boundary='di'` 的 INFERRED 边 + 注册位置。

## Phase 划分与验收标准

### Phase 1 — 地基（限制 1,2,8,12,13,14,15,16）
D1 + D2 + D3 + Wiki 状态面：footer 换 `knowledge.status_panel`（DB/Revision/Index/Coverage 分行）、search hit → Context 传完整 locator（修 `WikiSearchPage.tsx:133-136` 丢 `revisionId`）、service graph 尊重 core ambiguous（branch 选择器替代 `WikiPage.tsx:137` 捷径）、Context/Graph 顶栏常驻 repo+branch+SHA+worktree。

**验收**：切到未索引 branch 查询 → 明确 blocker 而非他 branch 答案；`penguin context WikiSearchPage` 在索引 main 后可命中；同一查询在 CLI/MCP/UI 解析到同一 branch；schema bump 后首个 `penguin index` 自动全量重建、notes/evidence 保留、只读命令不再触发写。

### Phase 2 — 边可信度（限制 3,5,7,10,17）
D4 + 持久化 unresolved 计数 → `coverage_layers` + `penguin coverage` 分层展示；`affected` BFS 保留 parent link（`query.ts:2046-2056`）输出 path + 每跳 `via`/`method`，修 snapshot 路径 tests/routes 回归（`query.ts:2035`）；Graph 客户端类型带 `sourceType/method`（`knowledge-client.ts:240`），INFERRED 虚线、edge-type/provenance 过滤开关（`GraphStatsOverlay` badges 变 toggle）、generated/test 降权。

**验收**：`flow LookupNationalId` 在 SPI 边界显示 boundary + 候选 providers + 注册位置；graph 上 INFERRED 与 EXTRACTED 视觉可分；`coverage` 输出 file/symbol/edge 三层各自比例；`affected` 每条 impacted 带完整路径。

### Phase 3 — 查询体验（限制 4,6,9）
search 执行层尊重 `budgetMs`、填真 `timingsMs/truncated/skippedLanes`、CLI `--timeout`（默认 30s）+ 阶段进度（复用 `render-progress.ts` 通道）；修 query-server 丢 repoName/branch scope（`query-server.ts:54-56`，先经 resolveQueryScope 换成 snapshotId）；消歧排序：当前 repo > 当前 branch > declaration > production source > exported > test/mock/field，多候选出消歧表；所有截断列表 `N of M`（context pack limit 25、UI slice 14/8/30、graph edge cap 1000 全部补 COUNT 伴随值），Copy for AI 附 locator + omitted 计数（并入服务端已有但未用的 `renderContextPackMarkdown`，`query.ts:1596`）。

**验收**：宽泛搜索 30s 内必有结果或超时说明+已完成阶段；搜索页 repo/branch 过滤真实生效；高连接 symbol 的 Context 显示 `14 of 237`。

### Phase 4 — 诚实性收尾（限制 11,18,19,20）
evidence 读取时检查 `expires_at`（列已存在，`schema.ts:585-598`）过期自动降级 `historical`；查询空/断链/blocker 时输出结构化 `insufficiency`（建议下一步：source/SLS/DB/deployment）；version manifest（CLI/parser/schema/capabilityHash 一处定义，doctor + About 页展示，Tauri 侧补 schemaVersion 严格校验，`knowledge.rs:164-172` 现只查存在性）；Copy for AI 前复用 `secret_policy` 分类器做基本扫描。

**验收**：过期 evidence 不再以 verified 展示；`flow` 断链输出「Penguin insufficient — 建议查 module registration / SLS」；About 显示全套版本；doctor 能检出 CLI/DB schema 失配。

## 风险与已知取舍

- **单次 schema bump 换全量重建**：用户唯一使用者，成本可接受；notes/ledger 由既有 migrate 语义保护，动手前先验证该命令实际行为。
- **git 自省引入查询开销**：`rev-parse` + `status --porcelain` 每查询一次，本地 SSD 上 <10ms，可缓存 2s。
- **NestJS 候选扫描是启发式**：只承诺「列出候选 + 注册位置」，不承诺选中项，与决策 4 一致。
- **不做**：运行时 provider 推导、完整 PII 分级分类、多用户权限、semantic search 重构（`searchKnowledgeAsync` 与 CLI 的脱节记为后续独立事项）。
