# Penguin Wiki / Knowledge Evaluation Brief — Fresh Round 17

> **Created:** 2026-08-30  
> **用途：** 给一个完全新的 Claude Code、Codex 或其他 MCP 客户端 session，独立复测 Penguin Wiki/Knowledge 是否已经成为可靠、强大、诚实的工程知识层。  
> **性质：** 只读评估题包，不是答案，不是发布验收，也不是源码修复任务。  
> **本轮重点：** fresh session、稳定 runtime、CLI/MCP 同代、动态 ID round-trip、分页与 cursor、证据边界、负面结论、错误恢复、跨 agent handoff，以及 API 文档/知识层的实际可用性。

## 0. 给测试 agent 的硬性规则

请把本文件完整交给一个全新的 session 执行。测试 agent 不得读取旧对话、旧评估报告、源码、数据库、git、浏览器结果或人工答案键。不得把旧报告中的 node ID、endpoint ID、cursor、revision、路径或结论复制到本轮。

本轮只允许使用：

- Penguin GUI 暴露的 Wiki/Knowledge 能力；
- Penguin 稳定 CLI；
- Penguin MCP server 及其 `tools/list`、`mcp_health`、`knowledge_*` 工具；
- 测试过程中 Penguin 自己返回的帮助、能力、状态、结果和错误。

禁止执行：

- 读取或 grep/搜索源码、数据库、配置、旧报告、答案键；
- `git status`、`git log`、`git diff` 或其他会把仓库状态混入评估的命令；
- `penguin index`、`rebuild`、`watch`、注册/移除 repository、写 note、写 memory、写 link、写 API doc、修改 ontology、接受 suggestion；
- Tauri build、安装、签名、发布、删除文件或任何破坏性操作；
- 因为结果看起来不完整，就自行补全、推测或声称“应该如此”。

如果某个能力不可用，不要绕过限制假装通过。记录：`unavailable`、确切错误、退出码/协议状态、影响的题目、允许的 fallback，以及仍然无法证明的结论。

## 1. 全新 session 初始化

测试开始前，先完整退出旧的 Claude/Codex/MCP 进程，再启动全新的 session。若客户端不能确认已退出，必须标记“fresh-session 未证明”，不能把本轮结果当作完整通过。

默认测试仓库：

```text
repo name: FPMS-NT
repo path: /Users/shieng/Desktop/Projects/fpmsnt
expected branch: brazil-v2（以 Penguin 当前返回为准，不要猜）
```

如稳定 CLI 不在 PATH，只能使用 Penguin GUI 显示或当前环境实际提供的稳定 launcher/runtime，并记录完整路径。不要自行构造旧版 fallback 路径。

初始化时记录：

| 项目 | 必须记录 |
| --- | --- |
| session | 客户端、模型、时区、开始时间、是否真正新 session |
| MCP | server 名称、initialize 状态、`tools/list` 数量、工具名重复数、协议错误 |
| CLI | launcher 路径、runtime 路径、版本、build ID、capability hash |
| contract | schema 版本、能力数量、CLI/MCP 工具映射、缺失项 |
| repository | repo ID/name、branch、indexed commit、snapshot/revision、freshness |
| quality | coverage、excluded/failed/stale files、unresolved references、warnings |
| execution | 每个命令/工具、状态、耗时、退出码、原始 JSON 保存位置 |

首先从 Penguin 自己的帮助中确认精确命令名；若 snake_case、kebab-case 或参数名称不同，以当前帮助为准，并在报告中写出实际调用：

```text
help --json
capabilities --json
status --json
doctor --json
coverage --repo FPMS-NT --json
onboarding FPMS-NT
```

MCP 可用时，还必须执行：

```text
initialize
tools/list
mcp_health
knowledge_capabilities
knowledge_index_status（如已暴露）
```

## 2. 证据和判定规则

每一道题都必须记录以下字段；缺失字段要明确写 `not returned`，不能静默补齐：

```text
question:
surface: CLI | MCP | GUI
exact command/tool:
raw evidence:
repo scope:
branch/snapshot/revision:
freshness:
coverage:
completeness / totalIsExact:
candidateCount / returnedCount:
cursor / hasMore / truncation:
node IDs and how they were emitted:
status / error code:
workaround count:
conclusion: PASS | PARTIAL | FAIL | N/A
confidence: high | medium | low
```

以下规则贯穿全部题目：

1. `node:<id>`、`symbol:<id>`、endpoint ID 和 cursor 只能使用本轮当前 session 刚刚返回的值。
2. 全局搜索结果不能证明 FPMS-NT 的事实；仓库结论必须带 `--repo FPMS-NT` 或 MCP 等价 scope。
3. 空数组、`no_match`、`not_found`、`not_indexed`、dead-code candidate、推断边、未解析引用、外部调用和不完整 coverage 都不能直接证明“没有”。
4. 只有明确的完整性、范围、revision 和 evidence state 支持时，才可以写“已证明”；否则必须写 `not proven`。
5. `totalIsExact:false`、截断、cursor 未耗尽、stale revision、excluded file、动态 dispatch、DI/reflection 或 unresolved reference 都要降低完整性结论。
6. “MCP Ready”“Configuration Present”“app 已安装”只证明局部环境状态，不证明已经运行中的 Claude/Codex 进程加载了新 MCP。
7. 产品能力分数和环境准备度分开计算。MCP 环境不可用不能自动等同于产品功能缺失。
8. 所有负面结论都必须同时列出 coverage、completeness、unresolved/dynamic caveat 和需要什么额外证据。

## 3. 本轮新问题（Q1–Q20）

### Q1 — 全新 session 的第一步是否安全

从空白 prompt 开始，只依据 `help`、`capabilities`、`status`、`doctor` 和 `onboarding`，回答：

> 如果我要调查 FPMS-NT 的一个 gRPC 请求，第一条最安全的 Penguin 命令是什么？哪些结论现在不能做？

必须说明：仓库 scope、freshness gate、coverage gate、动态 ID 使用方式、MCP 不可用时的 fallback，以及为何不能直接从 global search 或空数组得出负面结论。

通过条件：新 agent 不需要旧报告，就能选择正确的第一步；所有命令能从当前 contract 找到；不可证明项被标为 `not proven`。

### Q2 — CLI 与 MCP 是否来自同一代 runtime

在一个新的 CLI 进程和一个新的 MCP session 中，分别获取：版本、build ID、capability hash、schema、能力数量、server generation、runtime/launcher 状态。

比较：

- CLI capability manifest 与 MCP `knowledge_capabilities`；
- `tools/list` 与 capability manifest 的映射；
- 是否存在 CLI 有而 MCP 没有、MCP 有而 CLI 没有、重复或旧 alias；
- 两边的 schema、revision、错误 envelope 是否一致。

通过条件：差异逐项列出，不能只写“hash 一样所以通过”。如果某个 generation/path 不暴露，必须写 `not proven`。

### Q3 — 小结果 envelope 是否足够行动

使用 `search`、`status`、`coverage`、`files` 或等价工具，分别请求 compact/small 输出（如果当前 contract 支持）。比较 compact 与 full 输出是否保留：

- scope、revision、freshness、coverage；
- candidate/returned/total exactness；
- node ID、path、line、kind；
- cursor/truncation；
- 下一步可复制的 command/tool。

记录 compact 输出大小或字段数量，以及为了获得行动所需证据是否被错误省略。compact 可以少字段，但不能删除 honesty gate。

### Q4 — 全局搜索到仓库内精确定位

对以下高碰撞词逐个执行两阶段搜索：

```text
constructor
execute
update
```

步骤：

1. global search，记录 scope warning 和候选数量；
2. `--repo FPMS-NT` 或 MCP 等价 scope；
3. 从当前结果中选一个 path-qualified candidate；
4. 用本轮返回的 ID 执行 `context`、`callers`、`flow`；
5. 检查每个 follow-up 是否仍保留 FPMS-NT scope 和 revision。

通过条件：候选不会跨仓库串线；global 结果不会被当作 FPMS-NT 结论；ID follow-up 不要求 agent 重新猜 symbol。

### Q5 — source pack 是否能准备代码 review

从当前 session 的结果中选择一个真实 path-qualified symbol，例如：

```text
apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts#getActiveEventConfigByObjId
```

如果该 target 不存在，不要猜替代路径；使用当前 search 返回的另一个真实 target，并记录替代原因。执行 `filesymbols`、`context`、`explore`，只允许请求 Penguin 自己返回的 source pack，不得打开源码文件。

判断 source pack 是否同时包含：focus node、locator、kind/signature、callers、callees、tests、routes/endpoints、external calls、unresolved edges、source omission reason、revision、freshness、evidence state 和 next commands。

结论必须回答：

> 这个 pack 能否让我列出“应该审查哪些源码位置”？能否让我确认业务语义正确？

预期：前者可能可以，后者通常需要 source review；不能把 source pack 当作完整语义证明。

### Q6 — 动态 ID round-trip 完整矩阵

当前 session 至少获取：

- 一个 `filesymbols` 返回的 symbol ID；
- 一个 `search` 返回的 symbol ID；
- 一个 ambiguous result 中的 candidate ID；
- 一个 `endpoints` 返回的 endpoint ID。

对每个适用 ID 执行：

```text
context node:<id>
flow node:<id>
callers node:<id>
callees node:<id>
affected node:<id>
```

制作矩阵：`emitted ID → accepted follow-ups → response → scope → revision → evidence state`。任何 follow-up 被误当成 filename、未知命令、旧 session ID 或静默换 scope，均为失败。

### Q7 — endpoint page-two 不是装饰

用 `endpoints FPMS-NT` 请求很小的 page size（优先 `limit=3`）。必须完成 page 1 → page 2 → page 3（如果有），并且只选择 page 2 的 endpoint 继续测试。

记录：排序字段、endpoint ID、canonical identity、handler ID、parent/root、candidateCount、returnedCount、`totalIsExact`、cursor、hasMore、重复数、耗时。

通过条件：page 2 结果不是重复 page 1；cursor 可被新进程继续；page exhausted 有明确状态；不能通过标题人工重建 endpoint ID。

### Q8 — endpoint 五种身份形式

对 Q7 的 page-two endpoint，比较当前系统实际支持的以下形式：

1. inventory rendered title；
2. canonical `grpc::Service.method`；
3. `node:<id>`；
4. slash route `/Service/Method`；
5. 故意错误的 service/method。

使用 `endpoint-identity`、`context`、`flow` 或帮助中对应工具。记录哪些形式解析到同一 node，哪些被拒绝，错误是否结构化，是否给出安全 retry。

不能手工从源码猜 canonical identity；当前 contract 不支持的形式必须标 `N/A: unsupported`，不当作产品 bug。

### Q9 — endpoint → handler → service → data 的证据前沿

对 Q7 endpoint 尝试以下链路：

```text
endpoint → handler → service/use-case → repository/data candidate → tests
```

每一跳记录 edge type、origin/method、confidence、locator、确认/推断/外部/未解析状态。明确写出第一处 evidence frontier。

通过条件：

- flow 是下界时明确写下界；
- repository-like 名称不被自动当成真实 data reachability；
- missing handler、missing test、unresolved edge 被区分；
- 不能证明的部分写 `not proven`。

### Q10 — impact/affected 是否会误导改动

选择一个本轮返回、至少有三个 impact candidate 或 caller 的 symbol。生成只读 change-preparation packet：

- target locator 和 revision；
- direct callers/callees；
- affected files/nodes/tests；
- routes/endpoints；
- external/unresolved edges；
- truncation/coverage 限制；
- 必须人工检查的源码清单；
- `GO` 或 `NO-GO`。

`GO` 只有在 revision 对齐、结果完整且关键边界已证明时才可用。否则 `NO-GO` 是正确答案，不得为了分数强行 GO。

### Q11 — 四种负面结论压力测试

对一个 symbol 和一个 endpoint 分别评估：

1. 没有 callers；
2. 没有 handler；
3. symbol 未使用；
4. request 永远到不了 data boundary。

对每个结论都必须检查 coverage、freshness、`totalIsExact`、unresolved references、DI/reflection、dynamic dispatch、external calls 和 pagination。

输出三态结论：`proven`、`not proven`、`contradicted`。若系统只返回空数组而没有完整性说明，记录为 honesty/completeness failure。

### Q12 — stale/revision 证据是否透明

只用 Penguin 的 `status`、`files`、`filesymbols`、`context` 和 `explore` 比较 live branch、indexed commit、snapshot/revision、freshness、excluded/stale files、parser/schema/resolver version。

如果当前仓库对齐且没有 stale case，不能制造 dirty state；要记录“stale case 本轮未能安全制造”，并说明未来需要的安全测试。若已有 stale target，则证明它不能静默作为 fresh positive fact。

### Q13 — provenance 在不同表面是否保持

各找一条：

- confirmed parser edge；
- inferred edge；
- external call；
- unresolved reference；
- agent suggestion/candidate。

把同一 target 在 `context`、`explore`、`flow`、`callers/callees` 中交叉比较。检查 status、origin、method、confidence、locator、revision、unresolved reason 是否被保留，是否在某个表面被错误提升为 confirmed。

### Q14 — 三种分页 surface 的新进程续页

分别测试：

```text
endpoints
filesymbols
deadcode
```

对每个 surface：

1. page 1 使用小 limit；
2. 只保存 page 1 原始 JSON；
3. 使用新进程执行 page 2；
4. 测试 exhausted cursor、malformed cursor、wrong repository cursor；
5. 检查排序、重复、exactness、错误码、retry guidance。

通过条件：续页不依赖隐藏内存；cursor scope 错误会被拒绝；malformed cursor 不会被当成空结果；不能只用 `offset` 猜下一页。

### Q15 — structured error 是否能指导下一步

只读地触发以下错误：

- 缺少 required target；
- unknown repository；
- ambiguous symbol；
- invalid node ID；
- malformed cursor；
- wrong-scope cursor；
- invalid endpoint identity；
- empty query 或非法参数。

每个错误都记录人类输出、JSON envelope、状态/退出码、error code、是否可重试、直接 remediation command，以及错误属于 invalid/absent/stale/ambiguous/unavailable 哪一类。

通过条件：agent 能根据错误直接调整下一次调用；`no_match` 不能掩盖 invalid、ambiguous 或 stale；失败不应泄漏到另一个 repository。

### Q16 — onboarding 是否真的帮助第一天工作

只用 `onboarding`、`status`、`coverage`、`help/capabilities`，写一份给新工程师的 FPMS-NT gRPC 调查备忘录，必须包含：

- 第一条命令；
- repository scope；
- freshness/coverage gate；
- endpoint discovery；
- page-two 选择；
- dynamic ID handoff；
- context/flow/affected 边界；
- negative claim 规则；
- MCP unavailable fallback；
- 什么时候必须读源码。

逐条执行备忘录中的命令，检查是否可复制、参数是否当前有效、输出字段是否仍然存在。

### Q17 — API doc 只读调查链

如果 capability 中暴露 API doc：


1. 使用 `api_doc list` 或 MCP 等价工具列出现有文档/preview；
2. 只选择当前结果返回的 ID；
3. 用 `api_doc show` 查看 JSON 和可读格式；
4. 只有列表明确存在两个可比较版本时才执行 `api_doc diff`；
5. 比较 API identity、request/response、source locator、revision、generated/stale 状态。

不要执行 generate、bind、sync、repair、export 或任何 write。若没有文档，判定应是 `not available/not proven`，不能伪造 API doc 质量。

### Q18 — Wiki/Knowledge 非代码内容的边界

只读地检查当前 contract 是否有 `note list`、`memory recall`、`tag list`、`link list`、`evidence note list` 或同等能力。对已有内容执行读取和搜索，观察：

- note/memory 是否区分来源、时间、scope、revision；
- 代码证据与人工知识是否分层；
- sensitive/redaction 或权限状态是否返回；
- stale note 是否会被表现成当前事实；
- 是否有可追溯的 backlink/tag/evidence target。

不要创建、更新、删除任何内容。回答 Penguin 的 Wiki 能力目前是“可查阅知识层”“可证明代码事实”还是两者混合；混合部分必须列出风险。

### Q19 — Agent A → Agent B 跨 session handoff

Agent A 只用 Penguin 完成：onboarding、repository 选择、page-two endpoint、一个 symbol、一个 flow、一个 negative result、一个 invalid-cursor error。

Agent A 生成 handoff，只允许包含：

- repo/scope/revision；
- 本轮刚发出的 endpoint ID、symbol ID、cursor；
- 原始结果摘要和证据状态；
- Agent B 的精确下一步 command/tool。

完全退出 Agent A，启动新的 Agent B，只给它 handoff，不给旧报告或旧对话。Agent B 必须重放：context、flow、一个 cursor continuation、一个 negative query、一个错误恢复。

通过条件：ID、scope、revision、cursor、术语和 remediation 在 session 边界后仍可用；若 ID 只在旧进程内有效，必须明确失败，不可人工换成标题后算通过。

### Q20 — “已安装”与“已加载”分离证明

在两个新的 MCP session 和一个新的 CLI 进程中重复：

```text
initialize
mcp_health
tools/list
knowledge_capabilities
knowledge_search（使用本轮新返回 query/result）
```

逐字段比较：server version、build ID、capability hash、schema、server/available generation、runtime health、tool count、duplicate tool count、node IDs、revision、error shape、restart guidance。

结论必须分别回答：

1. 新 app/runtime 是否可见；
2. stable launcher 是否可见；
3. 新 MCP session 是否加载同一 generation；
4. 已运行的旧 MCP 进程是否真的 reload；
5. CLI 与 MCP 是否返回同一知识 revision。

没有 process/generation/reload 证据时，后两项必须写 `not proven`。不能用“Configuration Present”“MCP Ready”或 app version 单独证明。

## 4. 端到端工作流（B1–B8）

### B1 — 冷启动 gRPC 调查

全新 session 从 onboarding 开始，发现 FPMS-NT，选 page-two endpoint，携带 endpoint ID 到 context/flow，生成 bounded request-trace memo。memo 必须写 evidence frontier、coverage、unresolved/dynamic caveat 和 source-review boundary。

### B2 — 安全改动准备

从当前 session 选 symbol，执行影响面分析，跟进至少两个新发出的 caller/callee ID，检查 tests/routes，最后给 `GO` 或 `NO-GO`。不完整 coverage、stale revision、未解析关键边界时必须 NO-GO。

### B3 — 负面审计

对 symbol 和 endpoint 执行 Q11 四种负面问题，生成表格：`claim / query / evidence / completeness / proven-or-not-proven / missing evidence`。

### B4 — 分页工作队列

分别把 endpoints、filesymbols、deadcode 的 page 1 交给新进程续页；Agent B 只能拿到 page 1 JSON 和 cursor，必须完成 page 2、错误 cursor 和 exhausted cursor 记录。

### B5 — CLI/MCP 降级报告

执行同一目标的 `search → filesymbols → context → flow → endpoint → invalid cursor`。分别打分：产品能力、环境准备度、CLI/MCP parity。MCP 不可用时要提供证据和可用 fallback，不得把环境故障混成产品故障。

### B6 — API doc 与知识层只读浏览

列出现有 API docs、notes、memories、tags、links/evidence（以当前暴露能力为准），只读取一个真实对象，验证来源、revision、stale 状态、backlink 和权限/敏感信息边界。不能写入。

### B7 — 两代 runtime 连续性

在 Agent A 记录 build ID、capability hash、server generation、一个 symbol ID、一个 endpoint ID 和一个错误 envelope；Agent B 新 session 重放这些动作。分别判断“launcher 指向当前 runtime”“MCP 加载当前 generation”“evidence 与 revision 对齐”。

### B8 — 新 session 最终 decision packet

最终只输出一页：

```text
PRODUCT: GO | CONDITIONAL | NO-GO
ENVIRONMENT: READY | DEGRADED | NOT READY
SAFE WITHOUT SOURCE:
REQUIRES SOURCE/HUMAN:
UNPROVEN CLAIMS:
TOP 5 FIXES:
RETEST COMMANDS:
```

每个结论后必须有当前 session 的证据引用。不得引用旧报告、旧 node ID 或未执行的推测。

## 5. 评分规则（总分 100）

请同时给产品分和环境分，不要用一个分数掩盖 MCP 或 runtime 问题。

### 产品能力 90 分

| 维度 | 分值 | 重点 |
| --- | ---: | --- |
| Agent discoverability | 10 | 新 session 能否知道第一步和可用能力 |
| Context usefulness | 12 | symbol/endpoint context 是否可直接行动 |
| Search precision | 8 | scope、collision、path-qualified lookup |
| Graph usefulness | 10 | callers/callees/flow/affected 的证据质量 |
| Endpoint investigation | 8 | inventory、page-two、identity、handler |
| Pagination/continuity | 10 | cursor、跨进程续页、稳定排序 |
| Accuracy | 10 | ID、locator、revision、scope 是否正确 |
| Completeness | 8 | coverage、truncation、unresolved、dynamic boundary |
| Honesty | 8 | negative claim、inference、not proven、stale 标签 |
| Recovery/usability | 6 | structured error、retry、copyable remediation |
| Wiki/API knowledge | 5 | API docs、notes、memory、evidence 的边界与可追溯性 |
| Speed | 5 | 首次可行动时间和单步响应时间 |

### 环境准备度 10 分

| 维度 | 分值 | 重点 |
| --- | ---: | --- |
| Stable launcher/runtime | 3 | CLI/MCP 是否指向当前稳定代 |
| MCP availability | 2 | initialize、tools/list、health 是否可用 |
| CLI/MCP parity | 2 | manifest、schema、hash、错误形状是否一致 |
| Fresh-session reload proof | 2 | 新 session 是否真正加载新 generation |
| Release evidence | 1 | 只记录当前能证明的安装/签名/版本事实 |

若 MCP 不可用：产品分仍按 CLI 可证明能力评估；环境 MCP 分应扣分，并在报告中写明不能把二者混为同一故障。

建议把 `95–100` 定义为：所有高风险场景通过，只有低影响 usability/speed 缺口；`85–94` 定义为可内部使用但仍有明确限制；低于 85 或存在动态 ID 串线、错误 scope、虚假负面结论、不可解释的 stale promotion 时，不得称为高信任知识层。

## 6. 测试报告格式

测试者必须创建新文件，不得覆盖本 brief 或旧报告：

```text
docs/quality/index-evaluation-<model>-round17.md
```

报告必须按以下顺序：

1. Fresh-session、客户端、runtime、MCP/CLI 初始化证据；
2. 产品能力分 /100 与环境准备度 /100；
3. Q1–Q20，逐题给 exact command/tool、原始证据、scope、revision、freshness、coverage、completeness、counts、cursor/truncation、error、workaround、结论；
4. B1–B8 的完整过程和 handoff 证据；
5. 不读源码即可可靠完成的操作；
6. 必须读源码、数据库或人工确认的操作；
7. misleading、ambiguous、failed、unavailable、non-actionable 输出；
8. 产品缺陷 versus 评估环境缺陷；
9. 按影响/成本/可验证 acceptance criterion 排序的修复建议；
10. 最终 `PRODUCT`、`ENVIRONMENT` 和 Claude/Codex 内部使用建议。

报告中至少提供一张如下证据表：

| ID/target | 由哪条结果发出 | follow-up | scope/revision | completeness | evidence state | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| fresh value | command/tool | exact next call | exact values | exact/unknown | confirmed/inferred/etc. | PASS/PARTIAL/FAIL |

## 7. 完成门槛

只有同时满足以下条件，才可以说 Round 17 完成：

- Q1–Q20、B1–B8 全部执行，或逐项标注有证据的 `N/A`；
- 所有 follow-up ID 都由本轮 session 发出；
- endpoint page-two、五种 identity、endpoint→context→flow 都执行；
- endpoints、filesymbols、deadcode 三种 cursor 都测试正常、耗尽、错误和 wrong-scope；
- positive、negative、stale/revision、inferred、external、unresolved、ambiguous、unavailable 都有实例；
- MCP 可用时完成两个全新 session 的 parity/reload 对比；不可用时留下环境证据和 fallback；
- 每个负面结论都带 coverage/completeness，并在证据不足时写 `not proven`；
- API doc/Wiki/Knowledge 只读边界被测试，未产生任何写入；
- 没有读取源码、数据库、git、旧报告、浏览器或答案键；
- 没有 build、sign、reindex、reconfigure、删除或修改项目文件；
- 新报告使用 Round 17 文件名，未覆盖任何历史文件。

<!-- This is a fresh-session question packet. It is intentionally not an evaluation result. -->
