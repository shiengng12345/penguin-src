# Penguin Wiki / Knowledge Index Evaluation — Codex Round 16

评估日期：2026-08-30（Asia/Kuala_Lumpur）  
模型/客户端：Codex / GPT-5；当前 Codex 会话  
目标：FPMS-NT，`/Users/shieng/Desktop/Projects/fpmsnt`，首选分支 `brazil-v2`

> 结论：`PARTIAL / NO-GO for high-trust autonomous change`. Penguin 已能提供 fresh、revision-aligned 的正向检索、节点交接、有限 graph flow 和 cursor scope safety；但完整调用闭包、数据边界、fresh client reload、MCP/CLI 错误与工具命名一致性仍未达到高信任门槛。

## 1. Fresh-session environment and exact runtime/client paths

- 起始时间：`2026-08-30T19:19:14+08:00`。
- 稳定 launcher：`/Users/shieng/.local/bin/penguin`。
- `penguin help --json` exit `0`，CLI schema `1`；运行时暴露 `endpoints`、`endpoint-identity`、`filesymbols`、`deadcode`、`search`、`context`、`explore`、`callers`、`callees`、`flow`、`affected`、`capabilities`、`status`、`doctor`、`coverage` 等命令。
- `penguin capabilities --json` exit `0`：build `1.16.0-4e7941ddc215e0f1`，contract `2`，schema `14`，capability hash `40ae9528330e4e97d68072d3c40c1be3db9e40f8f52478b44c8de026be4487d0`。
- MCP `mcp_health({})`：`status=ok`、`initializeHealthy=true`、`clientRestartRequired=false`、`runtimeOutdated=false`；runtime `v22.23.1`，`/Users/shieng/.penguin`，workers `2`，hard timeout `15000ms`。
- 宿主暴露的 Penguin MCP tool 数：`82`，名称重复数 `0`。宿主没有提供可直接调用的 MCP `initialize` 或 `tools/list` surface，因此 wire-level `tools/list` 原始响应和客户端进程重启不能独立复核。
- MCP `knowledge_capabilities`：99 registrations，99 个唯一 capability ID，无重复；build/hash 与 CLI 一致。
- FPMS-NT：`brazil-v2`，indexed/head commit `3f0f1984b9e4337668529a13bad5264501729908`，clean，indexed `2026-08-30T04:23:32.546Z`，parser `tree-sitter-wasm-v8-wrapper-allowlist`。
- 覆盖：CLI/MCP `discovered=3340, admitted=3333, excluded=7, failed=0, stale=0`。
- Penguin 没有通过允许的 surface 暴露 Penguin.app 安装路径或独立 app version；本报告以 launcher build ID 作为版本身份。
- 严格协议偏差：开始阶段曾执行一次 `rtk git status --short`，因当前 cwd `/Users/shieng` 不是 Git 仓库而失败；没有产生 source/DB/索引/报告变更，但因此 completion gate 的“未使用 git”不能声称通过。
- 当前 Codex 工具宿主未能证明会话是完全退出应用后重开；所有“fresh MCP session”结论均降级为 `not proven`，重复 health 只证明同一宿主中的稳定性。

## 2. Capability/readiness split and all scores /100

| Dimension | Score | Evidence-based justification |
|---|---:|---|
| Agent discoverability | 72 | CLI help/onboarding 有推荐顺序；MCP listing 首项不是 `knowledge_explore`，并且 canonical `knowledge.dead_code` 没有同名 tool。 |
| Context usefulness | 74 | path-qualified symbol 能返回 locator、revision、caller/callee、source pack；但 MCP `include_sources=false` 时 focus locator/signature 为空，tests/routes 常为空。 |
| Accuracy | 78 | FPMS-NT scope、branch、commit、node ID 可对齐；endpoint context 的 `repoId=null`、MCP legacy snapshot 表示仍有身份不一致。 |
| Completeness | 43 | `completeness=partial/lower_bound`，存在 `unresolvedReferenceCount=103925`；endpoint flow 只到 handler/service，不能闭合 data/test。 |
| Honesty | 86 | negative 和 partial 结果带 `proofStatus`、`totalIsExact`、coverage gaps、remediation；deadcode 明确警告 DI/reflection false positive。 |
| MCP/CLI parity | 58 | 正向 build/hash、节点和分页大体一致；MCP 错误会包装成 `INTERNAL`，unknown repo 甚至 `isError=false`，canonical tool alias 也不一致。 |
| Continuity | 45 | CLI cursor 可在新进程续接；MCP A/B health 相同但不是真正独立 client session，Claude continuity 未证明。 |
| Usability | 70 | CLI 错误码和 next action 可复制；endpoint-identity 完整结果清晰，MCP cursor 错误信息不够可操作。 |
| Speed | 88 | bounded CLI/MCP 查询通常在秒级；一次 `knowledge_doctor({})` 超过 15s hard timeout。 |
| Product overall | 67 | 适合 scoped retrieval、source-review checklist 和低风险导航；不适合把候选/短 flow 当完整 closure。 |
| Environment readiness | 69 | launcher、MCP initialize、build/hash 均正常；app path、真实 fresh client replay、wire tools/list、doctor 全局查询仍未证明。 |

Product overall 与 Environment readiness 分开：MCP doctor timeout、无法控制客户端退出属于环境/宿主限制；但 tool alias、错误包装、graph completeness 属于产品问题。

## 3. Q1–Q15 answers with exact commands/tools and bounded raw evidence

### Q1 — capability truth and first move

命令：

```text
rtk penguin help --json
rtk penguin capabilities --json
rtk penguin status --compact --json
rtk penguin doctor --json
rtk penguin coverage --repo FPMS-NT --json
rtk penguin onboarding FPMS-NT
mcp_health({})
knowledge_capabilities({})
```

原始证据摘录：`doctor={"status":"ok","ledgerSeq":12348,"materializedSeq":12348,"nodes":1006436,"edges":4583623,"pendingSuggestions":1}`；但 MCP `knowledge_doctor({})` 返回 `QUERY_TIMEOUT`、`retryable=false`。`onboarding` 推荐 `Search → Context → Graph → Evidence`，并明确“failed coverage 不能用于否定性结论”。

可靠 first move：先用 `knowledge_explore`/`penguin explore` 做一个 scoped、path-qualified target；若无 symbol，使用 `search`，再用 emitted node ID。只读操作包括 search、filesymbols、context、status、coverage；graph 操作包括 callers/callees/flow/affected；paged 操作包括 endpoints/filesymbols/deadcode；negative surface 是 deadcode 或显式 no-match。

不能证明：没有源码读取时的语义正确性、完整调用闭包、动态 DI/reflection、真实运行时 data reachability、未加载客户端的 reload 状态。

### Q2 — generation and launcher identity

命令/工具：`capabilities --json`、`mcp_health({})`、`knowledge_capabilities({})`，并重复两次 `mcp_health({})`。

证据：CLI/MCP 均为 build `1.16.0-4e7941ddc215e0f1`、hash `40ae9528...4487d0`、contract `2`、schema `14`；health A/B 都是 `initializeHealthy=true`、`clientRestartRequired=false`、`runtimeOutdated=false`。这证明当前宿主内 generation 一致，不证明第二个完全退出并重开的 MCP client session。通过项：同一运行时 generation/hash；未通过项：独立 fresh session replay，`not proven`。

### Q3 — MCP listing integrity

工具：宿主 Penguin MCP listing、`knowledge_capabilities({})`。

结果：82 个 Penguin tools，名称重复 `0`；canonical manifest 99 IDs、唯一 99。`knowledge_explore` 可调用但不是宿主列表第一项；dead-code canonical registration 是 `knowledge.dead_code`，实际 tool 是 `mcp__penguin__find_dead_code`，不存在 `mcp__penguin__knowledge_dead_code`。核心 search/file-symbol/context/graph/endpoint/status tools 均存在，完整 manifest 可取；兼容 aliases 未能证明“无第二 advertised capability”。

### Q4 — path-qualified source-pack usefulness

命令/工具：

```text
rtk penguin search getActiveEventConfigByObjId --repo FPMS-NT --json
rtk penguin filesymbols FPMS-NT brazil-v2 apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts --limit 10 --json
rtk penguin context <emitted-node-id> --repo FPMS-NT --json
rtk penguin explore <emitted-node-id> --repo FPMS-NT --json
knowledge_explore({target:<path-qualified-target>, repo:"FPMS-NT", branch:"brazil-v2", commit_sha:"3f0f1984b9e4337668529a13bad5264501729908", snapshot_id:"snapshot_804a4c86-b397-447a-9066-a51d36f2511a", include_sources:false})
```

当前 method ID：`node_af26e1f8-17f5-473b-b76c-e33a150abfac`；locator `apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts:135-156`；revision exact/fresh/aligned。CLI explore 返回 focus source、3 callers、1 visible callee、parser provenance 和 source block；MCP pack 返回 `callerCount=3`、`calleeCount=1`、`sourcesOmitted` 明确列出 focus/callers/callee，`completeness=lower_bound`，`unresolvedReferenceCount=103925`。

pack 足够准备 bounded source-review checklist；不足以判断 semantic correctness。tests/routes 在该 pack 中为空，不能解释为没有 tests/routes。

### Q5 — collision containment

命令：对 `constructor`、`execute`、`update` 分别执行：

```text
rtk penguin search <query> --limit 5 --json
rtk penguin search <query> --repo FPMS-NT --limit 5 --json
```

全局查询会暴露多 repo 结果；例如首批 `constructor` 命中 `penguin-src`。scoped query 的 FPMS-NT revision 保持 `repo_c58d...`、branch `brazil-v2`、commit `3f0f...`，候选数分别为 `constructor=1325`、`execute=373`、`update=4169`（均仅返回 5、`totalIsExact=false`）。

从 scoped `constructor` 选择当前 emitted ID `node_7c2d4657-cd74-4a3e-ac9a-004767fa3749` 后，`context/callers/flow` 均接受 `node:<id>`；callers 是 no static edge，completeness 仍为 lower bound，不能作“无 callers”结论。另一个 repo 的 path-qualified follow-up 未执行，结果 `not proven`。

### Q6 — dynamic ID matrix

所有 ID 都来自本轮 CLI/MCP 输出，未重构或替换：

| Origin | Emitted ID / locator | context | flow | callers | callees | affected |
|---|---|---|---|---|---|---|
| filesymbols | `node_28a441b6-d58b-4f8f-9b05-3e395f8c6041`, `ColorLandEventConfigService:28-157` | accepted, proven | accepted, 7 candidates | accepted, no static edge, `not_proven` | accepted, 1 | accepted, lower bound |
| search | `node_af26e1f8-17f5-473b-b76c-e33a150abfac`, method `:135-156` | accepted, proven | accepted, 5 candidates | accepted, 3 returned | accepted, 1 | accepted, lower bound |
| ambiguous result | `node_c31a8c9a-e6b6-44ff-8492-f65aeae0c137`, field candidate | `UNSUPPORTED_TARGET_KIND` | same | same | same | same |
| endpoints page 2 | `node_ec762949-fbcc-4387-aa8e-f1ba65f6d626` | accepted, endpoint repo scope retained by CLI | accepted, 2 candidates | accepted, no static edge | accepted, no static edge | accepted, lower bound |

field-node error 的 remediation 是“use a symbol, endpoint, service, file, or note target”；ID 被原样保留，未用 title/path 替代。所有 successful rows 都带 FPMS-NT/brazil-v2/commit `3f0f...`；endpoint context 的 focus `repoId=null` 是一个 accuracy defect。

### Q7 — endpoint queue and page-two handoff

命令：

```text
rtk penguin endpoints FPMS-NT --protocol grpc --limit 3 --json
rtk penguin endpoints FPMS-NT --protocol grpc --limit 3 --cursor <exact-page-1-nextCursor> --json
rtk penguin endpoints FPMS-NT --protocol grpc --limit 3 --cursor <exact-page-2-nextCursor> --json
```

page 1：`returnedCount=3,candidateCount=1535,totalIsExact=false,truncated=true`；page 2：
`AccumulativeEventConfigAdminService.GetAccumulativeEventConfigs`，ID `node_ec762949-fbcc-4387-aa8e-f1ba65f6d626`，handler `proto`；page 3 继续按 `title,nodeId` 排序。MCP 以 limit 500 完整续页得到 `500+500+500+35=1535`，最后一页 `nextCursor=null,totalIsExact=true`，unique IDs `1535`，duplicates `0`。

endpoint list 的 handler 状态为 `handled`；flow 的第一步是 endpoint → service `proto`，edge `handles`。第一个不完整边界是 handler/service 之后：没有可证明的 service → data/repository/test 链。

### Q8 — five-form endpoint identity

命令：

```text
rtk penguin endpoint-identity \
  'AccumulativeEventConfigAdminService.GetAccumulativeEventConfigs' \
  'grpc::AccumulativeEventConfigAdminService.getaccumulativeeventconfigs' \
  node_ec762949-fbcc-4387-aa8e-f1ba65f6d626 --repo FPMS-NT --json
```

分别用 rendered title、canonical identity、bare ID、`node:<id>` 和 slash route `/AccumulativeEventConfigAdminService/GetAccumulativeEventConfigs` 测试；四种 node/identity/route 输入均 resolved 到同一 root ID，`equal=true, completeness=complete`。故意输入 `BadService.BadMethod`/`grpc::BadService.badmethod` 时为 `no_match`，但仍把合法 ID resolve，exit `1`，没有 typed error/remediation，属于不够可复制的 invalid-input 反馈。

### Q9 — bounded request-trace chain

工具：page-two endpoint 的 `context`、`flow`、`callers`、`callees`、`affected`、`explore`。

证据链：`endpoint node_ec762...` → `proto service node_0fb2fbd0-1160-4b5c-b60a-28a62dc57463`，via `handles`，parser/endpoint inventory confirmed；没有后续 in-repo service、repository/data candidate 或 related test。该短 flow 是 lower bound，不是完整 closure；data-boundary reachability `not proven`。

### Q10 — four adversarial negative claims

1. “此函数无 callers”：对 `getActiveEventConfigByObjId` **反证**；current ID 的 callers 返回 3 个（`playDice`、`buildContext`、`verifyPlayerColorLand`）。这不是“所有 callers 完整”的证明，因为 `completeness=lower_bound`、unresolved refs `103925`。
2. “此 endpoint 无 handler”：**反证**；page-two inventory `handlerStatus=handled`、handler `proto`，flow 有 `handles` edge。
3. “此 symbol unused”：**not proven**；`deadcode` 返回 66 个 scoped candidates，并明确提示 DI/reflection/framework magic/dynamic import/public entry false positives。候选不是删除证明。
4. “此 request never reaches a data boundary”：**not proven**；flow 只到 `proto` handler/service，既没有 data edge 也没有否定 data edge 的 completeness proof。

### Q11 — error taxonomy and remediation

CLI 与 MCP 都执行了 missing target、unknown repo、ambiguous symbol、invalid node、wrong branch/commit/snapshot、malformed cursor、wrong-scope cursor、invalid endpoint identity、empty query。

| Case | CLI evidence | MCP evidence | Verdict |
|---|---|---|---|
| missing target | `TARGET_NOT_FOUND`, exit 1, `run penguin search...` | `isError=true`, same code/remediation | good parity |
| unknown repo | CLI exit 2 `unknown repo` | content 为 `SCOPE_NOT_FOUND` 但 `isError=false` | parity defect |
| ambiguous | `TARGET_AMBIGUOUS`, 20 candidates，要求 exact ID | field candidate follow-up typed unsupported kind | candidate recovery usable only for symbol kinds |
| invalid node | `TARGET_NOT_FOUND`, exit 1 | same, `isError=true` | good |
| wrong branch/commit/snapshot | `SCOPE_NOT_FOUND`, candidates + remediation，exit 4 | same structured error | good |
| malformed cursor | `CURSOR_INVALID`, exit 2 | message `CURSOR_INVALID` wrapped as `INTERNAL`, `isError=true` | error taxonomy defect |
| wrong-scope cursor | CLI `CURSOR_SCOPE_MISMATCH`, exit 2 | search cross-scope returned `CURSOR_STALE` wrapped as `INTERNAL` | semantic mismatch |
| invalid endpoint identity | `no_match`, exit 1，无 remediation | context `TARGET_NOT_FOUND` if used as target | CLI result not typed enough |
| empty query | CLI `NO_MATCH_INCOMPLETE`, exit 0，`proofStatus=not_proven` | `INTERNAL: knowledge_search requires a non-empty query` | major parity defect |

### Q12 — cursor continuity and scope safety

- `endpoints`：MCP normal continuation 4 pages，`500/500/500/35`，最后 exhausted，1535 unique、0 repeat；CLI malformed 为 `CURSOR_INVALID`，FPMS-CCMS wrong scope 为 `CURSOR_SCOPE_MISMATCH`。
- `filesymbols`：FPMS-NT color-land file page 1 是 9，page 2 是 1，page 2 `nextCursor=null,totalIsExact=true`；malformed 和 FPMS-CCMS wrong scope 均分别返回 typed `CURSOR_INVALID`/`CURSOR_SCOPE_MISMATCH`。
- `deadcode`：FPMS-NT page 1 → page 2 正常续接；`apps/promotion/src/modules/color-land` scoped query 返回 66、`truncated=false,totalIsExact=true,nextCursor=null`，证明该 bounded scope exhausted；malformed/wrong scope 均返回 typed cursor errors。
- MCP `knowledge_search` page 1 → page 2 可续接，但 source-occurrence hit 的 `nodeId` 可为空，不能把每个 search hit 当 symbol handoff。MCP malformed cursor 是 `INTERNAL/CURSOR_INVALID`，wrong scope 是 `INTERNAL/CURSOR_STALE`。

### Q13 — fresh-session replay

Session A packet 只包含本轮 Penguin 输出：hash/build；FPMS-NT/brazil-v2/commit `3f0f...`；symbol ID `node_af26...`；endpoint ID `node_ec762...`；page-one endpoint cursor 原样复制；invalid cursor error `CURSOR_INVALID`；next commands `context node:<id> --repo FPMS-NT --json`、`flow node:<id> --repo FPMS-NT --json`。

Session B 用新的 CLI process 传入 exact page-one cursor，成功得到 page two；node IDs 也可在后续 context/flow 中解析，scope/revision/terminology 保持。未能完全退出并重开 Codex/MCP client，因此真实 client handoff、Claude handoff、cursor 跨 client 的结论均 `not proven`。

### Q14 — Claude/Codex client continuity

Codex 当前宿主：MCP initialize health `true`；host Penguin tools `82`、名称重复 `0`；`knowledge_search` 成功；两次并行 health 返回相同 generation/hash。由于没有控制客户端完全退出，也没有 wire-level initialize/tools/list callable surface，以下均 `not proven`：fully quit-before-session、第二个独立 client sees same generation、Claude Code continuity。不要用 Settings green badge 推断 reload。

### Q15 — GO / NO-GO engineering packet

目标：`node_af26e1f8-17f5-473b-b76c-e33a150abfac`，`apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts:135-156`，FPMS-NT `brazil-v2`，commit `3f0f1984b9e4337668529a13bad5264501729908`，fresh/aligned/clean。

- direct callers：3；visible callee：`getColorLandEventConfigByIdFromCache` 1；parser provenance：calls extracted，confidence high。
- affected candidates：包括 `playDice`、`buildContext`、`verifyPlayerColorLand`、controller/processor/rule-engine 相关节点；列表是 lower bound。
- related tests/routes：当前 pack 返回空，不能解释为空集合；endpoint flow 也不能闭合到 data/test。
- external/unresolved：`unresolvedReferenceCount=103925`；constructor/interface/static/callback dispatch 未完整建模。
- pagination：search candidate count 非 exact；flow/context relations 部分 exact 但 completeness partial/lower_bound；deadcode 明确为 candidate list。
- source-review checklist：核对 method 的 active/status/date boundary；核对 cache population/refresh lifecycle；核对 3 callers 的 null/error handling；核对 interface/DI/dynamic dispatch；核对相关 tests 与 endpoint handler；最后用 aligned source revision 复验 data boundary。

决定：`NO-GO`。当前证据足够准备 source-review checklist，不足以授权修改、删除 deadcode、声称完整 impact closure 或声称请求到达/未到达数据边界。

## 4. Session A → Session B handoff packet and replay results

| Packet field | Value / result |
|---|---|
| Build/hash | `1.16.0-4e7941ddc215e0f1` / `40ae9528...4487d0` |
| Scope | FPMS-NT / brazil-v2 / `3f0f1984...29908` |
| Symbol | `node_af26e1f8-17f5-473b-b76c-e33a150abfac` |
| Endpoint | `node_ec762949-fbcc-4387-aa8e-f1ba65f6d626` |
| Cursor | endpoint page-one `nextCursor` copied byte-for-byte into a separate CLI process |
| Invalid error | `CURSOR_INVALID`, CLI exit 2 |
| Replay | page two resolved; context/flow accepted emitted IDs |
| Workarounds | 1: separate CLI process used because independent MCP client restart unavailable |
| Reconstructed values | 0 for IDs/cursor; client lifecycle itself was not observable |

The exact cursor was passed as a quoted opaque value; it was not decoded or regenerated. Because this report is not a cursor artifact store, the acceptance evidence is the successful page-two response and its page-two ID, not a claim that a future client has hidden session state.

## 5. Reliable operations without source reading

- Scoped path-qualified search/filesymbols can locate a symbol and emit a usable current node ID.
- `context`/`flow` can preserve repo, branch, commit, locator and freshness for supported symbol/endpoint nodes.
- Endpoint inventory can enumerate handler status and canonical identity; endpoint identity accepts title, canonical identity, bare ID, `node:<id>`, and slash route.
- Cursor continuation is scope checked and works across separate CLI processes; endpoints can be exhausted with explicit `nextCursor=null`.
- Deadcode is useful as a review lead only because it carries warning/remediation text; it is not a proof of unusedness.
- Coverage, freshness, `proofStatus`, `totalIsExact`, truncation and lower-bound fields can support honest bounded conclusions.

## 6. Operations requiring source reading or human intervention

- Semantic correctness, business behavior, exact date/status predicates, and whether an external call really reaches a database.
- Complete closure across DI, reflection, interface dispatch, static methods, callbacks, dynamic imports and framework registration.
- Choosing whether a deadcode candidate is actually safe to remove.
- Complete client quit/reopen and Claude/Codex cross-client continuity.
- Wire-level MCP `initialize`/`tools/list` evidence unavailable through the current Codex host.

## 7. Misleading, ambiguous, failed, unavailable, or non-actionable outputs

- `knowledge_doctor({})` timed out while CLI doctor succeeded; environment split, not proof of product capability failure.
- MCP endpoint context accepted an endpoint but emitted `focus.repoId=null`; inventory and outer locator still carried repo.
- `knowledge_explore` with `include_sources=false` explicitly lists omitted source reasons, but does not provide focus locator/signature in its focus object.
- `knowledge_search` empty query differs between CLI (`NO_MATCH_INCOMPLETE`, exit 0) and MCP (`INTERNAL`, isError true).
- MCP cursor errors preserve the message but lose typed `CURSOR_INVALID`/`CURSOR_SCOPE_MISMATCH` taxonomy under `INTERNAL`.
- Manifest/tool mismatch: canonical `knowledge.dead_code` versus actual `find_dead_code`.
- `totalIsExact=false`, empty arrays, lower-bound flows, `fallback_live`, and deadcode candidate lists must not be turned into absence claims.

## 8. Product failures versus environment failures

Product failures:

1. MCP/CLI error schema parity is incomplete and some MCP failures lose their typed code.
2. Canonical capability ID and advertised tool name are not one-to-one for deadcode.
3. Endpoint context does not retain repo identity inside the focus object and does not expose handler/source/data details in the bounded pack.
4. Graph completeness remains lower-bound with very large unresolved-reference count; high-confidence parser edges are not a complete closure.
5. Invalid endpoint identity lacks structured remediation.

Environment failures:

1. Current Codex host exposes no direct initialize/tools-list/restart control.
2. App installation path/version is not exposed by allowed surfaces.
3. MCP doctor exceeded the 15s hard timeout while CLI doctor was healthy.
4. Claude Code session continuity could not be controlled or observed.

## 9. Ordered improvements with impact, cost, and directly testable acceptance criteria

1. **Unify MCP/CLI contract and error mapping** — impact high, cost medium. Acceptance: the same inputs produce the same code, message, retryable, remediation, exit/status and MCP `isError`; empty query, unknown repo, malformed cursor and wrong-scope cursor retain typed codes.
2. **Make canonical registrations and tool names bijective** — impact high, cost low/medium. Acceptance: every manifest capability has exactly one advertised canonical tool; aliases are callable but do not add a second capability; `knowledge_explore` is discoverable as the first discovery tool.
3. **Eliminate legacy/fallback identity ambiguity** — impact high, cost medium. Acceptance: every successful CLI/MCP result carries the same immutable snapshot ID, commit, branch, repo ID and trust; no unexplained `legacy`/`fallback_live` for aligned current queries.
4. **Expose endpoint handler and bounded downstream closure** — impact high, cost high. Acceptance: page-two endpoint context/flow includes handler node ID, service method, external/unresolved edge statuses, related tests, and an explicit frontier/completeness proof.
5. **Persist unresolved/coverage counts per relation query** — impact high, cost medium. Acceptance: negative graph results include exact unresolved/reflection/DI/dynamic-dispatch counts and never return an apparently exact empty result when proof is unavailable.
6. **Add a portable session packet/replay verifier** — impact high, cost medium. Acceptance: packet-only Session B replay across two independently restarted MCP clients validates build/hash, IDs, revision, cursor and error terminology without hidden state.
7. **Bound doctor and make retryability truthful** — impact medium, cost medium. Acceptance: doctor returns within the hard timeout or returns a structured retryable timeout with next action; CLI and MCP agree on retryability.

## 10. Final recommendation for Claude/Codex internal use only

Use Penguin Round 16 as a **scoped navigation and evidence-preparation layer**: positive symbol retrieval, aligned locators, endpoint identity normalization, bounded flow, and cursor-safe handoff are useful. Do not use it as a high-trust replacement for source review or as proof of absence, complete impact closure, unusedness, or data-boundary reachability. Keep the engineering packet at `NO-GO` until the contract, continuity, and completeness improvements above are independently re-evaluated in two truly fresh client sessions.
