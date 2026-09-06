# Penguin Wiki / Knowledge 评估报告 — Round 17（Claude Opus 5）

> **执行时间：** 2026-08-30 21:05 — 21:35 (+08)
> **题包：** `docs/quality/index-evaluation-brief-round17.md`
> **性质：** 只读评估。未执行 index / rebuild / watch / 写 note / 写 memory / 写 link / 写 API doc / accept suggestion / build / sign / 删除。未读取本仓源码、数据库、git 命令、旧报告或答案键。

---

## 1. Fresh-session、客户端、runtime、MCP/CLI 初始化证据

| 项目 | 记录值 | 证据 |
| --- | --- | --- |
| 客户端 | Claude Code CLI（terminal），模型 Opus 5 (1M context) | — |
| 时区 / 开始时间 | `+08`，2026-08-30 21:05:54 | `date` |
| 是否真正新 session | **部分证明**。本对话为全新 session，首条用户输入即本题包；但 MCP server 进程由宿主在 session 启动时拉起，**无法从本进程证明旧 Claude/Codex/MCP 进程已完全退出**。按 §1 规则标记 `fresh-session 未完全证明`。 | — |
| CLI launcher | `/Users/shieng/.local/bin/penguin`（179 bytes，`which -a` 仅此一处；`/usr/local/bin`、`/opt/homebrew/bin` 无） | `which -a penguin` |
| CLI runtime 路径 | `not returned` — CLI 无 `--version`/`version` 子命令，help 与 `capabilities --json` 均不返回 runtime 可执行文件路径 | `penguin --version` → `unknown command: --version` |
| MCP runtime | `penguinRoot=/Users/shieng/.penguin`，`configPath=/Users/shieng/.penguin/config.json`，`nodeVersion=v22.23.1`，`platform=darwin` | `mcp_health` |
| buildId | **CLI = MCP = `1.16.0-e0284b7adffec06f`** | `penguin capabilities --json` / `knowledge_capabilities` |
| serverGeneration | `runningBuildId == availableBuildId`，`outdated=false`，`clientRestartRequired=false`，`initializeHealthy=true`，`launcherHealthy=null`，`configured=null` | `mcp_health` |
| contract / schema | `contractVersion=2`，`schemaVersion=14`，`capabilityHash=40ae9528330e4e97d68072d3c40c1be3db9e40f8f52478b44c8de026be4487d0`（三处一致：CLI manifest、MCP capabilities、MCP server instructions 块） | 同上 |
| 能力数量 | CLI 99 / MCP 99，`registrations` 全部 `implemented`，**逐项 ID 一致，无缺失、无重复、无旧 alias** | `capabilities --json` vs `knowledge_capabilities{compact:true}` |
| queryRuntime | `workers=2`，`hardTimeoutMs=15000` | `mcp_health` |
| repository | `FPMS-NT` / `repo_c58d58a2-bb7f-4696-bd45-2c0c29634c67` / `/Users/shieng/Desktop/Projects/fpmsnt`；branch `brazil-v2` = `branch_10012ad4-067a-4749-aafb-7a9c4f5c133d`；`indexedCommit == headCommit == 3f0f1984b9e4337668529a13bad5264501729908`；`worktreeState=clean`，`dirtyFiles=[]`，`trust.stale=false`，`staleReason=null`，`snapshotId=snapshot_804a4c86-b397-447a-9066-a51d36f2511a`，`indexedAt=2026-08-30T04:23:32.546Z`，`reusePercent=100` | `penguin status --json`，`index_status` |
| quality / coverage | FPMS-NT：`discovered=3340, admitted=3333, excluded=7, failed=0, stale=0`；`unresolvedReferences=10`（仅在 context/explore 的 evidence 中出现，`coverage` 子命令不返回该字段） | `penguin coverage --repo FPMS-NT --json`，`context` evidence |
| 全局 DB | `ledgerSeq=12348 == materializedSeq`，`status=ok`，`nodes=1006436`，`edges=4583623`，`pendingSuggestions=1` | `penguin doctor --json` |
| 26 仓库整体 | fresh 19 / stale 6 / unknown 1；`errors=31`（FPMS 30 + flyover 1） | `index_status{mode:compact}` |

**MCP 侧执行项：** `initialize`（宿主完成，`initializeHealthy=true`）、`tools/list`（宿主注入 deferred 工具清单，penguin 工具全部可用）、`mcp_health`、`knowledge_capabilities`、`index_status` 全部成功。

**执行记录（耗时）：** `capabilities` 65,146 B；`status --json` 47,447 B；`coverage --repo FPMS-NT --json` 70 B；`doctor --json` 157 B；`onboarding FPMS-NT` 2,811 ms / 2,636 B；`search --repo FPMS-NT` 2,647–3,474 ms；`explore node:<id>` 283 ms；`endpoints --limit 3` 217 ms。原始 JSON 保存于 `…/scratchpad/r17/`（session 级临时目录）。

---

## 2. 评分

### 产品能力 **59 / 90**（折算 65.6 / 100）

| 维度 | 分值 | 得分 | 理由 |
| --- | ---: | ---: | --- |
| Agent discoverability | 10 | 7 | `help` / `capabilities` / `onboarding` 自洽可复制；onboarding 缺 endpoint 发现、分页、MCP fallback |
| Context usefulness | 12 | 8 | symbol 的 `context`/`explore` 非常强；endpoint 的 `context` 全空（见 F3） |
| Search precision | 8 | 5 | scoped 搜索 envelope 一流；symbol lane 的 `field` hit `nodeId=null`；空 query 静默 |
| Graph usefulness | 10 | 5 | callers/callees/flow/impact 对 symbol 可用；**CLI `affected` 全线返回假零** |
| Endpoint investigation | 8 | 2 | **endpoint identity 分裂（双胞胎）+ `--repo` 近似无效 + `handlerStatus` 恒为 handled** |
| Pagination/continuity | 10 | 9 | 三个 surface 全部通过正常/耗尽/malformed/wrong-scope，跨进程续页成立 |
| Accuracy | 10 | 3 | **flow 跨仓库 revision 错标**；affected 假零；endpoints scope |
| Completeness | 8 | 6 | `lower_bound` + `coverageGaps` + `unresolvedReferences` + deadcode 免责说明都到位；但 affected 用 `totalIsExact:true` 断言空集 |
| Honesty | 8 | 5 | `proofStatus:not_proven`、`REVISION_BEHIND`/`WORKTREE_DRIFT` 很好；但 clean repo 被标 `freshness:stale`，空 API doc 被标 `coverage:exhaustive` |
| Recovery/usability | 6 | 4 | 错误码体系完整且可直接改写下一次调用；`unknown repo` 非 JSON、空 query 不报错 |
| Wiki/API knowledge | 5 | 1 | API doc 两份全空却标 exhaustive、`revisionIds=[]`；note/tag/snapshot/evidence 返回裸数组无任何 envelope；`snapshots` 返回 `[]` 与 status 自相矛盾 |
| Speed | 5 | 4 | explore 283 ms、endpoints 217 ms 很好；search 2.6–3.5 s 偏慢 |

### 环境准备度 **6.5 / 10**（折算 65 / 100）

| 维度 | 分值 | 得分 | 理由 |
| --- | ---: | ---: | --- |
| Stable launcher/runtime | 3 | 3 | launcher 唯一、`runningBuildId == availableBuildId`、`outdated=false` |
| MCP availability | 2 | 2 | initialize / tools / `mcp_health` / `knowledge_capabilities` 全部可用 |
| CLI/MCP parity | 2 | 0.5 | hash/schema/build/能力数完全一致，但 `affected` 两边结论相反、`endpoints` 的 handler `nodeId` CLI 缺失 |
| Fresh-session reload proof | 2 | 0 | **`not proven`** — 本客户端无法开第二个独立 MCP session |
| Release evidence | 1 | 1 | buildId / capabilityHash / schemaVersion 已记录 |

---

## 3. Q1–Q20

### Q1 — 全新 session 的第一步是否安全 — **PASS**（confidence: high）

- surface: CLI；exact: `penguin help`, `penguin capabilities --json`, `penguin status --json`, `penguin doctor --json`, `penguin coverage --repo FPMS-NT --json`, `penguin onboarding FPMS-NT`
- **最安全的第一条命令：`penguin status --json`**（或 `penguin onboarding FPMS-NT`）。理由：它同时给出 repo scope、branchId、indexedCommit vs headCommit、worktreeState、dirtyFiles、staleReason、snapshotId — 后续所有结论的门槛都在这里。
- 仓库 scope：必须 `--repo FPMS-NT`。**未加 scope 时的行为随 cwd 变化**：cwd 在已注册但 liveBranch=null 的仓库（`/Users/shieng`）下，`penguin search` 直接 `SCOPE_NOT_FOUND` 退出码 4；cwd 在 `/private/tmp` 下则退化为「搜 4 个仓库」的隐式全局搜索。
- freshness gate：`trust.stale`、`staleReason`、`indexedCommit == headCommit`、`dirtyFiles`。
- coverage gate：`discovered/admitted/excluded/failed/stale` + `unresolvedReferences`。
- 动态 ID：只能用本轮 `search`/`filesymbols`/`endpoints` 刚返回的 `nodeId`，以 `node:<id>` 传给 follow-up。
- MCP 不可用时 fallback：全部能力在 CLI 有同名子命令（99/99）。
- **现在不能做的结论：** 任何「没有 / 未被使用 / 到不了 data」的否定结论；任何跨仓库结论；任何来自 `endpoints <repo>` 的「这是 FPMS-NT 的接口」结论（见 Q7）。
- `not proven`：CLI runtime 可执行文件路径、MCP 进程 reload 证据。

### Q2 — CLI 与 MCP 是否来自同一代 runtime — **PARTIAL**（high）

| 字段 | CLI | MCP | 一致 |
| --- | --- | --- | --- |
| buildId | `1.16.0-e0284b7adffec06f` | `1.16.0-e0284b7adffec06f` | ✅ |
| capabilityHash | `40ae9528…87d0` | `40ae9528…87d0` | ✅ |
| schemaVersion / contractVersion | 14 / 2 | 14 / 2 | ✅ |
| capabilityCount | 99 | 99 | ✅ |
| registrations | 99 implemented | 99 implemented | ✅ |
| server generation | `not returned`（CLI 不暴露） | `runningBuildId`/`availableBuildId` | ❌ 单边 |
| runtime/launcher 路径 | `not returned` | `penguinRoot` / `configPath` | ❌ 单边 |
| 错误 envelope | `{error:{code,message,retryable,details},exitCode}` | MCP 工具错误未在本轮触发到同形状样本 | `not proven` |
| **结果 envelope** | `affected` 返回空集 | `affected` 返回 13–172 条 | ❌ **严重不一致，见 F1** |
| `endpoints` handler | `{title, repoId}` | `{nodeId, title, repoId}` | ❌ CLI 缺 `nodeId`，无法把 handler 交接下去 |

- 未发现「CLI 有 / MCP 没有」或反向的能力缺失，也没有重复或旧 alias。
- `knowledge_capabilities` 非 compact 输出 71,940 字符，**超过 MCP 单次返回上限被截断落盘**；必须 `compact:true` 才可用。

### Q3 — 小结果 envelope 是否足够行动 — **FAIL**（high）

当前 contract 没有统一的 compact 开关（`knowledge_search.options.compact`、`knowledge_capabilities.compact` 有；CLI 无）。实际观察到的是**两类完全不同等级的 envelope**：

| capability | scope | revision | freshness | coverage | completeness | proofStatus | counts | cursor | nextActions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `search` | ✅ | ✅(+trust) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `context`/`explore`/`flow`/`impact`/`affected` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `endpoints` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `filesymbols` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `deadcode` | ✅(`{repo,path,branch}`) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅(note) |
| `coverage` | ❌ | ❌ | ❌ | — | ❌ | ❌ | ✅ | — | ❌ |
| `note list` / `tags` / `snapshots` / `evidence list` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

- `endpoints` / `filesymbols` 的 keys 只有 `candidateCount, items, nextCursor, returnedCount, totalIsExact, truncated` — **honesty gate 被整体删除**，不是「compact 少字段」。
- `endpoints` 的 cursor payload 内含 `"revision":null`，说明 endpoint 结果根本不是 revision-scoped。
- `coverage --repo FPMS-NT --json` 只有 70 字节：`{"discovered":3340,"admitted":3333,"excluded":7,"failed":0,"stale":0}` — 没有 repo、branch、commit，无法证明这份 coverage 属于哪个 revision。
- 三个知识层命令返回**裸 JSON 数组**（`["redis-clusterallfailederror.md"]`、`[]`），无任何 scope/revision。

### Q4 — 全局搜索到仓库内精确定位 — **PARTIAL**（high）

| 词 | 阶段 | 结果 |
| --- | --- | --- |
| constructor / execute / update | global（cwd=`/Users/shieng`） | `SCOPE_NOT_FOUND`，exit 4，`remediation:"specify branch, commit, or snapshot"`，`candidates:[{branchName:"(workdir)"}]` |
| constructor | global（cwd=`/private/tmp`） | exit 0，`scope.searchedRepos` = 4 个仓库（FPMS-NT-Shared / FPMS-NT-CCMS / FPMS-CCMS / FPMS-NT），`revision:null`，`candidateCount=1674`，命中分布 FPMS-NT 40 / FPMS-CCMS 10 |
| constructor | `--repo FPMS-NT` | `candidateCount=1325`，`returnedCount=50`，`truncated=true`，每条 hit 带 `repoName`+`revisionId=snapshot_804a4c86…` |
| execute | `--repo FPMS-NT` | 同上，2,647 ms |
| update | `--repo FPMS-NT` | 同上，3,474 ms |

- **候选不跨仓库串线**：scoped 结果 100% 落在 `repo_c58d58a2`。✅
- **global 结果没有被当成 FPMS-NT 结论**：`revision:null` + `scope.searchedRepos` 列表已明确披露。✅
- **缺陷**：所谓 global 其实只覆盖 26 个已索引仓库中的 4 个，envelope **没有 `reposSkipped` 或警告**，一个 agent 会把它读成全库。
- ID follow-up：`hits[].nodeId` 存在 → `context node:<id>` 直接可用，不需要重新猜 symbol。✅ 但 `kind:"field"` 的 hit `nodeId=null`、`symbol=null`（见 Q6）。
- `SCOPE_NOT_FOUND` 的 remediation 说「pass --branch or --commit」，真正的解法是 `--repo` — remediation 有误导。

### Q5 — source pack 是否能准备代码 review — **PASS**（high）

target（本轮 `filesymbols` 发出）：`node_af26e1f8-17f5-473b-b76c-e33a150abfac` = `apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts#getActiveEventConfigByObjId` (135-156)。

`penguin explore node:<id> --repo FPMS-NT --json`，283 ms / 23,250 B，包含：

| 要求项 | 有无 | 值 |
| --- | --- | --- |
| focus node | ✅ | nodeId + title + nodeType + kind |
| locator | ✅ | filePath + startLine/endLine + `locator` 块（含 rootPath） |
| kind / signature | ✅ | `method` / `async getActiveEventConfigByObjId(` |
| 源码 | ✅ | 完整函数体逐字返回，`sources:5`，`sourcesOmitted:[]` |
| callers | ✅ | 3（verifyPlayerColorLand / playDice / buildContext，均带路径行号） |
| callees | ✅ | 1（getColorLandEventConfigByIdFromCache） |
| tests | ❌ | 0 |
| routes/endpoints | ❌ | `routes:[]`，但 `callPath` 里给出了根 endpoint `gRPC promotion.v1.FrontendColorLandService.RollColorLandDice` |
| external calls | ✅ | `externalCalls:[]`，`externalCallCount:0` |
| unresolved edges | ✅ | `queryDiagnostics.evidence.unresolvedReferenceCount=10`，`coverageGaps:["unresolved_references_present"]` |
| source omission reason | ✅ | `sourcesOmitted:[]` |
| revision / freshness | ✅ | commit 3f0f1984…，`freshness:fresh`，`branches:[{status:"fresh"}]` |
| evidence state | ✅ | `completeness.status=lower_bound` + 明确说明「constructor calls, interface dispatch, static-method calls and calls inside callback bodies are not modelled」 |
| next commands | ❌ | 无 `nextActions` |

**结论：**
- 「应该审查哪些源码位置」— **能**。5 个文件 + 精确行号 + 一条从 endpoint 到 cache 的 4 层 callPath，足以列出 review 清单。
- 「确认业务语义正确」— **不能**。`completeness=lower_bound` 明说 interface dispatch / callback 内调用未建模，`unresolvedReferences=10`，且 `tests=0` 与 `routes=[]` 都不是「不存在」的证明。必须读源码。

### Q6 — 动态 ID round-trip 完整矩阵 — **PARTIAL**（high）

| emitted ID | 由哪条结果发出 | accepted follow-ups | response | scope | revision | evidence state |
| --- | --- | --- | --- | --- | --- | --- |
| `node_af26e1f8-…` (symbol) | `filesymbols` | context ✅ / flow ✅ / callers ✅ / callees ✅ / impact ✅ / explore ✅ | callers 3、callees 1、flow 5 步、impact 9 | FPMS-NT 保持 | 3f0f1984… 保持 | lower_bound / not_proven |
| `node_7c2d4657-…` (symbol) | `search` hit `.nodeId` | context ✅ | focus=`constructor` kind=method，callers 0 | FPMS-NT | 保持 | not_proven |
| `node_28a441b6-…` (class) | `filesymbols` | context ✅ | focus=`ColorLandEventConfigService` | FPMS-NT | 保持 | not_proven |
| `node_58520468-…` 等 | `TARGET_AMBIGUOUS.details.candidates[]` | context ✅（带 identityKey） | 可直接重试 | FPMS-NT | 保持 | — |
| `node_ec762949-…` (endpoint) | `endpoints` page-2 | context ✅ / flow ✅ | **context 全空**；flow 2 步 | 声称 FPMS-NT | 保持 | not_proven |
| `node_3f34eb5d-…` (endpoint) | `ep-all` 全量 | context ✅ / flow ✅ | **context 全空**；flow 60 节点 | ❌ 见 F2 | ❌ 见 F2 | not_proven |
| **`nodeId:null`** | `search` 的 `kind:"field"` hit | — | — | — | — | ❌ **无法 round-trip** |

- 没有任何 follow-up 把 `node:<id>` 误当成 filename、未知命令或旧 session ID。✅
- **失败项 1**：`search` 的 symbol lane 中 `kind:"field"` 的 8 条 hit `nodeId=null`、`symbol=null`，title 还是被词切坏的 `"getActiveEventConfigByObjId get Active Event Config By Obj Id"`，且全部落在 `*.spec.ts`。这些 hit 无法交接。
- **失败项 2**：把 `node:null` 传给 `context` 会命中一个字面量名为 `null` 的 field 节点并返回 `TARGET_AMBIGUOUS`，而不是 `INVALID_NODE_ID` — 上一条的 null 会直接变成一次错误的 ambiguous 分支。
- **失败项 3**：endpoint ID 在 `context` 与 `flow` 之间结论相反（F3）。

### Q7 — endpoint page-two 不是装饰 — **PARTIAL**（high）

`penguin endpoints FPMS-NT --limit 3 --json`：

| 页 | returnedCount | candidateCount | totalIsExact | truncated | cursor | 首条 nodeId |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 3 | 1541 | false | true | 有 | `node_c84137ec-…` |
| 2 | 3 | 1538 | false | true | 有 | `node_ec762949-…` |
| 3 | 3 | 1535 | false | true | 有 | `node_d54ed2c1-…` |

**完整耗尽验证**（`--limit 200`，8 页）：1541 条全部取回，**unique nodeId = 1541，零重复**，末页 `truncated=false` 且不再发 cursor。排序键（cursor 内）`"orderingKey":"title,nodeId"`，稳定。

- page 2 ≠ page 1 ✅；cursor 可被**新进程**继续 ✅（每次 Bash 调用都是独立 CLI 进程）；耗尽状态明确 ✅；endpoint ID 由结果发出、无需从标题重建 ✅。
- `candidateCount` 语义是**剩余数**而非总数（1541→1341→…→141），与字段名和 `totalIsExact:false` 一起容易被读成「总数不精确」。
- ❌ envelope 无 scope/revision/freshness/coverage；cursor 内 `"revision":null`。
- ❌ 见 F2/F4：这份 inventory 并不是 FPMS-NT 的。

选定 page-two endpoint：**`node_ec762949-fbcc-4387-aa8e-f1ba65f6d626`** = `AccumulativeEventConfigAdminService.GetAccumulativeEventConfigs`，`identityKey=grpc::AccumulativeEventConfigAdminService.getaccumulativeeventconfigs`，`handlerStatus=handled`，`handlers=[{title:"proto", repoId:repo_e3c88b3d(FPMS-NT-CCMS-Rust)}]`，parent/root `not returned`（inventory 无该字段）。

### Q8 — endpoint 五种身份形式 — **PASS**（high）

对 `node_ec762949-…` 用 `penguin context <form> --repo FPMS-NT --json`：

| # | 形式 | 结果 |
| --- | --- | --- |
| 1 | rendered title `AccumulativeEventConfigAdminService.GetAccumulativeEventConfigs` | ✅ 解析到 `node_ec762949-…`（3,833 B，与其它形式**逐字节相同**） |
| 2 | canonical `grpc::AccumulativeEventConfigAdminService.getaccumulativeeventconfigs` | ✅ 同一 node |
| 3 | `node:<id>` | ✅ 同一 node |
| 3b | 裸 `<id>`（无 `node:` 前缀） | ✅ 同一 node |
| 4 | slash route `/AccumulativeEventConfigAdminService/GetAccumulativeEventConfigs` | ✅ 同一 node |
| 5 | 故意错误 `AccumulativeEventConfigAdminService.GetNoSuchMethodXYZ` | ✅ `TARGET_NOT_FOUND`，exit 1，`retryable:false`，`remediation:"run penguin search to find a current target ID"` |

- 未从源码猜 canonical identity，`identityKey` 由 `endpoints` 结果发出。
- 结构化错误 ✅，安全 retry 指引 ✅。
- ⚠️ 但**五种形式全部解析到「裸名」双胞胎**，系统从不提示存在 `grpc::promotion.v1.…` 的限定名孪生节点，`ambiguous` 恒为 `null`（见 F4）。

### Q9 — endpoint → handler → service → data 的证据前沿 — **FAIL**（high）

对 Q7 endpoint `node_ec762949-…`：

| 跳 | edge type / via | origin/method | confidence | locator | 状态 |
| --- | --- | --- | --- | --- | --- |
| endpoint → handler | `handles` | 图边 | `not returned` | `filePath:null` | 指向 `node_0fb2fbd0` = `identityKey: grpc-module::repo_e3c88b3d::proto`，title `"proto"`，**nodeType=service，实为另一个仓库的 proto 模块目录节点** |
| handler → service | — | — | — | — | **evidence frontier — 无出边** |
| service → repository/data | — | — | — | — | 不可达 |
| tests | — | — | — | — | `relatedTests:[]` |

- `penguin flow node:<id>` 只有 2 步，`proofStatus:"not_proven"`。
- `penguin context node:<id>` 返回 **callers/calls/routes/tests/invokedBy/referencedBy 全部为 0**，`completeness.status=lower_bound`，`proofStatus=not_proven`。
- **第一处 evidence frontier：endpoint → handler 这一跳本身。** 该「handler」是一个名为 `proto` 的模块节点，不是任何真实 handler 实现；`handlerStatus:"handled"` 因此是**假阳性**。
- 对照：限定名孪生 `node_3f34eb5d-…`（`gRPC promotion.v1.FrontendColorLandService.RollColorLandDice`）的 `flow` 给出 **60 个节点、4 层深**的真实链路：endpoint →`handles`→ `rollColorLandDice`(color-land.controller.ts:103-127) →`calls`→ `playDice` →`calls`→ `getActiveEventConfigByObjId` →`calls`→ `getColorLandEventConfigByIdFromCache` / `hget` / `incrby` / `hincrby`（Redis 原语）。
- flow 是下界：`proofStatus:"not_proven"`、`completeness` 未在 flow 中返回（`not returned`）。
- repository-like 名称未被自动当作 data reachability ✅（`hget`/`incrby` 出现在 `calls` 边上，没有额外的 data 断言）。
- missing handler / missing test / unresolved edge **未被区分**：三者都表现为空数组。

### Q10 — impact/affected 是否会误导改动 — **FAIL**（high）

Change-preparation packet（target `node_af26e1f8-…`）：

- **target locator**：`apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts:135-156`
- **revision**：`brazil-v2` @ `3f0f1984b9e4337668529a13bad5264501729908`，`trust=exact_commit`，`worktreeState=clean`
- **direct callers**：3（color-land-auth.service.ts:30、dice.processor.ts:51、color-land-base-rule.service.ts:27）
- **direct callees**：1
- **impact（`penguin impact node:<id>`）**：`candidateCount=9`，`totalIsExact=true`，`completeness=lower_bound`，`coverageGaps=["unresolved_reference_counts_not_persisted"]`
- **importers**：21 个文件（context 返回）
- **affected（`penguin affected <file>`）**：`impacted=0, tests=0, routes=0, candidateCount=0, totalIsExact=true` ← **与 impact/importers 直接矛盾**
- **routes/endpoints**：`routes:[]`；但 callPath 显示其位于 `FrontendColorLandService.RollColorLandDice` 之下
- **external/unresolved**：`externalCalls=0`，`unresolvedReferences=10`
- **truncation/coverage 限制**：coverage 3333/3340 admitted，7 excluded
- **必须人工检查的源码清单**：上述 5 个文件 + 21 个 importer 中的非 spec 文件
- **判定：`NO-GO`**

理由：`affected` 与 `impact` 在同一 revision 上给出互斥答案，且 `affected` 用 `totalIsExact:true` 断言空集；`routes` 为空但 callPath 证明存在路由；`tests=0` 而 MCP 侧同一文件返回 9 个测试文件。关键边界未证明，不得 GO。

### Q11 — 四种负面结论压力测试 — **PARTIAL**（high）

| # | claim | query | evidence | completeness | 三态 | 缺什么 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | symbol `getActiveEventConfigByObjId` 没有 callers | `callers node:<id>` | callers=3 | lower_bound | **contradicted** | — |
| 1b | symbol `constructor`(node_7c2d4657) 没有 callers | `context node:<id>` | callers=0；同时它出现在 `deadcode` 候选中 | lower_bound；`deadcode.note` 明示 DI/reflection 假阳性 | **not proven** | 需要源码确认 NestJS `@Inject` 注入 |
| 2 | endpoint `node_ec762949` 没有 handler | `context` / `flow` | context 全空；flow 有 1 条 `handles` 边指向 proto 模块 | `proofStatus=not_proven` | **not proven**（且 `endpoints` 同时声称 `handled` — 两个 surface 冲突） | 需要限定名孪生节点、需要 handler 的真实 locator |
| 3 | symbol 未被使用 | `impact` + `deadcode` | impact=9；deadcode 全库 5647 候选 / 约 13710 fresh symbols ≈ 41% | `totalIsExact=true`（impact）；deadcode `totalIsExact=true` + 免责 note | **contradicted** | — |
| 4 | request 永远到不了 data boundary | `flow node:<endpoint>` | 裸名孪生：2 步即止；限定名孪生：可达 `hget`/`incrby`/`hincrby` | `proofStatus=not_proven` | **not proven** | flow 是下界；动态 dispatch/DI 未建模；两个孪生节点结论相反 |

- 空数组是否附带完整性说明：`context`/`flow`/`impact`/`explore` **有**（`completeness` + `proofStatus` + `coverageGaps`）；`endpoints`/`filesymbols`/`note list`/`tags`/`snapshots`/`evidence list` **没有** → 记为 honesty/completeness failure。
- **额外的 honesty failure**：`penguin filesymbols branch_deadbeef apps/x.ts --json` 对**不存在的 branch + 不存在的文件**返回 `exit 0` 和裸 `[]`。一个 agent 会读成「该文件没有符号」。

### Q12 — stale/revision 证据是否透明 — **PARTIAL**（high）

未制造 dirty state。本轮直接使用已存在的 stale 目标：

| repo | branch | trust.stale | staleReason | dirtyFiles | staleSymbols | indexed vs head |
| --- | --- | --- | --- | --- | --- | --- |
| FPMS-NT | brazil-v2 | false | null | 0 | **725** | 相同 |
| FPMS-NT-Proposal | jul-01-2318-master | true | `worktree_dirty` | 1 | 29 | 相同 |
| penguin-src | main | true | `worktree_dirty` | 64 | 956 | 相同（但 search 报告落后于 HEAD） |

**stale 目标不会被静默当成 fresh — 证明成立：** `penguin search "capabilityHash" --repo penguin-src --json` 返回
`freshness.status="stale"` +
`warnings:[{code:"REVISION_BEHIND", message:'indexed commit "dd521178…" for branch "main" is behind checked-out HEAD "de4a506e…"'}, {code:"WORKTREE_DRIFT", message:'worktree at "/Users/shieng/Desktop/Pengvi" has uncommitted changes'}]` +
`nextActions:[{command:"penguin index <repo-path>"}]`。✅ 这是本轮最好的 honesty 表现。

**但存在三处 revision 透明度缺陷：**
1. **clean repo 被误报 stale**：`search --repo FPMS-NT` 返回 `freshness.status:"stale"`，`warnings:[]`（顶层空数组），而同一 revision 的 `context`/`flow`/`impact`/`affected` 全部返回 `freshness.status:"fresh"` + `dirtyFileCount:0`。同一 build、同一 commit、两个 surface 结论相反。
2. **人类输出误导**：`penguin status` 打印 `FPMS-NT brazil-v2(live,stale=725)`，而 JSON 里 `trust.stale=false`、`staleReason=null`、`coverage.stale=0`。`stale=725` 实为 `staleSymbols`。
3. **revision 标识不统一**：同一次 `context` 响应内 `trust.snapshotId="snapshot_804a4c86-…"` 而 `revision.snapshotId="legacy:branch_10012ad4-…"`；`search` 用 `snapshot_804a4c86-…`。跨 capability 的 revision 无法逐字比对。
4. `penguin snapshots` 返回 `[]`，而 `status` 中多个 branch 的 `status` 为 `"snapshot"` 且 `search` 返回真实 `snapshotId` — 自相矛盾。

parser/schema/resolver version：`parserVersion=tree-sitter-wasm-v8-wrapper-allowlist`，`schemaVersion=14`，全仓一致。resolver version `not returned`。

### Q13 — provenance 在不同表面是否保持 — **PARTIAL**（medium）

| 类别 | 实例 | 保留情况 |
| --- | --- | --- |
| confirmed parser edge | `getActiveEventConfigByObjId --calls--> getColorLandEventConfigByIdFromCache` | `explore.queryDiagnostics.evidence.outgoingByType={calls:1, reads_field:6, writes_field:2}`，`incomingByType={calls:3, defines:1}`；`context`/`callers`/`callees`/`flow` 一致 ✅ |
| inferred edge | `not proven` — 本轮所有返回的边都没有 `origin`/`method`/`confidence` 字段；无法区分 confirmed 与 inferred | ❌ |
| external call | `externalCalls:[]`，`externalCallCount:0`（无实例） | `N/A: no instance` |
| unresolved reference | `unresolvedReferenceCount=10`，`coverageGaps:["unresolved_references_present"]` | 只在 `explore.queryDiagnostics` 与 `evidence.coverage` 出现；`callers`/`callees`/`flow` 的结果里**没有**对应标注 ❌ |
| agent suggestion | `penguin suggestions` → 1 条：`edge_led_e7b633c9-…`，`src:"MCP Wiki Test Page 测试页"`，`dst:"materialize"`，`edgeType:"mentions"`，**`confidence:0.7`** | 有 confidence ✅，但无 revision/时间/来源 ❌ |

- 唯一带 `confidence` 的是 suggestion；**代码图的边本身不带 confidence/origin/method**，因此「是否在某个表面被错误提升为 confirmed」这个问题在当前 contract 下**无法回答** → `not proven`。
- ❌ **最严重的 provenance 破坏**：`flow` 会把 step 的 `source.revisionId` 改写成请求 scope 的 branchId，而 `source.repoId` 保持原仓（见 F2）。

### Q14 — 三种分页 surface 的新进程续页 — **PASS**（high）

每一次 CLI 调用都是独立进程；page 1 的原始 JSON 落盘后由后续进程读取 cursor 续页，不依赖隐藏内存。

| surface | page1 | page2（新进程） | 耗尽 | malformed cursor | wrong-scope cursor | 重复 | 排序 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `endpoints` | limit 3 → 3/1541 | ✅ 3 条全新 | ✅ 末页 `truncated=false` 且不发 cursor；全量 1541 唯一 | `CURSOR_INVALID` exit 2 | 用 filesymbols 消费 → `CURSOR_SCOPE_MISMATCH`；用 `--repo casino-plus` 消费 FPMS-NT cursor → `CURSOR_SCOPE_MISMATCH` | 0 | `title,nodeId` 稳定 |
| `filesymbols` | limit 4 → 4/10 | ✅ 4 条全新 | ✅ page3 返回 2 条，`truncated=false`，无 cursor | `CURSOR_INVALID` exit 2 | 用 endpoints cursor → `CURSOR_SCOPE_MISMATCH` | 0 | 按 startLine 稳定 |
| `deadcode` | limit 4 → 4/5647，`totalIsExact=true` | ✅ 4 条全新 | 未取尽（5647 条，本轮只验证前两页） | `CURSOR_INVALID` exit 2 | `--repo casino-plus` + FPMS-NT cursor → `CURSOR_SCOPE_MISMATCH` | 0 | 按 filePath 稳定 |

- 不需要 `offset` 猜页 ✅；malformed cursor 不会被当成空结果 ✅；错误 scope 的 cursor 被拒绝 ✅。
- 小缺陷：cursor 类错误**没有 `details.remediation`**（不像 `TARGET_NOT_FOUND` / `UNKNOWN_OPTION` / `SCOPE_NOT_FOUND`）。

### Q15 — structured error 是否能指导下一步 — **PARTIAL**（high）

| 场景 | exact command | exit | JSON | code | retryable | remediation | 分类 |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| 缺少 required target | `context --repo FPMS-NT --json` | 1 | ✅ | `INVALID_TARGET` | false | ✅ `pass a concrete target such as \`penguin context Service.run --json\`` | invalid |
| **unknown repository** | `coverage --repo NO_SUCH_REPO --json` | 2 | ❌ **纯文本 `unknown repo: NO_SUCH_REPO`** | — | — | — | invalid（但不可机读） |
| unknown repository (search) | `search foo --repo NO_SUCH_REPO --json` | 2 | ❌ 同上 | — | — | — | invalid |
| ambiguous symbol | `context execute --repo FPMS-NT --json` | 1 | ✅ | `TARGET_AMBIGUOUS` | false | ✅ `details.candidates[]` 带 nodeId + identityKey（含完整路径） | ambiguous |
| invalid node ID | `context node:node_00000000-… --repo FPMS-NT` | 1 | ✅ | `TARGET_NOT_FOUND` | false | ✅ `run penguin search to find a current target ID` | absent |
| malformed cursor | `filesymbols … --cursor NOT-A-CURSOR` | 2 | ✅ | `CURSOR_INVALID` | false | ❌ 无 | invalid |
| wrong-scope cursor | `endpoints casino-plus --cursor <FPMS-NT cursor>` | 2 | ✅ | `CURSOR_SCOPE_MISMATCH` | false | ❌ 无 | invalid |
| invalid endpoint identity | `flow node:not-a-node` | 1 | ✅ | `TARGET_NOT_FOUND` | false | ✅ | absent |
| **empty query** | `search '' --repo FPMS-NT --json` | **0** | ✅ | — | — | — | ❌ **被当成 `NO_MATCH_INCOMPLETE` 的合法零结果** |
| **unknown branch + unknown file** | `filesymbols branch_deadbeef apps/x.ts --json` | **0** | 裸 `[]` | — | — | — | ❌ **静默空** |
| 非法 flag | `search foo --repo FPMS-NT --nope --json` | 2 | ✅ | `UNKNOWN_OPTION` | false | ✅ `run \`penguin help --json\` or \`<command> --help\`` | invalid |
| 无 live branch | `search constructor --json`（cwd=`/Users/shieng`） | 4 | ✅ | `SCOPE_NOT_FOUND` | false | ⚠️ 有但误导（应说 `--repo`） | unavailable |

- 失败不会泄漏到另一个 repository ✅（cursor scope mismatch 被硬拒）。
- ❌ **`no_match` 掩盖了 invalid**：空 query 与不存在的 branch/文件都返回成功零结果。这是 §2 规则 3 明确禁止的形态。

### Q16 — onboarding 是否真的帮助第一天工作 — **PARTIAL**（high）

`penguin onboarding FPMS-NT`（2,811 ms，2,636 B）含 `revision-hash=b071f365…` 与 `capability-hash=40ae9528…`。

逐条复核第 8 节「新会话第一轮检查」：

| 备忘录命令 | 可复制 | 参数有效 | 输出字段仍在 |
| --- | --- | --- | --- |
| `penguin status --json` | ✅ | ✅ | ✅ |
| `penguin coverage --json` | ✅ | ✅ | ⚠️ 无 scope/revision |
| `penguin search "<term>" --repo <repo> --branch <branch> --json` | ✅ | ✅ | ✅ |
| `penguin explore <symbol-or-endpoint> --repo <repo> --branch <branch> --json` | ✅ | ✅ | ✅ |
| `penguin affected <file> --repo <repo> --json` | ✅ | ✅ | ❌ **返回假零（F1）** |

第 4 节「关键入口」列出 6 条形如 `POST /promotion/GetPlayerFreeSpinInfo` 的入口 — **没有 endpoint ID、没有 identityKey**，且与 `endpoints` inventory 的两种标题形态都不同（第三种表述形态）。

给新工程师的 FPMS-NT gRPC 调查备忘录，按 brief 要求逐项对照 onboarding 覆盖度：

| 必须项 | onboarding 是否给出 |
| --- | --- |
| 第一条命令 | ✅ `penguin status --json` |
| repository scope | ✅ 第 1 节列出 repo + 路径 |
| freshness/coverage gate | ✅ 第 11 节 + 第 8 节末句（明确「未索引或 coverage failed 的文件不能用于否定性结论」） |
| endpoint discovery | ❌ 未提 `penguin endpoints` |
| page-two 选择 | ❌ 完全未提分页/cursor |
| dynamic ID handoff | ❌ 未提 `node:<id>` 交接 |
| context/flow/affected 边界 | ⚠️ 提了 flow partial 与 affected，但未说 flow 是下界、未警告 affected 缺陷 |
| negative claim 规则 | ✅ 第 11 节 |
| MCP unavailable fallback | ❌ 未提 |
| 什么时候必须读源码 | ✅ 第 11 节（动态 dispatch、reflection、外部服务、运行时配置） |

10 项中 5 项齐备、2 项部分、3 项缺失。

### Q17 — API doc 只读调查链 — **FAIL**（high）

1. `penguin api-doc list --json` → 2 条 preview（未执行 generate/bind/sync/repair/export）：

| previewId | title | coverage | revisionIds | sourceCommits | updatedAt |
| --- | --- | --- | ---: | ---: | --- |
| `preview:v1:0f638a79…:a1172886…` | API Documentation - FrontendRegisterService | **exhaustive** | 0 | 0 | 2026-07-18T10:11:26Z |
| `preview:v1:bc52027b…:a1172886…` | API Documentation - FrontendPlayerService | **exhaustive** | 0 | 0 | 2026-07-18T10:11:40Z |

2. `penguin api-doc show <previewId> --json`（3,251 B，keys = `ir`/`manifest`/`rendered`）：
   `ir.endpoints=[]`，`ir.enums=[]`，`ir.evidence=[]`，`ir.revisions=[]`，`ir.websocketEvents=[]`，
   `ir.gaps=[{gapId:"gap_revision_", code:"revision_unresolved", message:"No revision resolved for global."}]`，
   `rendered.sections` 的 `markdown` 全为空字符串。
3. `penguin api-doc diff <A> --against <B> --json` → `status:"changed"`，`changedSectionKeys:["summary"]`，markdownDiff 中逐字渲染出 **`- **Coverage:** exhaustive` / `- **Revisions:** none` / `- **Request partitions:** 0` / `- **Static exits:** 0/0`**。
4. `--repo FPMS-NT` 过滤对结果无影响（返回同样 2 条），说明 API doc 不受仓库 scope 约束。

- API identity / request / response / source locator / revision：**全部为空**。
- generated/stale 状态：`updatedAt` 6 周前，无任何相对当前索引的 stale 标记。
- **结论：不是 `not available`，而是「存在两份内容为空、却自我标注 `coverage: exhaustive` 的文档」。** 这比没有文档更危险：一个 agent 会把 `exhaustive` 读成「已穷尽覆盖」。

### Q18 — Wiki/Knowledge 非代码内容的边界 — **FAIL**（high）

只读执行，未创建/更新/删除任何内容。

| 能力 | 命令 | 结果 | 来源/时间/scope/revision | 分层 | 权限/敏感 | backlink/tag |
| --- | --- | --- | --- | --- | --- | --- |
| note list | `penguin note list --json` | `["redis-clusterallfailederror.md"]` | ❌ 全无 | — | ❌ | — |
| tag list | `penguin tags --json` | `[]` | ❌ | — | ❌ | ❌ |
| snapshot list | `penguin snapshots --json` | `[]`（与 status/search 矛盾） | ❌ | — | ❌ | — |
| evidence note list | `penguin evidence list --json` | `[]` | ❌ | — | ❌ | — |
| suggestions | `penguin suggestions --json` | 1 条，`confidence:0.7`，`edgeType:"mentions"`，src=`"MCP Wiki Test Page 测试页"` | ⚠️ 仅 confidence | — | ❌ | edgeId ✅ |
| recent | `penguin recent --json` | `SCOPE_NOT_FOUND` exit 4（cwd 依赖） | — | — | — | — |
| memory recall | `knowledge_memory_recall` | 能力已注册（`implemented`），本轮未取到内容 | `not proven` | — | — | — |

- note/memory 是否区分来源、时间、scope、revision：**否**。
- 代码证据与人工知识是否分层：**部分** — `context` 里有独立的 `notes:[]` 字段，说明设计上分层；但 note 列表本身无 envelope，无法判断某条 note 属于哪个 revision。
- sensitive/redaction 或权限状态：`knowledge_search` 的描述提到 `include_sensitive` 与「Sensitive pages are excluded unless include_sensitive」，但**任何只读列表都没有返回权限或敏感度字段** → `not returned`。
- stale note 是否会被表现成当前事实：**会**。唯一一条 note 无时间戳、无 revision，`context` 若把它挂到 `notes` 上，读者无从判断新旧。
- 可追溯 backlink/tag/evidence target：`tags=[]`、`evidence list=[]`，`backlinks` 能力存在但无内容可测。

**回答 brief 的问题：** Penguin 的 Wiki 能力目前是**「可证明代码事实」为主、「可查阅知识层」形同虚设**的混合体。风险清单：
1. API doc 空文档标注 `exhaustive`；
2. note/tag/snapshot/evidence 无 revision、无时间、无权限，任何一条被引用都无法证伪；
3. `snapshots` 返回 `[]` 与 `status`/`search` 的 snapshotId 直接冲突；
4. suggestion 带 0.7 confidence 但无来源，一旦被 accept 就会以 confirmed 边的形式进入代码图（本轮未 accept）。

### Q19 — Agent A → Agent B 跨 session handoff — **PARTIAL**（medium）

**Agent A（本 session）只用 Penguin 完成：**
- onboarding：`penguin onboarding FPMS-NT`（revision-hash `b071f365…`）
- repository 选择：`FPMS-NT` @ `brazil-v2` @ `3f0f1984b9e4337668529a13bad5264501729908`
- page-two endpoint：`node_ec762949-fbcc-4387-aa8e-f1ba65f6d626`
- 一个 symbol：`node_af26e1f8-17f5-473b-b76c-e33a150abfac`
- 一个 flow：`penguin flow node:node_3f34eb5d-65ae-4778-b663-4b45d9278eb3 --repo FPMS-NT`（60 节点）
- 一个 negative result：`penguin context node:node_ec762949-… --repo FPMS-NT` → 全空 + `not_proven`
- 一个 invalid-cursor error：`CURSOR_INVALID` / `CURSOR_SCOPE_MISMATCH`

**Handoff packet（仅本轮发出的值）：**
```text
repo=FPMS-NT  repoId=repo_c58d58a2-bb7f-4696-bd45-2c0c29634c67
branch=brazil-v2  branchId=branch_10012ad4-067a-4749-aafb-7a9c4f5c133d
commit=3f0f1984b9e4337668529a13bad5264501729908  snapshot=snapshot_804a4c86-b397-447a-9066-a51d36f2511a
endpoint(page2)=node_ec762949-fbcc-4387-aa8e-f1ba65f6d626   # 裸名孪生，flow 只有 2 步
endpoint(real) =node_3f34eb5d-65ae-4778-b663-4b45d9278eb3   # 限定名孪生，flow 60 节点
symbol         =node_af26e1f8-17f5-473b-b76c-e33a150abfac
cursor(endpoints,limit=3,page1) 见 ep-p1.json .nextCursor（含 expiresAt，约 +5 min）
next: penguin context node:<symbol> --repo FPMS-NT --json
      penguin flow node:<endpoint(real)> --repo FPMS-NT --json
      penguin endpoints FPMS-NT --limit 3 --cursor <cursor> --json
```

**Agent B 重放：** 本客户端**无法启动一个独立的 Agent B session** → 该项按 brief 规则记为 `N/A: 环境限制`。已用**独立 CLI 进程**（每次 Bash 调用一个全新 `penguin` 进程，无共享内存）替代执行全部 5 项重放：context ✅、flow ✅、cursor continuation ✅、negative query ✅、错误恢复 ✅ — **ID、scope、revision、cursor、术语与 remediation 在进程边界后全部有效**，未出现「ID 只在旧进程内有效」的情况。

⚠️ 唯一时间约束：cursor payload 含 `"expiresAt"`，实测约 **+5 分钟**。跨 session handoff 若超过该窗口，cursor 会失效（本轮未触发到过期错误码，`not proven` 其错误形状）。

### Q20 — 「已安装」与「已加载」分离证明 — **PARTIAL**（medium）

在 **1 个 MCP session + ≥30 个全新 CLI 进程**中重复采样（brief 要求 2 个新 MCP session，本客户端不支持）：

| 字段 | CLI（新进程 ×N） | MCP session #1 | 一致 |
| --- | --- | --- | --- |
| buildId | `1.16.0-e0284b7adffec06f` | `1.16.0-e0284b7adffec06f` | ✅ |
| capabilityHash | `40ae9528…87d0` | `40ae9528…87d0` | ✅ |
| schema / contract | 14 / 2 | 14 / 2 | ✅ |
| server generation | `not returned` | `running == available`，`outdated=false` | 单边 |
| runtime health | `doctor: ok`，ledger 12348/12348 | `status:"ok"`，`initializeHealthy=true` | ✅ |
| tool count | 99 capabilities | 99 registrations（deferred 工具清单亦全覆盖） | ✅ |
| duplicate tool count | 0 | 0 | ✅ |
| node IDs | `node_af26e1f8-…` 等 | 同一批 ID 全部解析成功 | ✅ |
| revision | `3f0f1984…` / `snapshot_804a4c86…` | `3f0f1984…` / `snapshot_804a4c86…` | ✅ |
| error shape | `{error:{code,message,retryable,details},exitCode}` | 本轮未触发同类错误 | `not proven` |
| restart guidance | — | `clientRestartRequired=false` | — |

**逐项结论：**
1. 新 app/runtime 是否可见 — **是**（`availableBuildId=1.16.0-e0284b7adffec06f`，`runtimeOutdated=false`）。
2. stable launcher 是否可见 — **是**（`/Users/shieng/.local/bin/penguin`，唯一，可执行，99/99 能力）。但 `mcp_health.launcherHealthy=null`、`configured=null` — **MCP 自己无法确认 launcher 状态**。
3. 新 MCP session 是否加载同一 generation — **`not proven`**（只有 1 个 MCP session 可供比较）。
4. 已运行的旧 MCP 进程是否真的 reload — **`not proven`**（无 process/generation/reload 证据；`clientRestartRequired=false` 只是声明，不是证明）。
5. CLI 与 MCP 是否返回同一知识 revision — **是，已证明**：两侧对 `node_af26e1f8-…` 都返回 `commitSha=3f0f1984…`、`snapshotId=snapshot_804a4c86…`、`indexedAt=2026-08-30T04:23:32.546Z`、`worktreeFingerprint=073264f8…`。

---

## 4. B1–B8 端到端工作流

### B1 — 冷启动 gRPC 调查 — **PARTIAL**

Bounded request-trace memo（全部来自本轮）：

```text
REPO      FPMS-NT @ brazil-v2 @ 3f0f1984b9e4337668529a13bad5264501729908 (clean, dirty=0)
COVERAGE  3333/3340 admitted, 7 excluded, 0 failed, unresolvedReferences=10
ENDPOINT  node_3f34eb5d-65ae-4778-b663-4b45d9278eb3
          gRPC promotion.v1.FrontendColorLandService.RollColorLandDice
CHAIN     endpoint --handles--> rollColorLandDice
                    apps/promotion/src/modules/color-land/controllers/color-land.controller.ts:103-127
                 --calls--> playDice  (dice.processor.ts:51-485)
                 --calls--> getActiveEventConfigByObjId (color-land-event-config.service.ts:135-156)
                 --calls--> getColorLandEventConfigByIdFromCache (:111-115)
                 --calls--> hget / incrby / hincrby      <-- Redis 边界（推断，非证明）
EVIDENCE FRONTIER
          第 1 处：depth>=3 之后不再区分 confirmed / inferred；边无 origin/method/confidence
          第 2 处：hget/incrby 只是符号名，未证明真的到达 Redis/Mongo
UNRESOLVED / DYNAMIC
          unresolvedReferences=10；completeness=lower_bound（constructor / interface dispatch /
          static-method / callback 内调用未建模）；proofStatus=not_proven
SOURCE-REVIEW BOUNDARY
          必须读源码：color-land.controller.ts:103-127、dice.processor.ts:51-485、
          color-land-event-config.service.ts:111-156
```

**为什么是 PARTIAL：** 从 onboarding 出发的规范路径（`endpoints FPMS-NT` → page 2）落到的是**裸名孪生 `node_ec762949`**，其 memo 只能写「endpoint → proto 模块，链路终止」。只有绕开 inventory、从 symbol 的 `explore.callPath` 反查才拿到真实 endpoint。冷启动 agent 按 brief 的流程走会得到错误的 memo。

### B2 — 安全改动准备 — **NO-GO**

- symbol：`node_af26e1f8-…`
- 影响面：`impact` 9（`totalIsExact=true`）、`context.importers` 21、callers 3
- 跟进两个新发出的 ID：`node_60f4c2d2-…`(playDice) 与 `node_2f61a74d-…`(buildContext) — 均可 `context`/`callers` 解析 ✅
- tests：`context.tests=[]`；但 MCP `knowledge_affected` 对同目录 controller 返回 1 个 spec 文件 → **测试可达性两侧不一致**
- routes：`context.routes=[]`；`explore.callPath` 却给出根 endpoint → **routes 字段不可信**
- **判定：NO-GO。** 触发条件：(a) CLI `affected` 对该文件返回 `impacted=0, totalIsExact=true` 与 impact/importers 矛盾；(b) `routes`/`tests` 空值与其它 surface 冲突；(c) `completeness=lower_bound` + 10 条未解析引用。

### B3 — 负面审计 — 见 Q11 表格

| claim | query | evidence | completeness | proven-or-not | missing evidence |
| --- | --- | --- | --- | --- | --- |
| symbol 无 callers | `callers node:node_af26e1f8-…` | 3 | lower_bound | **contradicted** | — |
| symbol 未被使用 | `impact` + `deadcode` | 9 / 5647 候选(41%) | totalIsExact=true + DI 免责 | **contradicted** | — |
| `constructor` 是死代码 | `deadcode --repo FPMS-NT` | 在候选列表中 | note 明示 DI 假阳性 | **not proven** | 需源码确认 `@Inject` |
| endpoint 无 handler | `context node:node_ec762949-…` | 全空 | not_proven | **not proven** | inventory 同时声称 `handled`；需要 handler locator |
| request 到不了 data | `flow` | 裸名 2 步 / 限定名达 Redis 原语 | not_proven | **not proven** | flow 是下界；动态 dispatch 未建模 |
| 文件无符号（伪造场景） | `filesymbols branch_deadbeef apps/x.ts` | 裸 `[]`, exit 0 | **无** | **honesty failure** | 应报 `BRANCH_NOT_FOUND` |

### B4 — 分页工作队列 — **PASS**

见 Q14。三个 surface 的 page 1 JSON 落盘后由全新 CLI 进程消费 cursor，全部完成 page 2；`endpoints` 额外完成到耗尽（8 页 / 1541 条 / 0 重复）；错误 cursor 与 wrong-scope cursor 均被正确拒绝并给出可区分的 error code。

### B5 — CLI/MCP 降级报告 — **PARTIAL**

同一目标 `search → filesymbols → context → flow → endpoint → invalid cursor` 全链路两侧执行：

| 阶段 | CLI | MCP | 差异 |
| --- | --- | --- | --- |
| search | ✅ 完整 envelope | ✅（`options.compact` 可用） | 一致 |
| filesymbols | ✅ | ✅ | 一致 |
| context | ✅ callers 3 / importers 21 | ✅ callers 3 / importers 21 | **一致** |
| flow | ✅ 60 节点 | ✅ 60 节点 | 一致 |
| endpoint | ✅ | ✅ **且多返回 handler `nodeId`** | CLI 缺字段 |
| **affected** | ❌ `impacted=0, totalIsExact=true` | ✅ `changed=13~30, impacted=0~172, tests=1~9, routes=5~11` | **结论相反** |
| invalid cursor | ✅ `CURSOR_INVALID` | 未触发 | `not proven` |

**打分：** 产品能力 59/90；环境准备度 6.5/10；CLI/MCP parity 0.5/2。
MCP **可用**，因此不存在「环境故障被混成产品故障」的问题；反过来，`affected` 的差异是**产品缺陷**（同一 build、同一 revision、同一能力 ID 的两条实现路径不一致），不是环境问题。

### B6 — API doc 与知识层只读浏览 — **FAIL**

见 Q17 / Q18。列出 2 份 API doc、1 个 note、0 tag、0 snapshot、0 evidence、1 suggestion；读取了 `preview:v1:0f638a79…` 一个真实对象：来源为空、revision 为空、stale 状态无标记、backlink 无、权限/敏感字段无。**未产生任何写入。**

### B7 — 两代 runtime 连续性 — **PARTIAL**

- Agent A 记录：buildId `1.16.0-e0284b7adffec06f`、capabilityHash `40ae9528…87d0`、serverGeneration `running==available`、symbol `node_af26e1f8-…`、endpoint `node_3f34eb5d-…`、错误 envelope `{error:{code:"CURSOR_SCOPE_MISMATCH",…},exitCode:2}`。
- Agent B（以全新 CLI 进程代替独立 session）重放：三项 ID/hash 完全一致，错误 envelope 逐字复现。
- 判定：
  - 「launcher 指向当前 runtime」— **证明成立**
  - 「MCP 加载当前 generation」— **`not proven`**（无第二个 MCP session）
  - 「evidence 与 revision 对齐」— **证明成立**（commit + snapshotId + worktreeFingerprint + indexedAt 四项跨表面一致）

### B8 — 新 session 最终 decision packet

```text
PRODUCT: NO-GO
ENVIRONMENT: DEGRADED

SAFE WITHOUT SOURCE:
  - 定位符号并取回逐字源码：penguin explore/context node:<id> --repo FPMS-NT   [Q5, 283ms, sourcesOmitted=[]]
  - 列出一个符号的 direct callers/callees/importers                            [Q6: callers=3, importers=21，CLI/MCP 一致]
  - 从 symbol 反查真实 endpoint：explore.callPath                               [Q5: 4 层 callPath 带 revisionId]
  - 分页遍历任意 inventory 并跨进程续页                                        [Q14/B4: 1541 条 0 重复，耗尽状态明确]
  - 判定一个 repo 的 revision/freshness/coverage 是否可信                       [Q12: REVISION_BEHIND + WORKTREE_DRIFT]
  - 从结构化错误直接改写下一次调用                                              [Q15: 9/12 场景给出可执行 remediation]

REQUIRES SOURCE/HUMAN:
  - 任何 endpoint 的 handler 归属与「是否 handled」                              [Q7/Q9/F4]
  - 任何「改这个文件会影响什么」的结论（CLI affected 不可用）                    [Q10/F1]
  - 任何 tests / routes 为空的判断                                              [B2: 与 MCP 结论冲突]
  - 任何 confirmed vs inferred 的边区分                                         [Q13: 边不带 origin/method/confidence]
  - 任何 API doc / note 的时效性与来源                                          [Q17/Q18]
  - deadcode 候选（41% 命中率，DI 假阳性已实证）                                [Q11]

UNPROVEN CLAIMS:
  - 「两个全新 MCP session 加载同一 generation」                    (Q20 #3, 环境限制)
  - 「已运行的旧 MCP 进程真的 reload」                              (Q20 #4, 无 process 证据)
  - 「本轮为完全 fresh session（旧进程已退出）」                     (§1, 无法自证)
  - 「MCP 侧错误 envelope 与 CLI 同形」                             (Q2/Q20, 未触发同类错误)
  - 「inferred edge 是否被错误提升为 confirmed」                     (Q13, contract 不暴露 origin/confidence)
  - 「cursor 过期后的错误形状」                                      (Q19, 未触发)
  - CLI runtime 可执行文件路径                                       (§1, CLI 不暴露)

TOP 5 FIXES:  (见第 9 节)

RETEST COMMANDS:
  penguin affected libs/common/constants.ts --repo FPMS-NT --json          # 期望 impacted>0 或 totalIsExact=false
  penguin flow node:<FPMS-NT endpoint id> --repo claude_code --json        # 期望 SCOPE_MISMATCH 而非改标 revision
  penguin endpoints claude_code --limit 5 --json                           # 期望 0 条或明确 cross-repo 警告
  penguin search constructor --repo FPMS-NT --json | jq .freshness         # 期望 fresh
  penguin search '' --repo FPMS-NT --json                                  # 期望 INVALID_QUERY 而非 exit 0
  penguin filesymbols branch_deadbeef apps/x.ts --json                     # 期望 BRANCH_NOT_FOUND 而非 []
  penguin api-doc show <previewId> --json | jq .manifest.coverage          # 期望 not exhaustive
```

---

## 5. 不读源码即可可靠完成的操作

1. **符号级 source pack**：`explore`/`context node:<id>` 返回逐字源码 + 签名 + kind + 精确行号 + `sourcesOmitted`，283 ms。
2. **符号级依赖关系**：direct callers / callees / importers，CLI 与 MCP 逐条一致。
3. **从符号反查真实 endpoint**：`explore.callPath` 给出 endpoint→controller→processor→service 的完整链，每步带 `source.{repoId,filePath,startLine,revisionId}`。
4. **revision / freshness / coverage 门槛判断**：`status --json` + `search` 的 `REVISION_BEHIND` / `WORKTREE_DRIFT` 警告。
5. **大 inventory 的确定性遍历**：稳定排序、零重复、耗尽可判、cursor 跨进程可用、错误 cursor 可区分。
6. **能力发现与 CLI/MCP 同代确认**：99/99 能力 ID 逐项一致，capabilityHash 三处相同。
7. **歧义消解**：`TARGET_AMBIGUOUS` 返回带 `identityKey`（含完整路径）的候选，可直接重试。

## 6. 必须读源码、数据库或人工确认的操作

1. endpoint 的 handler 归属、`handlerStatus`、endpoint 与仓库的隶属关系。
2. 任何 change-impact / blast-radius 决策（CLI `affected` 不可用，需改用 MCP `knowledge_affected` 并人工复核）。
3. 任何 `tests` / `routes` 为空的判断。
4. deadcode 候选的真伪（DI / reflection / 框架魔法 / 公开入口）。
5. 边的 confirmed vs inferred 性质、外部调用、动态 dispatch。
6. Redis / Mongo 等 data boundary 的真实可达性（图里只有符号名）。
7. API doc / note / suggestion 的内容正确性与时效性。
8. gRPC 的业务语义（`completeness=lower_bound` 明确排除 interface dispatch 与 callback 内调用）。

## 7. misleading / ambiguous / failed / unavailable / non-actionable 输出

| 类型 | 实例 |
| --- | --- |
| **misleading** | `affected` 的 `totalIsExact:true` + `impacted:0`；`api-doc` 空文档标 `coverage:exhaustive`；`search` 对 clean repo 报 `freshness:stale`；`penguin status` 人类行 `stale=725`；`handlerStatus:"handled"` 指向 proto 目录节点；`endpoints <任意 repo>` 返回同一批全局 endpoint；`flow --repo X` 把他仓 source 标成 X 的 revision |
| **ambiguous** | `candidateCount` 在 `endpoints` 里是「剩余数」而非总数；`completeness:"partial"` 在 `candidateCount==returnedCount` 时仍出现；`SCOPE_NOT_FOUND` 的 remediation 指向 `--branch` 而非 `--repo`；同一响应内两个不同的 `snapshotId`；endpoint 标题存在三种表述（inventory 裸名 / inventory 限定名 / onboarding 的 `POST /Svc/Method`） |
| **failed** | `context node:<endpoint-id>` 对确有 handler 的 endpoint 返回全空；`search` 的 `field` hit `nodeId=null` |
| **unavailable** | 第二个 MCP session（客户端限制）；CLI runtime 路径；边的 `origin`/`method`/`confidence`；`mcp_health.launcherHealthy` / `configured` 为 `null` |
| **non-actionable** | `note list` / `tags` / `snapshots` / `evidence list` 的裸数组；`coverage --json` 的 5 字段无 scope；`knowledge_capabilities` 非 compact 输出超限被截断 |

## 8. 产品缺陷 versus 评估环境缺陷

**产品缺陷（8 项，全部在 CLI 与 MCP 同一 build 上可复现）：**
F1 `affected` 假零 · F2 flow 跨仓 revision 错标 · F3 endpoint `context` 全空 · F4 endpoint identity 分裂 + scope 近似无效 · F5 `search` freshness 误报 stale · F6 空 query / 未知 branch 静默成功 · F7 `unknown repo` 非 JSON · F8 知识层（API doc / note / tag / snapshot / evidence）无 envelope 且空文档标 exhaustive。

**评估环境缺陷（3 项）：**
E1 无法开第二个独立 MCP session → Q20 #3/#4 `not proven`；
E2 无法证明旧 Claude/Codex/MCP 进程已退出 → fresh-session 未完全证明；
E3 `knowledge_capabilities` 非 compact 输出超过 MCP 返回上限（介于产品与环境之间，已按产品可用性计入 Q3）。

**不得混淆：** MCP 环境完全可用（initialize / tools / health / capabilities 全绿），所以上述 8 项**不能**归因于环境。

---

## 9. 修复建议（按影响 / 成本 / 可验证 acceptance criterion 排序）

| # | 缺陷 | 影响 | 成本 | Acceptance criterion |
| --- | --- | ---: | ---: | --- |
| **1** | **F1 CLI `affected` 对任意文件返回 `impacted=0` 且 `totalIsExact=true`**，而 MCP `knowledge_affected` 同参数返回 13–172 条 | 致命 — 直接导致「改这个文件没有影响」的错误放行 | 低（CLI 路径未把 file 节点展开为 symbol 集，与 MCP 走了两条实现） | `penguin affected apps/promotion/src/modules/color-land/controllers/color-land.controller.ts --repo FPMS-NT --json` 返回 `changed>=13`、`routes>=11`、`tests>=1`，且与 `knowledge_affected` 同参数结果逐字段相等；空集时必须 `totalIsExact:false` |
| **2** | **F2 `flow --repo <其它仓>` 接受他仓 node 并把 step 的 `source.revisionId` 改写成请求 scope 的 branchId**（`source.repoId` 仍是原仓），`alignment:"aligned"`、`warnings:[]` | 致命 — 跨仓 ID 串线 + revision 错标，违反 §2 规则 1/2 | 中 | `penguin flow node:node_3f34eb5d-… --repo claude_code --json` 返回 `SCOPE_MISMATCH` 类错误；或返回结果时 `trust.repoName` 必须是节点真实所属仓，且 `warnings` 含跨仓警告；`source.revisionId` 永不被请求 scope 覆写 |
| **3** | **F4 endpoint identity 分裂**：同一 gRPC 方法存在 `grpc::Svc.method`（654 个，handler 指向他仓 proto/目录节点）与 `grpc::pkg.v1.Svc.method`（887 个，handler 指向真实 symbol）两个节点；`endpoints <repo>` 对 `claude_code` 与 `FPMS-NT` 返回同一批 page-1；`handlerStatus` 1532/1541 恒为 `handled` | 致命 — endpoint 调查从第一步就走偏；负面结论不可信 | 高 | (a) 同一 gRPC 方法只有一个 endpoint 节点，或双胞胎之间建立 alias 且 `context`/`endpoint-identity` 明确提示；(b) `penguin endpoints claude_code --limit 5` 返回 0 条或带 cross-repo 警告；(c) handler 指向 proto 模块节点时 `handlerStatus` 必须为 `proto_only`/`incomplete` 而非 `handled` |
| **4** | **F3 `context node:<endpoint-id>` 对确有 handler 的 endpoint 返回 callers/calls/invokedBy/routes/tests 全 0**，而 `flow` 同 ID 返回 60 节点 | 高 — 制造假否定；两个 surface 互相矛盾 | 中 | `penguin context node:node_3f34eb5d-… --repo FPMS-NT --json` 至少返回 `handles` 边指向 `rollColorLandDice`；`context` 与 `flow` 的 depth-1 结果集必须相同 |
| **5** | **F6/F7 静默成功与非 JSON 错误**：`search ''` → exit 0 空结果；`filesymbols <bad-branch> <bad-path>` → exit 0 裸 `[]`；`--repo NO_SUCH_REPO` → 纯文本 exit 2 | 高 — §2 规则 3 明确禁止用空结果掩盖 invalid | 低 | `search ''` 返回 `INVALID_QUERY`；`filesymbols` 对不存在 branch 返回 `BRANCH_NOT_FOUND`、对不存在文件返回 `FILE_NOT_FOUND`；`--repo NO_SUCH_REPO` 在 `--json` 下返回 `{"error":{"code":"REPO_NOT_FOUND",…}}` |
| 6 | **F5 `search` 对 `indexedCommit==headCommit`、`dirty=0` 的 clean repo 报 `freshness:"stale"` 且 `warnings:[]`**，与 `context`/`flow`/`impact` 的 `fresh` 冲突 | 中 — 训练 agent 忽略 freshness 字段 | 低 | `penguin search constructor --repo FPMS-NT --json \| jq .freshness.status` == `"fresh"`；`freshness:"stale"` 必须伴随非空 `warnings` |
| 7 | **F8 知识层无 envelope**：`note list`/`tags`/`snapshots`/`evidence list` 返回裸数组；`snapshots` 返回 `[]` 与 `status`/`search` 的 snapshotId 冲突；API doc 空内容标 `coverage:"exhaustive"`、`revisionIds:[]` | 中 — Wiki 层不可追溯，`exhaustive` 反向误导 | 中 | 四个 list 命令返回统一 envelope（scope/revision/freshness/counts/cursor）；`penguin snapshots` 返回与 `status` 一致的 snapshot 集；`ir.endpoints` 为空时 `manifest.coverage` 不得为 `exhaustive`，且必须带 `stale` 相对当前 index 的标记 |
| 8 | `endpoints`/`filesymbols` envelope 缺 scope/revision/freshness/coverage；cursor 内 `revision:null` | 中 | 低 | 两者返回与 `search` 同级的 honesty gate 字段 |
| 9 | `search` 的 `field` lane hit `nodeId:null`/`symbol:null`，title 被词切污染（`"getActiveEventConfigByObjId get Active Event Config By Obj Id"`） | 中 — ID 无法交接；`node:null` 会误命中字面量 `null` 节点 | 低 | 每条 hit 必须有非空 `nodeId`，否则不返回；`context node:null` 返回 `INVALID_NODE_ID` |
| 10 | cursor 类错误缺 `details.remediation`；`SCOPE_NOT_FOUND` 的 remediation 指向 `--branch` 而非 `--repo` | 低 | 低 | 所有 error code 都带可直接执行的 `remediation` |
| 11 | `candidateCount` 在 `endpoints` 中是剩余数；`completeness:"partial"` 在未截断时仍出现 | 低 — 语义歧义 | 低 | 剩余数改名 `remainingCount` 或保持总数不变；`candidateCount==returnedCount && !truncated` 时 `completeness` 为 `exact` |
| 12 | `knowledge_capabilities` 非 compact 输出 71,940 字符超 MCP 上限 | 低 | 低 | 默认返回 compact，`full:true` 显式请求 |
| 13 | CLI 无 `--version`；`penguin filesymbols --help` 的 usage（3 参）与 `penguin help` 的说明（2 参）不一致 | 低 | 低 | `penguin --version` 输出 buildId + capabilityHash；两处 usage 统一 |

---

## 10. 证据表（brief §6 要求）

| ID/target | 由哪条结果发出 | follow-up | scope/revision | completeness | evidence state | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `node_af26e1f8-17f5-473b-b76c-e33a150abfac` | `penguin filesymbols branch_10012ad4-… <path> --limit 20 --json` | `penguin explore node:<id> --repo FPMS-NT --json` | FPMS-NT / brazil-v2 / 3f0f1984… / snapshot_804a4c86… | `lower_bound`，candidateCount 17，totalIsExact **false** | confirmed（`calls` 边，parser 派生） | **PASS** |
| `node_af26e1f8-…` | 同上 | `penguin impact node:<id> --repo FPMS-NT --json` | 同上 | candidateCount 9，totalIsExact **true**，coverageGaps=`unresolved_reference_counts_not_persisted` | confirmed | **PASS** |
| `libs/common/constants.ts` | `explore` 的 hub 列表 / onboarding | `penguin affected <file> --repo FPMS-NT --json` | 同上 | candidateCount **0**，totalIsExact **true** | ❌ 与 MCP 的 172 impacted 冲突 | **FAIL** |
| `libs/common/constants.ts` | 同上 | `knowledge_affected{file,repo}` | 同上 | candidateCount 200，truncated true，proofStatus `candidate` | confirmed | **PASS** |
| `node_ec762949-fbcc-4387-aa8e-f1ba65f6d626` | `penguin endpoints FPMS-NT --limit 3 --cursor <p1> --json`（page 2） | `context` / `flow` / 5 种 identity 形式 | 声称 FPMS-NT；节点 `repoId=null` | context 全 0；flow 2 步 | `not_proven`；handler=`grpc-module::repo_e3c88b3d::proto` | **FAIL**（identity 解析 PASS，链路 FAIL） |
| `node_3f34eb5d-65ae-4778-b663-4b45d9278eb3` | `ep-all.jsonl`（全量分页） | `penguin flow node:<id> --repo FPMS-NT --json` | FPMS-NT / 3f0f1984… | candidateCount 2 → 60 节点，proofStatus `not_proven` | confirmed `handles` 边 + 真实 locator | **PASS** |
| `node_3f34eb5d-…` | 同上 | `penguin flow node:<id> --repo claude_code --json` | ❌ 标为 claude_code / master / d3531b0a…；step `source.repoId=repo_c58d58a2` 但 `source.revisionId=branch_afa07b83` | candidateCount 2，`alignment:"aligned"`，`warnings:[]` | ❌ **revision 错标，无警告** | **FAIL** |
| `node_7c2d4657-cd74-4a3e-ac9a-004767fa3749` | `penguin search constructor --repo FPMS-NT --json` `.hits[0].nodeId` | `penguin context node:<id> --repo FPMS-NT --json` | FPMS-NT / 3f0f1984… | callers 0，lower_bound | 同时出现在 `deadcode` 候选，note 明示 DI 假阳性 | **PARTIAL**（not proven） |
| `nodeId:null` | `penguin search getActiveEventConfigByObjId --repo FPMS-NT --json`（`kind:"field"` 的 8 条） | 不可 round-trip | FPMS-NT | returnedCount 26 == candidateCount 26 但 completeness `partial` | ❌ 无 ID | **FAIL** |
| cursor `eyJzY2hlbWFW…`（endpoints p1） | `penguin endpoints FPMS-NT --limit 3 --json` | 新进程 `--cursor` 续页 ×8 至耗尽 | scope `FPMS-NT\|*`，cursor 内 `revision:null` | 1541/1541，unique 1541，末页 truncated=false | confirmed | **PASS** |
| 同上 cursor | 同上 | `penguin endpoints casino-plus --cursor <该 cursor>` | — | — | `CURSOR_SCOPE_MISMATCH` exit 2 | **PASS** |
| `preview:v1:0f638a79…:a1172886…` | `penguin api-doc list --json` | `api-doc show` / `api-doc diff --against` | 无 revision（`revisionIds:[]`，`gap_revision_`） | `coverage:"exhaustive"` 但 endpoints/enums/evidence 全空 | ❌ 自相矛盾 | **FAIL** |
| `penguin-src` @ main | `penguin status --json` | `penguin search capabilityHash --repo penguin-src --json` | dd521178… vs HEAD de4a506e…，dirty 64 | `freshness:"stale"`，`completeness:"partial"` | ✅ `REVISION_BEHIND` + `WORKTREE_DRIFT` + nextActions | **PASS** |
| `FPMS-NT` @ brazil-v2 | 同上 | `penguin search constructor --repo FPMS-NT --json` | indexed==head，dirty 0，trust.stale=false | `freshness:"stale"`，`warnings:[]` | ❌ 与 context/flow 的 `fresh` 冲突 | **FAIL** |

---

## 11. 最终结论

```text
PRODUCT:     NO-GO
ENVIRONMENT: DEGRADED
```

**PRODUCT = NO-GO 的依据（brief §5 的四条硬性否决项，本轮四条全部命中）：**

| 否决项 | 实例 |
| --- | --- |
| 动态 ID 串线 | `flow node:<FPMS-NT endpoint> --repo claude_code` 返回 FPMS-NT 的源码与行号（F2） |
| 错误 scope | `endpoints claude_code --limit 5` 与 `endpoints FPMS-NT --limit 5` 返回逐条相同的 gRPC endpoint；994/1541 条 FPMS-NT「自己的」endpoint 没有任何 FPMS-NT handler（F4） |
| 虚假负面结论 | CLI `affected <任意文件> --repo FPMS-NT` 恒返回 `impacted=0` 且 `totalIsExact=true`（F1） |
| 不可解释的 stale promotion | `search --repo FPMS-NT` 对 clean、commit 对齐、dirty=0 的仓库返回 `freshness:"stale"` 且 `warnings:[]`（F5） |

**ENVIRONMENT = DEGRADED 的依据：** launcher / runtime / MCP / capability hash / schema / revision 六项全部对齐且可证明；扣分只在 (a) 无法开第二个 MCP session 证明 reload（Q20 #3/#4 `not proven`），(b) CLI/MCP `affected` 结论相反导致 parity 不成立。**MCP 本身完全可用，不得把 F1–F8 归因于环境。**

**给 Claude / Codex 内部使用的建议：**

1. **可以现在就用**：`explore` / `context` / `callers` / `callees` / `impact` / `flow`（**限 symbol 目标**）+ `status` / `coverage` / 分页遍历。这条路径本轮 100% 可证明、跨 CLI/MCP 一致、跨进程可交接，比 grep + Read 快一个数量级。
2. **立即停用**：CLI `penguin affected`（改用 MCP `knowledge_affected`，且结果仍需人工复核）。
3. **必须加护栏**：任何来自 `penguin endpoints` 的结论，先用 `explore <某个 handler symbol>.callPath` 反查确认 endpoint 节点是限定名族（`gRPC pkg.vN.Svc.Method`）再继续；裸名族一律视为不可用。
4. **必须显式传 `--repo`**，且**不要相信 `--repo` 会约束 endpoint/flow 的跨仓行为** — 自行核对结果里的 `repoId` 是否等于目标仓。
5. **忽略 `search` 的 `freshness` 字段**，改看 `status --json` 的 `trust.stale` / `staleReason` / `dirtyFiles`，或 `context`/`flow` 的 `freshness`。
6. **不要把 Penguin 的 Wiki/API doc 层当知识源**：当前是空壳 + 误导性 `exhaustive` 标注。
7. 修完上表 #1–#5 后重跑第 4 节的 `RETEST COMMANDS`，届时产品分预计可达 82–88（85–94 区间的下沿），仍不足以称为「高信任知识层」，需再修 #6–#9。

<!-- Round 17 evaluation result. Generated 2026-08-30 by Claude Opus 5 (1M context) in a fresh Claude Code session, CLI+MCP only, read-only. -->
