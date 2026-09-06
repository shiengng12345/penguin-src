# Penguin Wiki / Knowledge Evaluation — Codex Round 17

> 执行日期：2026-08-30（Asia/Kuala_Lumpur）  
> 客户端：当前 Codex session  仅使用 Penguin 稳定 CLI 与已暴露的 Penguin MCP 工具  
> 目标仓库：`FPMS-NT`，路径 `/Users/shieng/Desktop/Projects/fpmsnt`  
> 结论性质：降级、只读能力评估；不是发布验收，也不是源码修复

## 0. 重要执行边界

Round 17 要求从完全空白 prompt 启动 fresh session，并禁止读取旧报告、源码、数据库、Git、浏览器结果或答案键。本次 Codex 对话已经带有历史上下文，因此无法证明满足 fresh-session 条件；本报告不把当前会话包装成 fresh pass。

除本报告文件外，没有执行源码、数据库或 Git 读取，没有执行 `index`、`rebuild`、`watch`、repository 注册/移除、写 note、写 memory、写 link、修改 ontology、接受 suggestion、build、sign、安装、发布或删除操作。`context` 默认返回了 Penguin source pack，但本评估没有将源码正文作为结论依据；source-pack 能力仅按其返回的 locator/omission contract 记录。

完成门槛未满足：没有两个可审计的新 MCP session；endpoint 全量 cursor 未耗尽；没有合法 emitted exhausted cursor 可供回放；当前 session 不是 fresh。故最终 `PRODUCT=NO-GO` 是对“高信任替代 CodeGraph/完整知识层”的结论，不表示所有局部能力不可用。

## 1. 初始化证据

### CLI

实际 launcher：`/Users/shieng/.local/bin/penguin`。

实际调用：

```text
penguin help --json
penguin capabilities --json
penguin status --json
penguin doctor --json
penguin coverage --repo FPMS-NT --json
penguin onboarding FPMS-NT --json
```

`help --json` 暴露了 `capabilities/search/node/callers/calls/callees/impact/context/explore/flow/affected/files/filesymbols/endpoints/endpoint-identity/deadcode/coverage/onboarding` 等命令；cursor contract 为 `ordering=filePath,startLine,nodeId`、scope checked、`nextCursor:null` 表示 exhausted、invalid cursor 退出码为 2。

CLI capability manifest 返回：`contractVersion=2`、`schemaVersion=14`、`buildId=1.16.0-e0284b7adffec06f`、`capabilityHash=40ae9528330e4e97d68072d3c40c1be3db9e40f8f52478b44c8de026be4487d0`、`capabilityCount=99`。

### MCP

实际调用：`mcp_health`、`knowledge_capabilities(compact=true/false)`、`index_status(mode=compact)`、`status_panel`。

MCP health 返回 `status=ok`、`initializeHealthy=true`、`clientRestartRequired=false`、`runtimeOutdated=false`，running/available build 均为 `1.16.0-e0284b7adffec06f`，schema 14，capability hash 与 CLI 相同；query runtime 为 2 workers、15 秒 hard timeout。MCP capability manifest 也返回 99 项。

`tools/list` 原始协议调用和工具数量重复校验没有在当前 host interface 中单独暴露；因此 `tools/list` 数量、重复 tool 数和初始化协议原始 envelope 记为 `not returned`，不能从 capabilityCount 代替证明。

### FPMS-NT revision / coverage

Penguin status/index status 返回：

| 字段 | 当前证据 |
| --- | --- |
| repo | `FPMS-NT` |
| path | `/Users/shieng/Desktop/Projects/fpmsnt` |
| branch | `brazil-v2` |
| alignment | `aligned` |
| indexed commit | `3f0f1984b9e4337668529a13bad5264501729908` |
| head commit | `3f0f1984b9e4337668529a13bad5264501729908` |
| freshness（status/context/flow） | `fresh` |
| discovered/admitted/excluded/failed | `3340 / 3333 / 7 / 0` |
| unresolved references | `10`（部分 relation envelope） |
| parser | `tree-sitter-wasm-v8-wrapper-allowlist` |
| indexed at | `2026-08-30T04:23:32.546Z` |

同一仓库的 `knowledge_search` 结果却多次返回 `trust=fallback_live`、`freshness.status=stale`、`commitSha=(legacy)`、`completeness=partial`、`proofStatus=not_proven`，而 context/flow 返回 `trust=exact_commit`、`fresh`。这不是被静默抹平的差异，结果本身可见；但它降低了跨 surface 的可组合性。

## 2. 分数与最终判断

### 产品能力

原始产品分：`60 / 90`；折算：`67 / 100`。

| 维度 | 得分 | 依据 |
| --- | ---: | --- |
| Agent discoverability | 7/10 | help、capabilities、onboarding 可用；onboarding 与实际 freshness/scope 仍有差异 |
| Context usefulness | 8/12 | path、line、revision、trust、locator 可行动；relation 是 lower bound |
| Search precision | 5/8 | path-qualified symbol search 可用；常见词碰撞大，精确 constructor 搜索出现 no-match |
| Graph usefulness | 5/10 | ID round-trip 可用，但 empty relation 仍是 no_static_edge/lower bound |
| Endpoint investigation | 3/8 | identity 与 page-two 可用；repo scope 未可靠约束 handler |
| Pagination/continuity | 7/10 | filesymbols/deadcode 跨 CLI 进程续页有效；endpoint 未耗尽 |
| Accuracy | 5/10 | endpoint handler 跨仓库、repoId 缺失、freshness envelope 不一致 |
| Completeness | 3/8 | excluded files、unresolved references、lower bound、non-exact totals |
| Honesty | 7/8 | no-match、coverage warning、proofStatus、deadcode false-positive 提示较明确 |
| Recovery/usability | 4/6 | invalid cursor 与 invalid target 有结构化 remediation；unknown repo 仍是纯文本 |
| Wiki/API knowledge | 2/5 | API preview list 可读；note list runtime error，memory/tag 为空，link-list MCP tool 未暴露 |
| Speed | 4/5 | 小查询大多快速；一次 note/list 触发 module-not-found |

### 环境准备度

原始环境分：`6 / 10`；折算：`60 / 100`。

| 维度 | 得分 | 依据 |
| --- | ---: | --- |
| stable launcher/runtime | 3/3 | launcher 存在，CLI build 与 MCP running/available build 一致 |
| MCP availability | 2/2 | initialize health、mcp_health、knowledge capabilities 可用 |
| CLI/MCP parity | 1/2 | build/hash/schema/count 一致；tools/list 与 endpoint input schema parity 未完全证明 |
| fresh-session reload proof | 0/2 | 当前不是 fresh；两个独立 MCP session/reload 未证明 |
| release evidence | 0/1 | 本题未执行安装、签名或发布验证 |

最终：

```text
PRODUCT: NO-GO
ENVIRONMENT: DEGRADED
```

## 3. Q1–Q20

以下每题都保留了 exact command/tool、scope、revision、freshness、completeness、count/cursor 和结论边界；未满足的项目明确写 `not proven` 或 `N/A`。

### Q1 — fresh session 第一条命令

- exact command：`penguin help --json` → `penguin status --json` → `penguin coverage --repo FPMS-NT --json` → `penguin search "<term>" --repo FPMS-NT --branch brazil-v2 --json`。
- raw evidence：help 明确暴露命令；onboarding 建议 Status → Coverage → Scoped Search → Explore → Affected → Source Review。
- scope/revision：onboarding 返回 FPMS-NT、`brazil-v2`、revision hash `b071f365...`；status 返回 aligned commit `3f0f1984...`。
- freshness/coverage：3333 admitted、7 excluded、0 failed；负面结论必须保留 `proofStatus`/coverage gate。
- conclusion：`PARTIAL`。安全首步是先 help/status/coverage，再用仓库 scoped search；不能从 global search、空数组或未耗尽 cursor 做 absence 结论。fresh-session 本轮 `not proven`。

### Q2 — CLI/MCP 是否同代

- exact command/tool：`penguin capabilities --json`、`mcp_health`、`knowledge_capabilities(compact=false)`。
- raw evidence：两侧均为 contract 2、schema 14、build `1.16.0-e0284b7adffec06f`、hash `40ae9528...487d0`、capabilityCount 99；MCP running/available generation 相同且 `outdated=false`。
- not returned：独立 `initialize` 原始包、`tools/list` 原始数量/重复数、CLI/MCP 全部错误 envelope 的逐项对照。
- conclusion：`PARTIAL`。同代 build/hash/schema 已证明；完整 tool mapping、generation reload 与 error parity `not proven`。

### Q3 — compact envelope

- exact command/tool：CLI `search/status/coverage` 的 `--json`；MCP `knowledge_search(options.compact=true)` 与 `knowledge_capabilities(compact=true)`。
- raw evidence：compact capability 保留 schema/build/hash/count；scoped empty search 保留 revision、freshness、coverage、completeness、proofStatus、counts、cursor、diagnostics、warnings、nextActions。
- scope/revision：FPMS-NT；search 曾返回 legacy fallback/stale，另一次空 search 返回 snapshot `snapshot_804a4c86...`。
- conclusion：`PASS`（honesty fields 保留）。compact 没有删掉主要 honesty gate。字节大小的统一 CLI/MCP 对照 `not returned`。

### Q4 — global → scoped → ID follow-up

- exact command/tool：`knowledge_search(query=constructor/execute/update)`，分别无 scope 与 `repoName=FPMS-NT` scope；CLI `penguin search PaymentExternalService --repo FPMS-NT --branch brazil-v2 --json`。
- raw evidence：global `constructor` 返回跨仓库结果；scoped exact `constructor` 返回 0 hits、`NO_MATCH_INCOMPLETE`；scoped PaymentExternalService 返回当前 symbol ID `node_e61f3e22-edd0-47e8-bebc-bb0e46985dd3`，locator 为 `apps/admin/inteceptor/payment-external.service.ts:13`。
- conclusion：`PARTIAL`。path-qualified search → ID → context 能避免猜 symbol；但 MCP search 的 legacy/fresh envelope 不稳定，global result 不能用于 FPMS-NT 负面结论。

### Q5 — source pack 是否能准备 review

- exact command/tool：`knowledge_file_symbols`（CLI filesymbols 等价）以及 `knowledge_explore(target=node_e61f3e22..., include_sources=false, repo=FPMS-NT)`。
- raw evidence：focus locator、kind/class、signature、callers/calls/routes/tests、revision、freshness、coverage、`sourcesOmitted`、`queryDiagnostics`、`proofStatus`、next boundary 均有返回；`include_sources=false` 明确写出 source omission。
- completeness：`partial/lower_bound`；unresolved references 10；calls list 不是完整静态调用证明。
- conclusion：`PASS` for “列出应审查的源码位置”；`FAIL` for “确认业务语义正确”。必须进入 source/human review，不能把 source pack 或 graph 当完整语义证明。

### Q6 — dynamic ID round-trip

本轮新发出的代表值：

| emitted ID | emitted by | follow-up | response |
| --- | --- | --- | --- |
| `node_e61f3e22-edd0-47e8-bebc-bb0e46985dd3` | CLI scoped search/filesymbols | context / callers / callees / flow / affected / explore | resolved；FPMS-NT、brazil-v2、commit `3f0f1984...`；callers/callees empty 但 `no_static_edge`、lower_bound |
| `node_3385190d-6ca3-44d2-8115-d97e9df5e915` | filesymbols page 2 | 可作为当前 symbol ID | `getPaymentConfigs`，line 25–52，page 2，final `nextCursor:null` |
| `node_ec762949-fbcc-4387-aa8e-f1ba65f6d626` | endpoints page 2 | context / flow / affected | endpoint resolved；flow 只有 endpoint → service `proto`；handler/source locator 不完整 |
| `node_422c6ba6-0fcf-4f4a-a4df-403ff844370c` | ambiguous `execute` error | 未继续执行旧候选 | 当前 session error 返回的 candidate ID；候选清单可作为下一步 exact ID 输入 |

CLI endpoint identity 对 endpoint page-two ID 的 context、flow、callers、callees、affected 都接受 `node:<id>`。MCP endpoint follow-up 也保持 FPMS-NT revision，但 endpoint target 的 `repoId=null`。完整的“每个 ID × 五种 follow-up × all scopes”矩阵 `not proven`。

### Q7 — endpoint page two

- exact command：`penguin endpoints FPMS-NT --limit 3 --json`，然后以本轮返回 cursor 续 page 2、page 3。
- page 1：3 records，candidateCount 1541，returned 3，`totalIsExact=false`，truncated true。
- page 2：3 records，candidateCount 1538，returned 3，`totalIsExact=false`，truncated true；选用 `node_ec762949-fbcc-4387-aa8e-f1ba65f6d626`。
- page 3：3 records，candidateCount 1535，returned 3，`totalIsExact=false`，truncated true。
- defect：endpoint rows 无 endpoint repo 字段，handler 却分别带 `payment`、`proto`、`promotion` 等其他 repoId；MCP `knowledge_endpoints` input schema 是空 object，显式 repo 参数未形成可靠 scope。
- conclusion：`FAIL` for FPMS-NT scoped endpoint inventory；`PASS` for cursor page progression/non-duplicate page-two observation。全量耗尽 `not proven`。

### Q8 — endpoint identity forms

- exact command：`penguin endpoint-identity` 使用当前 page-two title、当前 canonical identity、当前 node ID，并分别测试 slash route 与错误 identity。
- passed forms：rendered title、`grpc::AccumulativeEventConfigAdminService.getaccumulativeeventconfigs`、`node_ec762949...`、`/AccumulativeEventConfigAdminService/GetAccumulativeEventConfigs` 均解析为同一 node，`equal=true`、`completeness=complete`。
- negative forms：`WrongService.WrongMethod` 和 `node_invalid` 返回 `status=no_match`、exit 1、`equal=false`、`completeness=unknown`。
- conclusion：`PASS`。错误形式没有被伪装成空的成功结果；当前 contract 支持 slash route。

### Q9 — endpoint → handler → service → data → tests

- exact tool：`knowledge_flow(target=node_ec762949..., repo=FPMS-NT)`，以及 context。
- raw evidence：endpoint → service `proto`，edge `via=handles`；`relatedTests=[]`；data/repository candidate、external call、unresolved edge 均未返回。
- evidence frontier：第一跳 endpoint → `proto` service；service → data 与 tests 是 `not proven`。
- completeness：partial/lower_bound，unresolved references 10；flow 不应被当作完整 runtime request trace。
- conclusion：`PARTIAL`，安全 memo 必须停在第一处 evidence frontier。

### Q10 — affected / change-preparation packet

- exact tool：`knowledge_affected(node=node_e61f3e22..., repo=FPMS-NT)`；CLI `penguin affected node:<id> --repo FPMS-NT --json`。
- raw evidence：target locator/revision 有；direct callers/callees、routes、tests 为空；`completeness=lower_bound`，coverageGaps 含 unresolved references。
- decision：`NO-GO`。revision 对齐且 fresh，但结果不是完整影响面，且关键 DI/interface/external boundary 未证明。

### Q11 — negative claims

| claim | query/result | completeness | verdict |
| --- | --- | --- | --- |
| symbol 没有 callers | `callers node_e61f3e22...` → empty，`resultStatus=no_static_edge`、`totalIsExact=true` | lower_bound；unresolved references 10；DI/dynamic dispatch caveat | `not proven` |
| endpoint 没有 handler | page-two endpoint context/flow 明确出现 `handles → proto` | partial/lower_bound；endpoint repoId null | `contradicted`（“没有 handler”被当前 evidence 反驳，但 handler 归属仍需人工确认） |
| symbol 未使用 | deadcode candidate / callers empty | deadcode 自己警告 DI、reflection、framework magic、dynamic import、public entry false positive | `not proven` |
| request 永远到不了 data boundary | flow 停在 endpoint → proto，无 data edge | lower_bound；external/DI/动态调用未证明 | `not proven` |

Global/scoped search 的空结果也返回 `NO_MATCH_INCOMPLETE`、coverage warning、`proofStatus=not_proven`，所以本轮没有将空数组升级成 proven absence。

### Q12 — stale/revision transparency

- exact command/tool：`status --json`、`coverage --repo FPMS-NT --json`、filesymbols、context、explore、flow。
- positive evidence：context/flow/explore 返回 aligned、fresh、indexed=head commit `3f0f1984...`、dirtyFileCount 0。
- inconsistent evidence：knowledge_search 返回 fallback_live/stale/legacy snapshot；empty query 也返回 `freshness.status=stale`，但 locator 是当前 exact worktree commit。
- stale case：没有制造 dirty state；未来应使用安全的预先存在 stale fixture，不得为了测试修改仓库。
- conclusion：`PARTIAL/FAIL` for cross-surface transparency；single context positive 可以带 exact commit 使用，search negative 不能直接信任。

### Q13 — provenance consistency

- confirmed-like evidence：search hit 的 source evidence `status=verified`，带 repo/path/line/revision。
- inferred/lower-bound evidence：callers/callees/flow 明确 `no_static_edge`、`lower_bound`、coverage gaps。
- external/unresolved：当前 symbol context 的 `externalCalls=[]`，不能解释成“无 external call”；unresolved reference count 为 10。
- suggestion/candidate：`deadcode` 返回 candidate 并明确是 verify lead；ambiguous execute 返回 candidate list。
- conclusion：`PARTIAL`。单个 surface 保留 provenance 较好，但不同 surface 没有稳定统一地返回 origin/method/confidence/unresolved reason；不能把空 externalCalls 提升为 confirmed none。

### Q14 — 三种分页 surface / 新进程续页

- endpoints：page 1→2→3 可续页，scope cursor 错误返回 `CURSOR_SCOPE_MISMATCH`，malformed 返回 `CURSOR_INVALID`；exhaustion 未完成。
- filesymbols：page 1 3 items、candidateCount 4、`totalIsExact=false`；page 2 1 item，`totalIsExact=true`、`nextCursor=null`。这是本轮唯一完整耗尽的 pagination surface。
- deadcode：page 1/2 均 3 items，candidateCount 5647→5644，`totalIsExact=true` 但仍 truncated 且有更多 cursor；未耗尽。
- cross-process：续页通过新 CLI invocation 完成，未依赖同一进程内存。
- errors：三种 surface malformed cursor 均结构化 `CURSOR_INVALID`、retryable false、exit 2；endpoint wrong-repo cursor 为 `CURSOR_SCOPE_MISMATCH`。
- conclusion：`PARTIAL`；不能声称三种 surface 全部通过 exhausted/wrong-scope/malformed/full continuation 矩阵。

### Q15 — structured errors

已执行：

```text
penguin context --json
penguin context node_invalid --repo FPMS-NT --json
penguin search "" --repo FPMS-NT --json
penguin search constructor --repo UNKNOWN-REPO --json
penguin filesymbols ... --cursor malformed-cursor --json
penguin deadcode --repo FPMS-NT --cursor malformed-cursor --json
penguin endpoints FPMS-NT --cursor malformed-cursor --json
```

证据：

- 缺 target：`INVALID_TARGET`，remediation 为传具体 symbol/endpoint/node。
- invalid node：`TARGET_NOT_FOUND`，带当前 FPMS-NT locator/revision 与 `penguin search` remediation。
- ambiguous symbol：`TARGET_AMBIGUOUS`，`execute` 返回 candidate node IDs 和 `specify --repo/--branch or exact node ID`。
- malformed cursor：`CURSOR_INVALID`，retryable false、exit 2。
- wrong scope cursor：`CURSOR_SCOPE_MISMATCH`，retryable false、exit 2。
- unknown repo：exit 2 的纯文本 `unknown repo: UNKNOWN-REPO`，没有 JSON error code。
- empty query：exit 0，但 `NO_MATCH_INCOMPLETE`、coverage warning、proofStatus not_proven，而非 invalid-parameter error。

结论：`PARTIAL`。大多数错误可指导下一步；unknown repo 和 empty query 的分类/结构化程度不足。

### Q16 — onboarding first-day memo

`onboarding FPMS-NT --json` 返回可复制顺序：status → coverage → scoped search → explore → affected → source review；还明确动态 dispatch、reflection、external service 与 runtime config 需要源码/runtime 验证。

它没有给出 endpoint page-two 的具体操作、cursor scope mismatch 的恢复示例，也没有显示 MCP unavailable fallback。因此首日 memo 可作为起点，不能单独覆盖 Round 17 的 page-two、handoff、MCP fallback 全要求。

结论：`PARTIAL`。

### Q17 — API doc read-only

- exact tool：`api_doc_list(limit=3)`。
- raw evidence：返回两个当前结果 ID：`preview:v1:0f638a...`（FrontendRegisterService）和 `preview:v1:bc5202...`（FrontendPlayerService），均 `mode=preview`、`coverage=exhaustive`，有 revisionSetHash、sectionHashes、createdAt/updatedAt。
- show/diff：本轮没有继续 show；虽然列表存在两个对象，但它们不是同一 API identity 的两个版本，不能擅自执行 version diff。
- write boundary：没有 generate/bind/sync/repair/export。
- conclusion：`PARTIAL`。列表质量字段可见；API JSON/Markdown source locator、revision stale 状态的 show readback `not proven`。

### Q18 — Wiki/Knowledge boundary

- `knowledge.note_list(limit=3)`：错误 `ERR_MODULE_NOT_FOUND`，缺少 `@penguin/knowledge-indexer`，retryable false。
- `knowledge_memory_recall(repo_id=FPMS-NT repoId)`：`items=[]`，不能证明没有 memory。
- `knowledge_tag_list(limit=3)`：`items=[]`，不能证明没有 tags。
- link-list MCP tool：当前暴露工具中没有 `knowledge_link_list`，虽然 capability manifest 宣称 `knowledge.link.list implemented`；因此 surface unavailable/not proven。
- `api_doc_list`：两个 immutable preview 元数据对象可读。

结论：`FAIL` for complete Wiki/Knowledge audit；当前只能证明部分可查阅的 API preview 能力，不能证明 notes/memory/tags/links 的完整性、权限、backlink 或 stale separation。

### Q19 — Agent A → Agent B handoff

本轮生成了可交接的 current values：FPMS-NT/brazil-v2/commit `3f0f1984...`、symbol `node_e61f3e22...`、endpoint `node_ec762949...`、filesymbols page-2 `node_3385190d...`、cursor error `CURSOR_INVALID`/`CURSOR_SCOPE_MISMATCH`。

但没有完全退出 Agent A、启动独立 Agent B 并只交给 handoff；当前 host 没有可验证的 MCP session lifecycle/process ID。因此跨 session ID/cursor/reload continuity：`not proven`。

结论：`FAIL` against fresh handoff gate。

### Q20 — installed vs loaded

- new/current MCP health：running and available build same，`clientRestartRequired=false`，`runtimeOutdated=false`。
- stable CLI：launcher path 与 CLI build 已确认。
- new MCP sessions：当前工具调用未提供独立 session ID，也未能在本题内创建两个可审计的新 MCP initialize session。
- old MCP reload：`not proven`；不能以 `MCP Ready`、app version 或 capability hash 单独替代 process generation evidence。
- CLI/MCP knowledge revision：context/flow 都可返回当前 exact commit；search surface 仍出现 fallback_live/stale/legacy mismatch。

结论：`PARTIAL` for runtime visibility；第 3–5 项不能声称通过。

## 4. B1–B8

### B1 — 冷启动 gRPC 调查

可执行边界：onboarding → status/coverage → scoped endpoint discovery → page-two ID → context/flow。实际 page-two endpoint 为 `node_ec762949...`，flow 只证明 endpoint → `proto` service。evidence frontier 在 service/data 之间；coverage 为 3333 admitted、7 excluded、10 unresolved references；dynamic dispatch、external calls、tests 和 data reachability `not proven`。由于当前非 fresh，B1 不是完整冷启动 pass。

### B2 — 安全改动准备

symbol `node_e61f3e22...` 的 context、callers、callees、flow、affected 已执行。locator/revision 对齐且 fresh，但 caller/callee/affected 是 lower bound，tests/routes 为空且 unresolved references 存在。最终 `NO-GO`，必须人工 source review 后再决定。

### B3 — 负面审计

已按 Q11 执行 symbol 和 endpoint 的 empty/no-static-edge/deadcode/flow 边界。所有 absence claim 均带 coverage/completeness/unresolved caveat；只有“endpoint 没有 handler”被实际 flow 的 `handles → proto` 反驳。没有把空 arrays 当作 proof。

### B4 — 分页工作队列

endpoints、filesymbols、deadcode 都完成 page-one 到后续 page 的新 CLI invocation。filesymbols 已安全 exhausted；endpoint/deadcode 仍有 cursor。malformed cursor 和 endpoint wrong-scope cursor 已测试。Agent B 独立 session replay 未证明。

### B5 — CLI/MCP 降级报告

CLI 的 search/filesymbols/context/flow/endpoint/invalid-cursor 链路可运行；MCP health/capability/search/context/flow 可运行，但 `knowledge_endpoints` scope schema 为空，note list 缺 runtime module。产品能力与环境可用性分开计分：产品 60/90，环境 6/10；MCP 局部故障没有被混成整个产品故障。

### B6 — API doc 与 Knowledge 只读浏览

已 list API previews、读取 notes/memory/tags 的只读 surface 状态；没有任何 write。API preview 可列但未 show；note list module-not-found；memory/tag empty 不证明 absence；link list unavailable。B6 `PARTIAL/FAIL`。

### B7 — 两代 runtime 连续性

CLI/MCP 当前 build/hash/schema 一致，running/available generation 一致；但没有两个独立 MCP session、process ID、reload evidence，也不能证明旧进程已经加载同一 generation。B7 `not proven`。

### B8 — final decision packet

```text
PRODUCT: NO-GO
ENVIRONMENT: DEGRADED
SAFE WITHOUT SOURCE:
- help/capabilities/status/coverage/onboarding discovery
- scoped symbol search 到当前 node ID
- context/flow 的 bounded navigation
- endpoint identity 四种已支持形式的 round-trip
- filesymbols 完整文件分页（本轮目标文件）
- structured invalid-target / ambiguous / cursor recovery

REQUIRES SOURCE/HUMAN:
- 业务语义、data reachability、runtime request trace
- DI/reflection/dynamic dispatch/external call 完整性
- deadcode 删除决定
- endpoint handler 跨 repo 归属解释
- 任何安全改动 GO

UNPROVEN CLAIMS:
- 当前对话是否满足 fresh session
- 两个新 MCP session 的 parity/reload
- endpoint/deadcode 全量 cursor exhaustiveness
- empty callers/externalCalls 等于没有关系
- API docs 的 show-level source/revision/stale correctness
- Wiki notes/memory/tags/links 的完整性与权限边界

TOP 5 FIXES:
1. 让 endpoints 的 repo/branch/revision scope 成为强制且可验证字段，并阻止跨 repo handler 串入结果。
2. 统一 search 与 context/flow 的 revision/freshness/trust envelope，禁止 legacy fallback 被表现为可比的 fresh fact。
3. 为 CLI/MCP 暴露可审计的 initialize/tools-list/session/generation/reload evidence，并提供真正跨进程 handoff 测试。
4. 为 endpoints/deadcode 提供可安全取得的 exhausted cursor/total exactness contract，保留 wrong-scope 与 malformed 错误。
5. 修复 note-list 的 `@penguin/knowledge-indexer` runtime dependency，并补齐 link-list/API-doc show 的只读 parity 与 provenance 字段。

RETEST COMMANDS:
- penguin help --json
- penguin capabilities --json
- penguin status --json
- penguin coverage --repo FPMS-NT --json
- penguin onboarding FPMS-NT --json
- penguin endpoints FPMS-NT --limit 3 --json
- penguin filesymbols FPMS-NT brazil-v2 <current-path> --limit 3 --json
- penguin deadcode --repo FPMS-NT --limit 3 --json
- penguin endpoint-identity <fresh-title> <fresh-canonical> <fresh-node-id> --json
- initialize → tools/list → mcp_health → knowledge_capabilities → knowledge_search（在两个真正新的 MCP session 中分别执行）
```

## 5. 证据表

| ID/target | 由哪条结果发出 | follow-up | scope/revision | completeness | evidence state | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `node_e61f3e22-edd0-47e8-bebc-bb0e46985dd3` | `search PaymentExternalService` / filesymbols | `context`, `callers`, `callees`, `flow`, `affected`, `explore` | FPMS-NT / brazil-v2 / `3f0f1984...` | lower_bound/partial; unresolved 10 | confirmed locator; relation lower bound | 可导航，不能证明完整 callers/data |
| `node_3385190d-6ca3-44d2-8115-d97e9df5e915` | filesymbols page 2 | symbol follow-up 可用 | FPMS-NT / brazil-v2 / same commit | page exhausted, total exact | confirmed path/line | PASS for filesymbol page-two |
| `node_ec762949-fbcc-4387-aa8e-f1ba65f6d626` | endpoints page 2 | endpoint identity/context/flow/affected | endpoint row repo missing; follow-up resolves FPMS-NT revision | partial/lower_bound | identity confirmed; handler scope suspect | FAIL for trusted FPMS-NT endpoint inventory |
| endpoint cursor | endpoints page 1 | page 2/page 3/new CLI invocation | cursor scope `FPMS-NT|*`; revision null in token | `totalIsExact=false` | cursor accepted; wrong scope rejected | PARTIAL |
| deadcode cursor | `deadcode --repo FPMS-NT` page 1 | page 2/new CLI invocation | FPMS-NT; branch id in response | candidate list, truncated | candidate only; false-positive warning | PARTIAL |
| `node_422c6ba6-0fcf-4f4a-a4df-403ff844370c` | ambiguous `execute` error | exact node retry is available | FPMS-NT / current revision in error envelope | ambiguous candidate list | candidate, not selected target | PASS for ambiguity guidance |

## 6. 产品缺陷与评估环境缺陷

### 产品侧

- endpoint capability 的 input schema 为空，repo scope 未形成强约束；返回 handler 可跨 repo，endpoint 自身 `repoId=null`。
- search 与 context/flow 对同一 FPMS-NT revision 返回不同 trust/freshness 表述。
- relation empty 输出虽有 lower-bound/no-static-edge，但不同 surface 的 unresolved scope 信息不一致。
- unknown repository 仍返回非 JSON 纯文本错误；empty query 以成功退出码返回 no-match-incomplete。
- capability manifest 宣称 link-list/note-list 等能力 implemented，但当前 MCP tool surface 缺 link-list，note-list 遇 runtime module-not-found。

### 评估环境侧

- 当前 Codex 对话不是可证明的 fresh session。
- host 没有为本次调用提供可审计 MCP session ID、原始 initialize/tools/list 或旧进程 reload 证据。
- 本轮没有安全制造 stale fixture，也没有冒险修改仓库来制造它。
- endpoint/deadcode 全量耗尽成本高，且当前没有合法 emitted exhausted cursor 可供测试；因此未把 partial continuation 记作 full pass。

## 7. 使用建议

Penguin 当前适合：新 session onboarding、带 scope 的正向 symbol/path 定位、bounded context/flow、endpoint identity 解析、带 honesty envelope 的第一轮影响面调查，以及把后续 source review 清单化。

在上述产品缺陷和 fresh/reload 证据缺失修复前，不适合被 Claude/Codex 当作完整 CodeGraph、完整 runtime trace、可靠 negative-proof engine、自动 deadcode 删除依据或跨 session handoff 的唯一事实源。
