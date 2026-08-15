# Penguin Knowledge / Wiki 使用限制评估

- 日期：2026-08-05
- 评估范围：Penguin Knowledge CLI、SQLite Knowledge Graph、Penguin Wiki UI
- 评估方式：结合 FPMS-NT-Auth-Player 与 Penguin 本身的实际查询结果、branch/index 状态及 Wiki 源码进行只读评估

## 结论

Penguin Wiki 很适合快速找入口、理解大概结构、缩小代码排查范围，但不能单独作为代码事实、运行时事实或改动影响范围的最终依据。

推荐定位：

> Penguin-first, source-verified, runtime-confirmed when necessary.

也就是：

1. 先用 Penguin 找候选入口和关系。
2. 再用当前 branch 的源码确认静态实现。
3. 涉及 QAT、生产事故、Redis、DB、配置或外部供应商时，再通过实际运行证据确认。

## 概念边界

- **Penguin Knowledge**：SQLite 知识库、symbol、edge、branch snapshot、notes、evidence 及 CLI/MCP 查询层。
- **Penguin Wiki**：Search、Context、Graph、Evidence 等可视化界面，本质上展示 Knowledge 中的数据。
- **Graphify**：独立的代码图生成工具，不应与 Penguin Knowledge 混为一谈。
- **`.nse/source-wiki.md`**：导入的需求或业务文档，不等于 Penguin 自动生成的代码 Wiki。

## 本次实际观察

本次使用了以下 Penguin 能力：

- `context`
- `flow`
- `affected`
- `status`
- `coverage`
- `doctor`

实际观察结果：

- Auth 当前 Git branch 为 `brazil-v2`，虽然刚完成索引，Penguin 仍显示：
  - `stale=true`
  - `staleReason=worktree_dirty`
  - `6505 stale symbols`
  - `19 changed files`
- `SigapImpedimentService` 查询出现 10 个候选。
- `CpfCipher` 查询出现 13 个候选。
- `flow LookupNationalId` 无法完整穿过 SPI、callback、动态 provider 到 SIGAP。
- 两个宽泛 `penguin search` 查询超过 60 秒仍无结果或进度，需要人工中断。
- Auth coverage 为 `1949 discovered / 1948 admitted / 1 excluded / 0 failed`，但该数字只表示文件进入索引的情况，不代表所有 dependency edge 正确。
- Penguin repo 当前 Git branch 为 `main`，但知识库只保存了旧 branch；本地存在 `WikiSearchPage.tsx`，`penguin context WikiSearchPage` 却无法找到。
- 当前 `penguin doctor` 正常，只能证明知识数据库/ledger 健康，不能证明知识内容语义正确。

## 限制场景、说明与建议

### 1. 当前 Git branch 没有被索引

**严重度：P0**

**场景**

开发者切换到 `main`、`brazil-v2` 或 feature branch，但 Penguin 仍使用旧 snapshot、default branch 或之前的 worktree 数据。

**说明**

Penguin 仍可能返回完整源码、callers 和 tests，因此答案看起来很可信，但实际来自另一个 branch。

最危险的情况不是报错，而是返回“正确但属于其他 branch”的答案。

**建议**

- 每次查询前检查当前 Git branch 和 Penguin revision。
- 重要查询必须显式提供 repo 与 branch。
- Wiki Context、Graph 和 Copy for AI 必须显示：
  - repo
  - root path
  - branch
  - commit SHA
  - working tree 或 snapshot
  - indexed time
- 当前 Git branch 未被索引时，应显示 blocker，不应自动 fallback 到其他 branch。

### 2. Dirty worktree 的 freshness 容易误导

**严重度：P0**

**场景**

刚执行完增量索引，开发者认为内容已经最新，但 branch 仍被标记为 stale。

**说明**

一个 `stale` 状态同时承载太多含义：

- DB 是否可访问
- working tree 是否 dirty
- 当前文件是否已经重新索引
- 当前 branch 是否与索引 revision 对齐

只看 `Last indexed` 或 `Connected` 都可能产生错误安全感。

**建议**

将状态拆成：

- DB health
- Index freshness
- Revision alignment
- File/symbol content hash match
- Runtime verification status

### 3. NestJS DI、SPI、callback 和 runtime provider 造成 flow 断链

**严重度：P0**

**场景**

调用经过以下机制：

- constructor injection
- abstract base provider
- injection token
- dynamic module
- factory provider
- callback
- strategy registry
- event bus
- decorator/reflection
- `SITE_KEY` 选择的 SPI provider

**说明**

AST 能看见静态声明和直接调用，但不一定知道运行时注入哪个 implementation。

因此 Wiki 可能把动态边界显示成流程终点，让用户误以为后面没有调用。

**建议**

- 遇到动态边界时显示明确警告。
- 列出 possible providers 和 provider selection condition。
- 将 extracted edge 与 runtime-selected edge 分开。
- 实际排查时继续检查 module registration、provider token、startup log 和环境配置。

### 4. 同名 symbol 容易选错

**严重度：P1**

**场景**

查询常见 service、repository、cipher 或 module 名称。

**说明**

查询可能同时命中：

- class declaration
- constructor property
- field
- interface/type
- import alias
- test mock
- 不同 branch 的同名 symbol
- 不同 repo 的同名 symbol

AI 如果自动选择第一个结果，可能把 field、mock 或旧 branch 当成真实 implementation。

**建议**

结果排序优先级：

1. 当前 repo
2. 当前 branch
3. declaration
4. production source
5. exported symbol
6. test/mock/field

Wiki 应显示完整 disambiguation table，并鼓励使用 node ID 或 qualified name。

### 5. Coverage 数字不能代表语义图完整

**严重度：P1**

**场景**

Coverage 显示接近 100%，用户认为知识图已经完整。

**说明**

File admission coverage 不证明：

- 所有 functions 被提取
- 所有 call edges 被正确解析
- 所有 NestJS providers 被连接
- 所有 gRPC routes 被关联
- 所有 callbacks 有 caller
- 所有 tests 被正确关联
- 所有跨 repo 调用存在

**建议**

Coverage 应拆分为：

- File admission coverage
- Symbol extraction coverage
- Call-edge resolution coverage
- Route resolution coverage
- DI/provider resolution coverage
- Test-link coverage
- Cross-repo edge coverage
- Runtime-evidence coverage

### 6. Search 可能长时间无结果、无进度

**严重度：P1**

**场景**

执行宽泛 semantic search，或跨多个 repo/branch 搜索常见名称。

**说明**

CLI 可能长时间不显示：

- 当前搜索阶段
- 扫描 repo 数量
- 使用的 lane
- 是否卡在 SQLite 或 semantic search
- 预计剩余时间
- timeout 状态

**建议**

- CLI 增加 `--timeout` 和 `--progress`。
- 默认先 exact/path，再 semantic。
- 超过一定时间输出阶段性进度。
- UI 使用 repo/branch picker，减少错误 scope 和宽泛查询。

### 7. Graph UI 丢失 edge provenance 与 confidence

**严重度：P0**

**场景**

Graph 显示 `A -> calls -> B`。

**说明**

图上通常无法直接判断 edge 是：

- AST extracted
- inferred
- manually linked
- runtime verified

如果视觉上全部一样，用户很容易把推测关系当成代码事实。

**建议**

每条 edge 应保存并展示：

- provenance
- confidence
- evidence file/line
- parser version
- repo/branch/revision
- suggestion accepted/rejected status

视觉建议：

- 实线：extracted
- 虚线：inferred
- 蓝色：runtime verified
- 紫色：manual

### 8. Service Graph 自动选择 branch 可能选错

**严重度：P0**

**场景**

点击一个 service node，而该 repo 同时存在多个 live branch 或 snapshots。

**说明**

自动选择第一条 live branch 不一定等于：

- 当前 Git branch
- canonical master
- 当前搜索 scope
- 当前 incident 部署的 revision

**建议**

- 不允许静默 branch fallback。
- 点击 service node 时要求选择 branch/revision。
- Graph 顶部持续显示当前 revision。
- 跨图切换时保留原 search scope。

### 9. Context Pack 会静默截断高连接 symbol

**严重度：P1**

**场景**

查看 `PlayerService`、`AppModule` 或大型 shared module。

**说明**

Wiki 为了 UI 性能可能只显示部分 callers、callees、tests、imports、files 或 graph nodes。

如果没有显示总数，用户会误以为列表已经完整。

**建议**

- 显示 `14 of 237`。
- 提供 Load more / Export all。
- Copy for AI 显示 omitted count 和 truncation warning。
- 不允许静默截断。

### 10. `affected` 是候选影响面，不是部署影响事实

**严重度：P1**

**场景**

通过 `penguin affected` 判断一个改动会影响哪些 routes/tests/services。

**说明**

如果结果没有解释每个 impacted item 的完整 dependency path，就无法判断它是：

- runtime dependency
- compile-time dependency
- type-only dependency
- test-only dependency
- inferred dependency

**建议**

- 每个 impacted item 输出完整 path。
- 标记 edge provenance。
- 将 `affected` 用作 review/test checklist，不作为最终部署影响结论。

### 11. Penguin 无法单独回答运行时状态

**严重度：P0**

**场景**

用户询问：

- Redis key/value/TTL
- MongoDB 当前数据
- QAT/生产返回值
- Vault 当前配置
- 当前部署 package version
- Pulsar/Temporal 状态
- 外部 vendor response
- 实际激活的 SPI provider

**说明**

Penguin 主要知道已索引源码与已保存 evidence，不天然知道当前环境状态。

**建议**

- Penguin：找代码入口和候选流程。
- Source：确认静态实现。
- SLS：确认实际运行路径。
- DB/Redis：确认当前状态。
- Deployment/package：确认实际版本。

Incident 不应只凭 Wiki Graph 给出 root cause。

### 12. Search hit 与 Context Pack 可能解析成不同目标

**严重度：P1**

**场景**

用户从精确 search hit 打开 Context Pack。

**说明**

Search hit 可能包含 repo、branch、revision、file、line，但 Context 查询如果退化成只传 file path，可能在其他 repo/branch 找到同路径文件。

**建议**

Context 查询应保留完整 locator：

- repo ID
- branch ID
- revision ID
- snapshot ID
- file path
- line
- node ID

### 13. Snapshot、node ID 与导出 Graph 可能过期

**严重度：P1**

**场景**

保存 node ID、导出 Canvas，然后重新索引、rename 或切换 branch。

**说明**

如果导出内容只保存 node ID，没有 revision locator，重新索引后可能无法确认原来的 node 含义。

**建议**

导出时保存：

- repo ID/root path
- branch ID/name
- revision kind
- commit SHA
- snapshot ID
- file path
- qualified name
- node ID
- content hash

### 14. 同名 repo、多个 worktree 与重复注册造成歧义

**严重度：P1**

**场景**

同一项目有主目录、多个 worktree、旧注册记录或同名 repo。

**说明**

只使用 repo name 可能无法唯一定位实际 root path。

**建议**

- UI 显示 repo name + root path。
- ambiguity 时拒绝自动选择。
- 重要查询支持 repo ID。
- Doctor 检查重复注册和失效 worktree。

### 15. SQLite/schema/runtime 兼容性可导致全部查询失效

**严重度：P1**

**场景**

- CLI 支持的 schema 比 DB 旧
- DB path 只读
- DB 被锁
- sandbox 禁止写入
- MCP 与 Desktop bundled runtime 版本不同

**说明**

这种问题不是单个 query 失败，而是所有 search/context/status/doctor 在知识检索前一起失败。

**建议**

- CLI 启动时做 schema compatibility preflight。
- read-only 查询不应要求 write lock 或 migration。
- 明确显示 DB schema 和 CLI supported schema。
- MCP、CLI、Desktop App 共享 runtime version manifest。

### 16. Wiki 的 `Connected` 状态容易制造错误安全感

**严重度：P1**

**场景**

Wiki 底部显示 `Connected · SQLite`。

**说明**

它只代表数据库可以连接，不代表：

- 当前 branch 已索引
- working tree 与 index 一致
- graph 没有 inferred edges
- query scope 正确
- runtime evidence 已验证

**建议**

显示多个独立状态：

```text
DB: Connected
Revision: Mismatch
Index: Stale
Coverage: 1948/1949 files
Runtime evidence: None
```

### 17. Generated code、barrel exports 和 god nodes 制造噪音

**严重度：P1**

**场景**

大型 monorepo 包含 generated gRPC/protobuf、barrel exports、shared constants、test setup 和 giant modules。

**说明**

这些节点连接度很高，在 Graph 中看起来最重要，但业务上未必重要。

**建议**

- generated/test/type-only edges 默认降权。
- Graph 支持隐藏 generated、tests、type-only。
- 社区计算不要把 import/type edge 与 runtime call edge 等权处理。

### 18. Evidence、notes 与 WHY cards 可能过期

**严重度：P1**

**场景**

旧 evidence 被标记为 verified，但代码、branch 或环境配置后来已经改变。

**说明**

`verified` 是人工状态，不代表永久有效。

**建议**

Evidence 绑定：

- environment
- repo/branch/commit
- observed time
- valid until
- source trace/query
- owner
- verification status

过期后自动降级成 historical。

### 19. Wiki UI、测试、CLI 与索引版本可能漂移

**严重度：P1**

**场景**

Wiki source 已增加功能，但测试、bundled CLI 或 knowledge index 仍来自旧版本。

**说明**

用户看到的 UI、CLI 实际能力和已索引数据可能不是同一版本。

**建议**

CI 验证：

- UI source tests
- CLI capability manifest
- Desktop bundled CLI version
- parser version
- schema compatibility
- Wiki contract

About 页面显示全部版本信息。

### 20. 安全与隐私风险

**严重度：P0**

**场景**

Penguin 索引 source snippets、内部路径、API routes、notes、incident evidence、runtime response samples 或 SLS evidence。

**说明**

即使没有直接保存 secret，也可能暴露：

- 内部架构
- security flow
- player PII
- CPF/phone/email
- private endpoints
- vendor response
- DB schema

Copy for AI 和 Graph export 会进一步扩大数据流出风险。

**建议**

- 默认排除 env/vault/credentials/raw PII。
- Copy for AI 前执行 secret/PII scan。
- Evidence 支持 field-level redaction。
- BYOK provider 明确数据发送目标。
- Export 文件标记 classification。

## 推荐使用流程

### 1. Preflight

```bash
rtk git branch --show-current
rtk git status --short
rtk proxy penguin status --json
rtk proxy penguin coverage --repo <exact-repo-name> --json
```

### 2. 精确查询

```bash
rtk proxy penguin context <symbol> \
  --repo <repo> \
  --branch <branch>
```

### 3. 验证规则

- 多 candidate 时选择 declaration，不自动选 field/mock。
- Flow 遇到 DI/SPI/callback/event boundary 时继续验证 provider registration。
- `affected` 只作为 review/test checklist。
- Graph edge 没有 provenance/evidence 时只视为候选关系。
- Incident 必须用 SLS、DB、Redis 和部署版本确认运行时事实。
- Penguin 无法回答时明确报告 `Penguin insufficient for this question`。

## 建议优先级

### P0

1. 所有结果强制绑定并显示 repo/branch/revision。
2. Graph 显示 edge provenance、confidence 与 evidence。
3. 动态 DI/SPI 边界显示 possible providers 和 runtime selection rule。
4. Current Git branch 未索引时禁止静默 fallback。
5. Copy for AI 和 evidence export 增加 PII/secret protection。

### P1

1. Symbol disambiguation UI。
2. Search timeout/progress。
3. Context/Graph 列表显示 truncation 和 total count。
4. Coverage 拆分 file、symbol、edge、route、DI 和 runtime coverage。
5. Repo/worktree duplicate doctor。
6. Evidence expiry 与 revision binding。

### P2

1. 改善 Graph layout 与 generated/test filtering。
2. 增加 About/version compatibility 页面。
3. 统一 Wiki、CLI、MCP 和 Desktop 的 capability contract。

## 综合评分

| 能力 | 评分 | 说明 |
|---|---:|---|
| 代码导航 | 8/10 | 快速定位入口很有效 |
| 建立整体结构认知 | 8/10 | Repo、symbol、graph 对初步理解有帮助 |
| 精确 caller/flow | 5/10 | 动态 DI、callback、SPI 容易断链 |
| NestJS runtime provider 分析 | 3/10 | 静态图无法完全确认运行时实现 |
| 运行时 incident 分析 | 2/10 | 必须结合 SLS、DB、Redis 和部署版本 |
| 单独作为 code review truth source | 4/10 | 存在 branch、freshness、edge provenance 风险 |
| 配合 source、tests、SLS 使用 | 9/10 | 作为第一层导航和候选关系工具非常有价值 |
