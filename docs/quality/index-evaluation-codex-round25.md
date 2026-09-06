# Penguin Knowledge 独立黑盒评估 — Codex Round 25

## 0. 结论摘要

- **评估者 / 模型**：独立 Codex 评估进程（Codex，Round 25）。
- **产品路径**：读取 brief 后，只使用当前进程注册的 Penguin MCP；未读取源码、Git、SQLite、计划、bundle、旧报告或其他索引产品，未调用 Penguin CLI，未修改产品、索引、配置或语义任务。
- **唯一写入**：本报告。
- **总分**：**86 / 100**。
- **最终结论**：**NO-GO**。
- **决定性原因**：Q19 在 Second Repo 上重复同一 5 词 bounded lexical query 时，单次调用达到 `30005 ms` 且未返回，触发“multi-term bounded search exceeds 30 seconds” hard gate。另有 Q15 的 `knowledge_repository_register`、`knowledge_index`、`knowledge_rebuild` 三个 `confirmed:false` 负向验证均达到 `30005 ms`，MCP-only owner remediation 的实际负向行为为 `BLOCKED`。
- **最安全用途**：在已知 fresh revision scope 内，使用 exact/source/graph、stable node ID、context/flow/affected 和带 caveat 的 semantic discovery 做工程调查。
- **最不安全声明**：不能声称跨仓库 bounded search 都稳定小于 30 秒；不能把 `NO_MATCH_INCOMPLETE` 当作全局不存在；不能声称 MCP owner remediation 已可可靠执行；不能把 84,024 个 unresolved references 下的图视为完整调用图。

## 1. Fresh-process proof 与证据边界

本进程首先且只读取 `index-evaluation-brief-round25.md`，随后动态读取当前 MCP registration/capability metadata 并调用 Penguin MCP。所有 repo、branch、snapshot、node、endpoint、generation 和 cursor 均来自本次响应。

Fresh session 证据：

- `sessionId`: `bb738096-643d-481a-9f6e-1b1d60fcdceb`
- `clientConnectedAt`: `2026-08-31T18:57:12.912Z`
- `appVersion`: `1.16.0`
- running/available build: `1.16.0-4ce2ad966d8ea3cf` / `1.16.0-4ce2ad966d8ea3cf`
- `restartRequired=false`, `clientRestartRequired=false`, `runtimeOutdated=false`
- schema / contract / hash: `18` / `2` / `096b7a0e818e7296d76c6668c985305ffafa9c0c0cb31e2369b7ed8c3785ea7b`
- `configured=true`, `launcherHealthy=true`, `initializeHealthy=true`, final health 仍为 `status=ok`
- query runtime: 2 workers，hard timeout 30,000 ms

直接 MCP 证据与推断的约定：文中“证明/返回/显示”为 MCP 直接证据；“推断”会明确标注。任何未被 MCP 直接支持的结论标为 `UNPROVEN`、`PARTIAL`、`BLOCKED` 或 `N/A`。

## 2. 动态目标选择

| Target | 本次动态选择 | MCP discovery path |
| --- | --- | --- |
| Largest Repo | `FPMS-NT`, repo `repo_a48ec7fb-5987-47df-9198-06969359cb50` | `status_panel`：admitted 3333，为当前最大；branch `brazil-v2`，snapshot `snapshot_5225df3e-18e3-44ab-9cc2-dc0dae37ee55` |
| Second Repo | `FPMS`, repo `repo_52c3c449-1317-49b1-aff0-2540ea7a28e5` | `status_panel`：admitted 3098，为不同仓库且次高 |
| Natural Intent | `create player growth task configuration` | 由 Largest Repo 当前 endpoint/architecture 和随后 lexical MCP 命中动态形成；5 个词，命中显示词分布在 identifier、path 和邻近 source 中 |
| Primary Symbol | `createTaskConfig`, node `node_03484475-c2e8-4da2-857e-47af74bb8f74` | repo-scoped exact search 首位 symbol；随后 `get_node` round trip |
| Relation-rich Symbol | 同 Primary Symbol | context candidate total 8，跨 `calls`、`usesTypes`、`routes`、`errors`、`importers`、`externalCalls` 六类 |
| Primary File | `apps/promotion/src/modules/growth-task/controllers/admin-growth-task.controller.ts` | exact search locator 与 `get_node` identityKey |
| Primary Endpoint | `gRPC AdminGrowthTaskController.CreateTaskConfig`, node `node_b532eeda-cac4-46bc-9f1d-00d0d0135960` | repo-scoped endpoint page 1；handled 且 flow 有下游 hops |
| Service Pair | `FPMS-NT` → `FPMS-NT-Payment` | repo-scoped `knowledge_service_graph` 返回 `invokes` edge，proven/parser/EXTRACTED/confidence 1 |

## 3. Required scenarios Q1–Q20

### Q1 — Installed fresh-session identity — PASS

`mcp_health`、capabilities、semantic status、bounded search 的 session/contract surface 一致。初始及最终 health 均为 build `1.16.0-4ce2ad966d8ea3cf`，无 restart；capabilities 同 build/schema/contract/hash。semantic active generation 绑定 Largest Repo 当前 snapshot。bounded exact query `createTaskConfig` 返回同一 revision。configured、loaded、healthy、useful 分别被配置状态、initialize/launcher、health、实际 query 命中证明。未发现 old/new runtime mixture。

### Q2 — Capability-to-tool truth audit — PARTIAL PASS

当前 MCP-native mapping：

| Concept | Canonical MCP operation | 说明/alias |
| --- | --- | --- |
| Architecture | `knowledge.architecture` | wire `knowledge_architecture`; alias `get_architecture` |
| Repository inventory/freshness | `knowledge.index_status`, `knowledge.status_panel` | `index_status` 是 alias；status panel 返回 coverage counts |
| Service inventory/relations | `knowledge.service_graph` | repo-scoped 或 global |
| Exact/lexical/hybrid/semantic search | `knowledge.search` | 同一 schema，以 `mode` 与 nested `options.semantic` 区分 |
| Node | `knowledge.get_node` | alias `get_node` |
| Context | `knowledge.context` | cursor advertised/accepted |
| Flow | `knowledge.flow` | 无 cursor claim |
| Affected | `knowledge.affected` | 无 cursor claim；schema 也无 cursor/depth/limit |
| Endpoint inventory | `knowledge.endpoints` | cursor + compact |
| Coverage | `knowledge.coverage` | cursor；kind = excluded/failed/stale/unresolved |
| Semantic status/control | `knowledge.semantic_status`, `knowledge.semantic_control` | control mutating + confirmation required |
| Dead code | `knowledge.dead_code` | alias `find_dead_code`; cursor + compact |
| Onboarding | `knowledge.onboarding.generate` | current capability examples |
| Repository register/index/rebuild | `knowledge.repository.register`, `knowledge.index`, `knowledge.rebuild` | mutating + confirmation required |
| Files/file symbols | `knowledge.files`, `knowledge.file_symbols` | cursor |
| Saved query | `knowledge.saved_query.list/run` | run advertises cursor；本次 list 为空 |

101 capabilities 与 101 registrations 均被 manifest 标为 implemented。相关 schemas 的 cursor、nested search shape 和 mutation confirmation 与实际 data-bearing calls 一致。缺陷是 registration 仅明确 `mutating` 和 `confirmation`，没有显式 destructive/idempotent/read-only annotation；register/index/rebuild 仅要求 `confirmed`，`root_path/path` 在 schema 层不是 required。三项负向行为测试全部超时，因此 callable truth 不能判为完整通过。

### Q3 — Largest-repository selection and count semantics — PARTIAL

Largest Repo 由 `status_panel` 的 admitted count 动态选出：FPMS-NT 3333，第二名 FPMS 3098。FPMS-NT `knowledge_files(limit=2)` 返回：page length=2、`returnedCount=2`、global `candidateCount=3298`、`remainingCount=3296`、`totalIsExact=true`、`truncated=true`、有 next cursor；第二页同样 2 项且无 overlap。

`status_panel.coverage.admitted=3333` 与 file inventory global candidate 3298 相差 35，响应没有解释是否为非 source/admitted metadata 分类差异，因此 reconciliation 为 `UNPROVEN`。page-local 数字是 page length/returnedCount；global 数字是 candidate/remaining 与 status headline。此 count-semantics 缺口降低评分。

### Q4 — Non-adjacent multi-term business search — PASS（Largest Repo）

Natural Intent 为 `create player growth task configuration`。相同 repo/snapshot/scope/options/limit 的 lexical call 连续运行两次：两次均 `MATCH`、candidate 954、returned 8、truncated、totalIsExact=false；wall time 均约 5348 ms，MCP self timing 5106.592/5106.465 ms；两次 top 8 hit IDs 完全稳定。

Top evidence 依次覆盖 promotion scheduler interface、growth-task cron/service/processor、constants、controller、module、test 与 consumer；首位 `PlayerMissionProgress` 覆盖 4/5 intent terms。相关业务 source 排在前，单个 README 未占页。响应没有独立 `rootCount/evidenceCount` 字段，故这两项为 `UNPROVEN`；可直接记录的是 candidate 954 / returned evidence roots 8。warning 为 `COVERAGE_INCOMPLETE`；semantic requested=false/applied=false/reason=`not_requested`。

### Q5 — Exact, lexical, semantic discovery comparison — PARTIAL

- Exact `createTaskConfig`: candidate 7/returned 7，symbol lane 首个 canonical symbol 命中 node `node_0348…`，source lane 同文件；约 9235 ms wall（MCP total 3729 ms）。
- Lexical `create growth task configuration`: candidate 830/returned 8；controller 文件在第 5 位，但 returned symbol 是 controller class，不是 Primary Symbol；约 7092 ms wall（MCP total 1587 ms）。
- Semantic paraphrase `provision a new promotional task setup`: requested/applied=true，active generation `generation_5c02…`；top 为 growth-task cron spec、reward service、user-task service，`task-config.service.ts` 第 6；Primary Symbol 未在 top 8，约 12941 ms wall。

三者都保持同 repo/snapshot。Exact/source govern identity and call direction；semantic results 明确标为 inference/vector recall candidate，不能证明执行、ownership 或 call direction。Semantic 帮助找到业务邻域，但没有直接恢复 Primary Symbol，因此为 PARTIAL。

### Q6 — Semantic generation and model identity — PASS

semantic status 至少三次、间隔远大于 5 秒，Largest Repo 状态稳定：恰有一个 compatible complete active generation：

- scope `repo:repo_a48ec7fb-5987-47df-9198-06969359cb50`
- generation `generation_5c026dc4ef2ab3a3c43641d4ee1c1cea37e9c81c37ac440f`
- snapshot `snapshot_5225df3e-18e3-44ab-9cc2-dc0dae37ee55`
- provider/model/model hash: `local` / `nomic-ai/nomic-embed-text-v1.5` / `00646f…c32c`
- weights/tokenizer/preprocessing digests 全量返回
- pooling `mean`，normalization `l2`，dimensions 768，chunker `semantic-chunker-v6-precision`
- expected=ready=45007；pending/running/retryableFailed/terminalFailed 均 0；progress 100%
- paused/pauseRequested=false；lease inactive；rate/ETA/heartbeat/workerBuild 为 null（无进行中工作）

三个同 scope 历史 generation 与一个 legacy generation 均为 superseded，pending/running/failed 均 0，不膨胀 active counters。

### Q7 — Hybrid evidence honesty — PASS

Hybrid call 使用 nested `options.semantic="blend"`，diagnostics 为 requested=true/applied=true，lanes source/symbol/vector，active generation `generation_5c02…`。top useful result仍为 verified source occurrence `PlayerMissionProgress`，rank reason 以 lexical business-term coverage + RRF 为主。单独 semantic page 的 vector hit 都显示 persisted vector similarity、embeddingSpaceId/chunkId、evidence status inference，并明确“vector is a recall candidate; exact/source lanes retain truth precedence”。证据分层诚实。

### Q8 — Global context cursor across relation families — PASS

Relation-rich Symbol context `limit=2` 的四页 union：

1. page 1：2 calls — `TaskConfigService.create`, `decodeTaskConfig`
2. page 2：2 usesTypes — `LarkJwtUser`, `AdminTaskConfigDto`
3. page 3：1 route + 1 error — gRPC CreateTaskConfig, `RpcException`
4. page 4：1 importer + 1 external call — growth-task module, `@nestjs/microservices.Payload`

每页全局总数均不超过 2；candidate total 8；四页 8 个 item 无重复、无 scope/revision drift；cursor offsets 2→4→6→exhaust，最后 cursor=null、truncated families 为空。definitions 由 target locator 给出；direct callers/tests 为 0，calls/types/route/error/importer/external 均按 family 重建。排序稳定且正确耗尽。

### Q9 — Cursor capability claim versus implementation — PASS FOR DATA-BEARING FAMILIES

Manifest advertises cursor 的 operations：search、coverage、context、files、file_symbols、endpoints、dead_code、note.list、saved_query.run。所有 schema 都实际含 cursor。

- search/files/context/endpoints/coverage/dead_code/file_symbols 均取得 fresh cursor 并成功继续；无 overlap/scope drift。
- affected 未宣称 cursor，schema 无 cursor，诚实 non-support。
- note.list 本次 candidate=0，未产生 cursor；saved query list 为空，run 无可用 saved query，均为 `N/A_NO_FRESH_CURSOR_AVAILABLE`，不是 handler failure。

### Q10 — Stable identity round trip — PASS

Search → `get_node` → context → affected(node) → exact search again 全部接受 fresh node `node_0348…`。identityKey 始终为 `repo_a48…::apps/promotion/...admin-growth-task.controller.ts::AdminGrowthTaskController.createTaskConfig`；repo、branch `brazil-v2`、snapshot、path、kind method、title 一致。Endpoint node `node_b532…` 也被 `get_node` 成功接受；其 canonical identity 为 `grpc::AdminGrowthTaskController.createtaskconfig`。

### Q11 — Endpoint pagination and transport-to-boundary flow — PASS WITH LOWER-BOUND CAVEAT

Endpoint limit 2 连续三页返回 6 个不同 IDs，无 overlap、repeated cursor 或 scope drift；global candidate 608，totalIsExact=true，页仍 truncated。

Primary flow 的直接 proven hops：

`gRPC CreateTaskConfig` →(handles) `createTaskConfig` →(calls) `TaskConfigService.create` / `decodeTaskConfig` → validator/cohort/reward helpers → repository calls，包括 `free-spin-config-repository.create`、`task-config.repository.updateBiFields`、`task-user-target-list.repository.bulkUpsertValidTickets` → base repository `bulkWrite/find`。

直接 graph evidence 为 EXTRACTED/proven；flow 另有 references/throws，不能当执行 hop。flow returned 60，未 truncated，但 overall completeness=partial、proofStatus=not_proven，且 coverage unresolved 84,024；因此 transport-to-persistence boundary 已被证明为一条可用链，不能声称路径穷尽。

### Q12 — File/node affected and test-evidence parity — PASS WITH CAVEAT

Affected schema 不接受 depth/limit/cursor，所以在相同 repo/branch/snapshot、允许字段范围内分别用 Primary File 与 stable node 调用。两者结果一致：files=1，changed sibling symbols=12，impacted=0，impactEdges=0，tests=0，routes=10，candidate/returned=12，totalIsExact=false，completeness=lower_bound。

Context direct tests 同为 0；flow 的 deeper relatedTests 返回 8 个测试文件，但只能证明深层 flow 邻域存在测试，不能证明 Primary Symbol direct coverage。没有从 filename 推断覆盖。

### Q13 — Concrete coverage-debt reconciliation — PASS FOR PAGING, FAIL FOR COMPLETENESS

FPMS-NT aggregate：discovered 3340、admitted 3333、excluded 7、failed 0、stale 0、unresolved 84024。Excluded limit 10 一页完整返回 7 个（secret/binary）；failed/stale 均 exact zero。Unresolved limit 2 连续三页成功，items 包括 no_enclosing_symbol 与 external_package，global candidate 84024、totalIsExact=true、remaining 正确递减。

Unresolved reconciliation 为 `status=reconciled`、revision=current snapshot、itemCount=aggregateUnresolved=84024、delta=0。具体 debt 可分页且 aggregate/detail 对齐，但总体 completeness=lower_bound、coverage status=partial，故完整性结论必须否定。

### Q14 — Package-cache corpus hygiene — PASS FOR CURRENT ADMITTED EVIDENCE ONLY

Largest Repo path search：`.pnpm-store`、`.yarn/cache`、`.yarn/unplugged`、`.bun/install/cache` 均 0；`.npm` 唯一命中是 repo root `.npmrc`，不是 `.npm` cache directory。全部 7 个 excluded records 也无 package cache path。没有 cache file 被当作 current source evidence。

安全结论仅为：在当前 fresh snapshot 的 admitted path lane 与完整 7-item excluded detail 中，没有看到指定 cache directory；由于 search 返回 `NO_MATCH_INCOMPLETE`、coverage 有 84,024 unresolved references，不能声称 owner filesystem 或所有仓库普遍不存在这些目录。

### Q15 — MCP-native owner remediation discoverability — BLOCKED

Schemas/manifest 可发现 register/index/rebuild；三者均 mutating=true、confirmation=required，输入提供 owner-local absolute `root_path` 与 compatibility `path`、`confirmed`。但 schema 只 required `confirmed`，未 required root/path；未显式说明 destructive、idempotent 或 read-only annotations。

按 brief 仅执行非 mutating negative validation：`root_path=/round25/unknown/out-of-scope` 且 `confirmed=false`。register/index/rebuild 三次均在 30005 ms 超时，无 typed validation response，未进行 fallback，也未确认任何 mutation。故实际 MCP-only remediation behavior 为 `BLOCKED`。不能声称它必须使用 CLI，但也不能声称 MCP remediation 已可靠可用。

### Q16 — Cursor error taxonomy and root remediation — PARTIAL PASS

Fresh cursor families 超过四类，valid continuation 均通过。把 context cursor 用到 files：`CURSOR_OPERATION_MISMATCH`，remediation 为从相同 repo/revision scope 重启 file pagination。篡改 search cursor 最后一字符：`CURSOR_INVALID`，remediation 为用相同 scope/query/mode/options/limit 重启。两类错误 distinct。

Boundary errors：unknown repo=`SCOPE_NOT_FOUND`（建议“specify a registered repository”）；unknown branch=`BRANCH_NOT_FOUND`（建议 `index_status` + indexed branch）；unknown node=`INVALID_TARGET`（无 remediation）；unknown endpoint=`INVALID_TARGET`（建议 `knowledge_search` 找 current stable ID）。Unknown repo 没直接指向 `knowledge_repository_register`，且 Q15 negative validation 超时，因此 root remediation quality 仅 PARTIAL。

### Q17 — Compact output fixed-point truth — PASS

Endpoint normal/compact 均保留相同 2 个 canonical IDs、candidate 608、returned 2、remaining 606、total exact/truncated semantics。reported `9990→5912`, ratio 0.592；对接收的 structured representation 重新计算 UTF-8 JSON size 为 `10020→5943`, ratio 0.593。

Dead-code normal/compact 均保留相同 3 个 canonical IDs、candidate 5650、returned 3、remaining 5647。reported `4118→2547`, ratio 0.619；重算为 `4149→2578`, ratio 0.621。

约 30–31 bytes 差异来自接收 envelope/serialization 与 stats 字段本身的 fixed-point boundary；产品没有把 self-referential size 声称为接收后 representation 的绝对精确值，而字段名是 estimate/sent boundary。compact 没改变含义或非零 counts。

### Q18 — Bounded mixed-call responsiveness — PASS FOR LARGEST REPO

Largest Repo mixed sequence在 per-call 30s 内：search 5.348s、context 9.286s、flow 20.598s、affected 9.462s、service graph 0.675s；interleaved semantic status 4.178s。lexical search semantic=off，不等待 embeddings；semantic status active complete。Largest Repo 5-term query 没出现 per-term full-corpus timeout。Q19 的 Second Repo 超时单独构成 hard-gate failure。

### Q19 — Scope and negative-proof matrix — FAIL

Largest Repo query scoped correctly且无 leakage。Second Repo 使用其本次 MCP 提供的 repo/branch/snapshot 重复同一 query，30005 ms 未返回，故跨仓库 scope comparison `BLOCKED` 并触发 hard gate。

Unknown repo/branch/node/endpoint、wrong-family/tampered cursor 均返回 boundary-specific typed errors（unknown node remediation 除外）。最强安全负向结论：仅能说“在指定 fresh revision 的 admitted、已返回且未被 pagination 截断的搜索范围内无 verified match”；必须保留 excluded/failed/stale、84,024 unresolved、truncation、totalIsExact=false 和 revision trust caveats。

### Q20 — First-user onboarding and MCP handoff — PASS WITH DOCUMENTATION CAVEAT

Onboarding 用当前 capability/alias：`index_status`、`knowledge_coverage`、`knowledge_semantic_status`、nested `knowledge_search` scope/options/page、`knowledge_explore`、`knowledge_affected`、`get_node`。明确 stable nodeId/identityKey、cursor continuation、negative/partial/lower_bound/stale 检查以及“不需要 shell/CLI”。它另列 owner optional CLI 和最终 Source Review，容易让 MCP-only 用户偏离边界，但被标为 optional。

Agent A handoff（仅 MCP emitted data）：repo ID、branch、snapshot、Primary node ID/identityKey、Primary File、context cursor、coverage partial/unresolved=84024 caveat。Agent B 不重新发现目标，直接用相同 target/scope/limit + cursor，成功得到 page 2 `LarkJwtUser` 与 `AdminTaskConfigDto`，证明 handoff continuation 可用。

## 4. Bonus scenarios B1–B8

### B1 — Cross-service relationship — PASS

`FPMS-NT` → `FPMS-NT-Payment` 是 `invokes`，evidenceState=proven、origin=parser、method=EXTRACTED、confidence=1，provenance path 为 `apps/admin/inteceptor/payment-external.service.ts`。它证明静态抽取的 invocation relationship；不证明 runtime availability、频率或 ownership。

### B2 — Minimal safe-change plan — PASS

最小安全计划：只修改 Primary File 中 `createTaskConfig`；同时检查同文件 11 个 sibling symbols 和 10 个 gRPC routes 的 shared-controller risk；验证 direct calls `decodeTaskConfig` 与 `TaskConfigService.create`；重点覆盖 validator、cohort/reward、repository bulk-write boundary；执行 flow 返回的 related tests，但不把它们当 direct coverage；变更后重新查询 affected/context/flow，并核对 coverage unresolved 84,024 与 current revision。Proven blast radius 是 controller siblings/routes 与已抽取 hops；lower-bound risk 是 dynamic dispatch、external package、callback/constructor/static calls 和 unresolved references。

### B3 — Retrieval disagreement — PASS

Exact 直接把 `createTaskConfig` 排为 canonical symbol 第一；semantic paraphrase top 8 没有 Primary Symbol，只把 `task-config.service.ts` 排第 6，top 1 是 cron spec。事实声明服从 exact/source/graph；semantic 仍可用于发现 growth-task 相关 service/test 邻域。

### B4 — Historical generation hygiene — PASS

三个旧 nomic generation 和 legacy generation 均 superseded，activeGenerationId 指向唯一 current active 或为 null；pending/running/failed 均 0，不污染 active expected/ready=45007。

### B5 — Pause/resume discoverability — PASS/PARTIAL

`knowledge_semantic_control` schema 完整列出 pause/resume/retry/cancel；scopeKey required；retry/cancel require generationId，pause/resume 禁止 generationId；manifest 标 mutating + confirmation required。当前 active complete、not paused、无 pending/running/retryable work：Resume 明显不适用；Retry/Cancel 没有可证明的 retryable/staging target；Pause 可发现但当前无工作可暂停，其有效性未调用验证。

### B6 — Fresh MCP cold-start behavior — UNPROVEN

Fresh MCP initializeHealthy，semantic active complete，但当前 pending/running=0、lease inactive、workerBuildId/heartbeat null。没有 current queued work 可证明 MCP process 能在无 Tauri 时唤醒队列；不得从健康状态推断实际 wake behavior。

### B7 — Remediation quality — PARTIAL

1. `COVERAGE_INCOMPLETE`：给出 `knowledge_coverage` 和 owner `knowledge_index` next action，MCP-only 可发现但 index negative behavior 超时。
2. wrong cursor：明确相同 scope/query/options/limit 重启，优秀。
3. unknown branch：明确 `index_status` 后用 indexed branch，优秀。
4. unknown repo：只说 specify registered repository，未指向 MCP register；unknown node 无 remediation。

首次 MCP-only 用户可处理 cursor/branch，coverage/root remediation 不够可靠。

### B8 — Readiness verdict

| Dimension | Verdict | Basis |
| --- | --- | --- |
| Exact/graph investigation | GO with lower-bound caveat | stable exact identity、context/flow/affected 可用 |
| Semantic discovery | GO | 唯一 compatible complete active generation；honest provenance |
| Runtime reliability | CONDITIONAL GO | build identity稳定，但 Second Repo query 与 remediation validation 超时 |
| Coverage completeness | NO-GO for completeness claims | 84,024 unresolved，coverage partial/lower_bound |
| Identity/continuation stability | GO | stable node/endpoint round trip；data-bearing cursor families通过 |
| Owner-only Tauri UX | N/A | 无 owner evidence |

## 5. Required tables

### Runtime surface

| Runtime surface | Session/build/schema/contract/hash | Configured | Loaded | Useful | Restart required | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Penguin MCP | session `bb738096…`; build `1.16.0-4ce2…`; 18/2/`096b…` | true | initialize/launcher healthy | exact/graph/semantic queries returned | false | PASS |
| Semantic Largest Repo | active `generation_5c02…`; snapshot `snapshot_5225…` | model bundled/ready | active 45007/45007 | semantic query applied | false | PASS |
| Cross-repo/remediation runtime | same session/build | true | tools registered | Second Repo query及三 remediation negatives超时 | false | FAIL |

### Retrieval

| Retrieval mode/query | Root/evidence counts | Requested/applied/generation | Top stable identities | Warnings | Timing |
| --- | --- | --- | --- | --- | --- |
| lexical Natural Intent run 1 | candidate 954; returned 8; root/evidence fields absent | false/false; active ID disclosed | `node_bb939…`, `node_ea174…` | COVERAGE_INCOMPLETE | 5.348s wall |
| lexical Natural Intent run 2 | same 954/8; same top 8 hit IDs | false/false | same identities | same | 5.348s wall |
| exact `createTaskConfig` | 7/7 | false/false | `node_034844…` rank 1 symbol | COVERAGE_INCOMPLETE | 9.235s wall; MCP 3.729s |
| lexical description | 830/8 | false/false | controller `node_8ae3…` rank 5 occurrence | COVERAGE_INCOMPLETE | 7.092s wall |
| semantic paraphrase | 50/8 | true/true/`generation_5c02…` | vector chunks; no Primary Symbol top 8 | COVERAGE_INCOMPLETE | 12.941s wall |
| hybrid Natural Intent | 93/8 | true/true/`generation_5c02…` | source top `node_bb939…` | COVERAGE_INCOMPLETE | 22.114s wall; MCP diagnostic 10.014s |
| Second Repo same lexical | BLOCKED | semantic off | none | call budget exceeded | 30.005s |

### Cursor

| Cursor family | Advertised | Schema accepts | Valid continuation | Overlap/drift | Wrong/tampered result | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| search | yes | nested page.cursor | yes, 8 new hits | none | tampered=`CURSOR_INVALID` | PASS |
| files | yes | cursor | yes, 2 new files | none | context cursor=`CURSOR_OPERATION_MISMATCH` | PASS |
| context | yes | cursor | 4 pages, 2 each, exhaust | none | distinct family error tested via files | PASS |
| endpoints | yes | cursor | 3 pages, 6 unique | none | not separately tampered | PASS |
| coverage | yes | cursor | 3 unresolved pages | none | not separately tampered | PASS |
| dead code | yes | cursor | 3 new candidates | none | not separately tampered | PASS |
| file symbols | yes | cursor | page 2 returned 2 new symbols | none | not separately tampered | PASS |
| notes | yes | cursor | no candidate/cursor available | N/A | N/A | N/A_NO_DATA |
| saved query run | yes | cursor | saved list empty | N/A | N/A | N/A_NO_SAVED_QUERY |
| affected | no | no | honest non-support | N/A | N/A | PASS |

### Coverage

| Coverage dimension | Aggregate | Concrete page evidence | Reconciliation/limit | Safe conclusion |
| --- | ---: | --- | --- | --- |
| discovered | 3340 | headline only | revision exact | 当前 snapshot discovery headline |
| admitted | 3333 | files candidate 3298 | 35 差异未解释 | admitted headline 与 source-file inventory 不可互换 |
| excluded | 7 | 7/7 一页完整 | exact | secret/binary；无 cache dir |
| failed | 0 | 0 | exact | 当前 scope 没有 failed detail |
| stale | 0 | 0 | exact/fresh commit | 当前 scope stale=0 |
| unresolved | 84024 | 3 pages × 2 sampled | reconciled 84024/84024, delta 0 | 可分页且精确计数，但图是 lower bound |

### Negative/remediation

| Negative/remediation case | Expected boundary | Actual code | MCP-native next action | Verdict |
| --- | --- | --- | --- | --- |
| unknown repo | repository/root | SCOPE_NOT_FOUND | “specify a registered repository” | PARTIAL；未指向 register |
| unavailable branch | branch | BRANCH_NOT_FOUND | `index_status` + indexed branch | PASS |
| unknown node | node | INVALID_TARGET | absent | PARTIAL |
| unknown endpoint | endpoint | INVALID_TARGET | `knowledge_search` stable ID | PASS |
| wrong cursor family | operation | CURSOR_OPERATION_MISMATCH | restart same files scope | PASS |
| tampered cursor | integrity | CURSOR_INVALID | restart same search request | PASS |
| register/index/rebuild confirmed=false | mutation confirmation/root | BLOCKED at 30.005s each | none returned | FAIL |
| search no match | evidence completeness | NO_MATCH_INCOMPLETE | coverage then owner index | PASS/PARTIAL |

### Call responsiveness

| Call family | Duration | Complete/truncated | Cursor/warning | Budget verdict |
| --- | ---: | --- | --- | --- |
| health final | 0.823s | complete | none | PASS |
| Largest Repo lexical search | 5.348s | 8/truncated | cursor + coverage warning | PASS |
| context page 1 | 9.286s | 2/8 | cursor | PASS |
| endpoint flow | 20.598s | 60/not truncated; completeness partial | no cursor | PASS |
| affected symbol | 9.462s wall; MCP 0.158s | 12/not truncated; lower_bound | no cursor | PASS |
| service graph | 0.675s | complete response | no warning | PASS |
| semantic status | 4.178s wall; MCP 0.628s | complete | active generation | PASS |
| onboarding | 23.039s | complete | no cursor | PASS |
| Second Repo lexical | 30.005s | no response | budget exceeded | **FAIL** |
| register/index/rebuild negatives | 30.005s each | no response | budget exceeded | **FAIL** |

## 6. Owner-only Tauri evidence（不计 MCP 分）

| Observation | Verdict |
| --- | --- |
| Wiki opens on Graph with Focus absent | N/A_OWNER_EVIDENCE_NOT_SUPPLIED |
| Semantic progress/state/model visible | N/A_OWNER_EVIDENCE_NOT_SUPPLIED |
| Pause/Resume/Retry/Cancel state-gated | N/A_OWNER_EVIDENCE_NOT_SUPPLIED |
| Work survives App closure | N/A_OWNER_EVIDENCE_NOT_SUPPLIED |
| Graph/Storage responsive | N/A_OWNER_EVIDENCE_NOT_SUPPLIED |
| Installed Tauri build matches MCP | N/A_OWNER_EVIDENCE_NOT_SUPPLIED |

## 7. Hard gates

| Hard gate | Result | Evidence |
| --- | --- | --- |
| MCP available/loaded in fresh process | PASS | initialize/launcher healthy；queries useful |
| running/available/schema/contract/hash parity | PASS | exact match；restart false |
| semantic vector only with compatible complete active generation | PASS | 45007/45007 unique active，full identity |
| global context limit/order/continuation | PASS | 4×2, 8 unique, exhaust |
| advertised cursor ignores cursor/cannot continue | PASS for all data-bearing families；N/A notes/saved | 7 families valid continuation |
| fresh node/endpoint identity round trip | PASS | symbol + endpoint `get_node` |
| multi-term bounded search >30s or cache pollution | **FAIL** | Second Repo query 30005 ms；cache pollution未发现 |
| coverage lacks pageable concrete debt/reconciliation while claiming complete | PASS | unresolved pageable/reconciled；产品未 claim complete |
| graph/lexical blocks on semantic work | PASS | semantic-off lexical 5.1s；semantic already complete |
| wrong-family/tampered collapse | PASS | distinct codes |
| MCP remediation requires CLI/hidden unsafe mutation | UNPROVEN, no unsafe mutation observed | MCP tools exist，但 negative validations BLOCKED；未 fallback CLI |
| compact changes meaning/impossible exact size claim | PASS | canonical/count parity；estimate boundary诚实 |
| negative conclusions ignore caveats | PASS | 本报告保留 exclusions/unresolved/truncation/revision caveats |
| evaluator fallback violation | PASS | 未使用禁止路径 |

由于至少一个 hard gate 明确 FAIL，分数不得达到 95，Round 25 closure 条件不成立。

## 8. Category scores

| Category | Score | Max | Rationale |
| --- | ---: | ---: | --- |
| Runtime/MCP identity, upgrade parity, reliability | 10 | 10 | 身份完全一致且最终仍健康；timeout 缺陷在 responsiveness/remediation 扣分 |
| Discoverability, schemas, annotations, onboarding/remediation | 7 | 12 | manifest/onboarding强；mutation annotations 与 root required 欠缺，三 negatives 超时 |
| Exact/lexical/graph/context/flow usefulness | 17 | 20 | exact/flow/context强；lexical/semantic未稳定恢复 Primary Symbol，Second Repo blocked |
| Semantic readiness, identity, honesty, lifecycle | 18 | 18 | 唯一 complete active，full identity，历史 hygiene 和 provenance通过 |
| Stable identity, affected parity, pagination/cursor | 19 | 20 | 核心全部通过；notes/saved cursor 无数据不可验证 |
| Coverage, cache hygiene, scope/freshness/negative proof | 11 | 15 | concrete reconciliation/cache hygiene好；84k unresolved、count gap、cross-repo blocked |
| Compactness and bounded responsiveness | 4 | 5 | compact fixed-point优秀；Second Repo timeout |
| **Total** | **86** | **100** | hard gate fail，不能 95+ |

## 9. Prioritized remaining defects

1. **P0 — Second Repo multi-term search超过 30 秒**：同一 5-word lexical request 在 FPMS-NT 为约 5.3 秒，在 FPMS 触达 30 秒无响应。必须消除 scope-dependent full-corpus/per-term scan stall，并返回 typed timeout diagnostics。
2. **P0 — MCP owner remediation negative path挂起**：register/index/rebuild 在 `confirmed=false` 时应在毫秒级返回 `CONFIRMATION_REQUIRED`/validation error，绝不能进入长工作路径。
3. **P1 — Mutation schema/safety annotations不完整**：root_path/path 应至少一个 required；明确 destructive、idempotent、readOnly=false、owner-local boundary 和 no-op validation behavior。
4. **P1 — Repository/root remediation不够 actionable**：SCOPE_NOT_FOUND 应直接给出 `knowledge_repository_register` 的 canonical MCP shape；unknown node 也应给 search/locate remediation。
5. **P1 — Headline admitted 3333 与 files candidate 3298 未解释**：响应应提供分类 reconciliation，区分 admitted source files、non-source records 与 inventory eligibility。
6. **P1 — 84,024 unresolved references**：虽然分页/reconciliation正确，但严重限制 affected/flow completeness；应按 reason/path/service 提供可操作聚合和降低 debt。
7. **P2 — Retrieval recovery consistency**：natural lexical/semantic query 应更稳定把 controller/service/repository evidence排在通用 interface/spec 前；semantic paraphrase应更靠近 Primary Symbol 或明确 symbol recovery miss。
8. **P2 — Cursor claims with empty corpora**：为 note/saved-query 提供 capability-level deterministic cursor conformance test fixture，避免生产无数据时无法验证 hard gate。

## 10. Final verdict

# NO-GO

本次 Codex 报告为 **86/100**，并明确触发 bounded multi-term search hard gate。即使另一个独立报告表现优秀，Round 25 仍不能关闭；closure 要求两个独立报告都通过全部 hard gates 且各自 95–100。本产品目前适合有 revision/coverage caveat 的 exact/graph/semantic-assisted investigation，不适合宣称跨仓库稳定性、完整覆盖或已验证的 MCP-only owner remediation。
