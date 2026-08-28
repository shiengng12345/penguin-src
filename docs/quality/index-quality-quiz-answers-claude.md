# Penguin index-quality quiz — 作答 + 评测报告

> 答题人：Claude Opus 5（Claude Code 会话）
> 日期：2026-08-28
> 题目：`docs/quality/index-quality-quiz.md`（12 题）
> 被测仓库：`FPMS-NT` @ `/Users/shieng/Desktop/Projects/fpmsnt`
> 工具约束：**只用 Penguin MCP，`knowledge_explore` 优先；不 grep、不读源文件、不用通识补空**

---

## 0. 快照与可信度基线

开局先固定「我在哪个版本上答题」，否则后面所有 file:line 都不可复核：

| 项 | 值 |
|---|---|
| repo | FPMS-NT（repo_c58d58a2…） |
| branch | brazil-v2 |
| indexedCommit / headCommit | `3f0f1984b9e4337668529a13bad5264501729908`（一致） |
| freshness | **fresh** |
| dirtyFileCount | 0 |
| indexErrorCount | 0 |
| parserVersion | tree-sitter-wasm-v8-wrapper-allowlist |
| schemaVersion | 14 |
| indexedAt | 2026-08-28T10:40:52.860Z |

`index_status(mode=compact)` 同时显示：全机 26 个 repo，20 fresh / 5 stale / 1 unknown，累计 33 个 index error（其中 FPMS 老库自己占 30）。**FPMS-NT 本身零错误、零 dirty**，所以本次答题没有任何一条需要标 `stale`。

> 说明：题目规则 4 要求「stale 就要传递」。本轮 FPMS-NT 全程 `freshness.stale=false`，不存在需要传递的 stale。唯一带警告的是两次 `1 INFERRED edge(s)` 提示（Q2、Q6、Q8），已在对应题目里标注。

---

## 1. 我的解题思路（方法论）

我把这 12 题看成 4 种索引能力探针，而不是 12 个独立问题：

| 题组 | 探的是什么能力 | 图上的边 |
|---|---|---|
| Q1–Q4 callers | 反向调用解析 + 同名消歧 | incoming `calls` |
| Q5–Q7 callees | 正向调用解析 + 跨包边界 | outgoing `calls` |
| Q8–Q10 endpoint | 路由 → handler → 下一跳 | `handles` + `calls` |
| Q11–Q12 file_symbols | 按文件枚举符号 | outgoing `defines` |

固定动作（每题都走同一套，避免「靠上一题的模式猜下一题」——这是题目规则 5 明令禁止的）：

1. **先 `index_status`**，锁定快照，再动手。
2. **`knowledge_explore(裸符号名)`** 打第一发。基本必然撞上 `ambiguous`（跨 26 个 repo 的同名副本），拿回 `ambiguousCandidates`。
3. **消歧**：优先用题目给的 filePath 去匹配候选的 `filePath`，取 `nodeId` 重打一次；或者直接用 `Class.method` 这种限定名（`PromotionClientGrpc.catchGrpcError`）一次命中。
4. **补 file:line**：`callers[]` / `calls[]` 只给 `{nodeId, title, nodeType}`，没有位置。`callPath` 里能白捡到一部分（带 `source.filePath/startLine`），捡不到的用 `get_node(id=…)` 逐个补。
5. **交叉校验**：拿 `focus.source`（真源码）跟 `calls[]` 对一遍，看图里有没有漏边。**Q7 就是这么抓到 `proposalSDK.*` 缺边的。**
6. **答不出就留空**：Q11/Q12 我确认了 5 条路都走不通，就明确写「索引里查不到」，不用 `defines` 计数去反推符号名。

一句话概括：**先固定版本，再消歧，再补坐标，最后拿源码反查图有没有骗我。**

---

## 2. 答案（12 题）

### Q1 · callers of `CMSGenBaseResponse`
定义：`apps/promotion/src/budget/budget-base-response.ts:14`

answer（全部 8 个，都在同一文件内）：
- apps/promotion/src/budget/budget-base-response.ts:26 — `success`
- apps/promotion/src/budget/budget-base-response.ts:34 — `forbidden`
- apps/promotion/src/budget/budget-base-response.ts:42 — `internalError`
- apps/promotion/src/budget/budget-base-response.ts:50 — `notFound`
- apps/promotion/src/budget/budget-base-response.ts:58 — `unauthorized`
- apps/promotion/src/budget/budget-base-response.ts:66 — `statusUnspecified`
- apps/promotion/src/budget/budget-base-response.ts:74 — `illegalArgs`
- apps/promotion/src/budget/budget-base-response.ts:82 — `alreadyExists`

tool used: `knowledge_explore("CMSGenBaseResponse")` → 10 个跨 repo 同名候选 → `nodeId=node_e8e51538…` → 8 个 caller 用 `get_node` 补行号
confidence: **high**（8 条 `calls` 边全部 parser EXTRACTED，confidence=1；`incomingByType.calls=8` 与列表条数一致）

---

### Q2 · callers of `addPlayerFreeSpin`
定义：`apps/promotion/src/free-spin/processors/add-free-spin/add-free-spin-processor.ts:34`

answer（8 个）：
- apps/promotion/src/free-spin/controllers/free-spin.internal.controller.ts:19 — `FreeSpinInternalController.addPlayerFreeSpin`
- apps/promotion/src/modules/growth-task/services/reward-dispatcher.service.ts:182 — `dispatchFreeSpin`
- apps/promotion/src/reward-grant/adapters/free-spin-grant.adapter.ts:30 — `FreeSpinGrantAdapter.dispatch`
- apps/promotion/src/winsday-billion/services/reward-grant.service.ts:65 — `RewardGrantService.grantFreeSpin`
- apps/promotion/src/modules/color-land/services/color-land-reward.service.ts:47 — `ColorLandRewardService.dispatchReward`
- apps/promotion/src/physical-gift/processors/redeem-physical-gift.processor.ts:88 — `RedeemPhysicalGiftProcessor.redeemPhysicalGift`
- apps/promotion/src/special-event/services/special-event-mission.service.ts:1731 — `SpecialEventMissionService.claimTaskReward`
- apps/promotion/src/winsday-billion/services/post-win-share.service.ts:457 — `PostWinShareService.grantFreeSpin`

tool used: `knowledge_explore("addPlayerFreeSpin")` → 12 候选（含 spec 里的 mock field 节点、FPMS 老库的 `addPlayerFreespin` 大小写变体）→ processor nodeId
confidence: **high**（`incomingByType.calls=8`；整体 confidence 被 1 条 0.45 的 INFERRED `reads_field` 边拉成 low，但那条与 caller 判定无关）

---

### Q3 · callers of `addPlayerMudDisbursement`
定义：`apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts:51`

answer（8 个）：
- apps/promotion/src/modules/growth-task/services/reward-dispatcher.service.ts:66 — `dispatchMud`
- apps/promotion/src/mud/controllers/mud.internal.controller.ts:18 — `MudInternalController.addPlayerMud`
- apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts:155 — `addPlayerMudToRewardRecordBatch`（同文件自调）
- apps/promotion/src/reward-grant/adapters/mud-grant.adapter.ts:24 — `MudGrantAdapter.dispatch`
- apps/promotion/src/winsday-billion/services/reward-grant.service.ts:107 — `RewardGrantService.grantMud`
- apps/promotion/src/modules/color-land/services/color-land-reward.service.ts:47 — `ColorLandRewardService.dispatchReward`
- apps/promotion/src/special-event/services/special-event-mission.service.ts:2323 — `claimTaskRewardByTaskId`
- apps/promotion/src/winsday-billion/services/post-win-share.service.ts:504 — `PostWinShareService.grantMud`

tool used: `knowledge_explore("AddMudProcessor.addPlayerMudDisbursement")`（限定名一次命中，省掉消歧）
confidence: **high**（还额外带出 tests 边：`add-mud-processor.spec.ts`）

---

### Q4 · callers of `catchGrpcError`
定义：`libs/tools/src/client-grpc/promotion-client-grpc.ts:131`（private）

answer（8 个，全部在同一文件内）：
- libs/tools/src/client-grpc/promotion-client-grpc.ts:138 — `giveVoucherToPlayersDto`
- libs/tools/src/client-grpc/promotion-client-grpc.ts:162 — `getOngoingMonthlyDepositBonusRewardEvent`
- libs/tools/src/client-grpc/promotion-client-grpc.ts:182 — `verifyFreeSpinEvent`
- libs/tools/src/client-grpc/promotion-client-grpc.ts:202 — `checkAndCreateMission`
- libs/tools/src/client-grpc/promotion-client-grpc.ts:233 — `queryDividendRecords`
- libs/tools/src/client-grpc/promotion-client-grpc.ts:251 — `getLuckyCoinTransactionHistoryFromPromotion`
- libs/tools/src/client-grpc/promotion-client-grpc.ts:307 — `redeemPlayerLuckyCoinsFromPromotionInternal`
- libs/tools/src/client-grpc/promotion-client-grpc.ts:330 — `transferMachineLuckyCoinsToPlayerFromPromotion`

tool used: `knowledge_explore("PromotionClientGrpc.catchGrpcError")`
**踩坑记录**：裸名 `catchGrpcError` 在这个 monorepo 里至少有 game-provider / payment-disbursement / player / promotion 四个同名 private 副本，一律返回 ambiguous。我先试了 `knowledge_search(mode=exact, scope.paths=[该文件])` 想定位——**返回 NO_MATCH（假阴性，文本明明在 131 行）**，改用限定名才成功。
confidence: **high**（结果本身可靠；但定位路径踩到一个 search bug，见 §3.4）

---

### Q5 · callees of `accumulatePlayerDeposit`
focus：`apps/riskControl/src/antiAddiction/deposit-limit.service.ts:163`（DepositLimitService）

answer（10 个）：
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:191 — `getRuntimeContext`
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:59 — `evaluateStateAndResetIfPeriodExpired`
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:324 — `shouldSkipAccumulate`（同类 private）
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:74 — `DepositLimitStateService.accumulatePlayerDeposit`（同名不同类，注意别混）
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:21 — `evaluateState`
- apps/riskControl/src/antiAddiction/deposit-limit-config.service.ts:122 — `isNotConfigured`
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:241 — `flushStateSnapshot`
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:314 — `isLimitReached`
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:276 — `recordDepositLimitChange`
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:157 — `notifyStateChanged`

tool used: `knowledge_explore("accumulatePlayerDeposit")` → **20 个候选**（同一符号名在 FPMS-NT / FPMS-NT-Risk-Control / FPMS 老库 JS 三处都有，且 consumer / service / state-service 三层同名）→ `nodeId=node_cf76d4d7…`
confidence: **high**（`outgoingByType.calls=10`，与列表条数一致；10 条全部能从 callPath 白捡到 file:line，一次 `get_node` 都没用上）

---

### Q6 · callees of `applyOpenPromoCode`
focus：`apps/promotion/src/promo-code/promo-code.processor.ts:1285`

answer（10 个）：
- libs/tools/src/repositories/player/fpms/logs2/open-promo-code-template/open-promo-code-template-repository.ts:16 — `findActiveOpenTemplate`
- libs/tools/src/clickhouse/pcr-clickhouse.service.ts:54 — `query`
- libs/tools/src/repositories/player/fpms/log/player-top-up-record/player-top-up-record-repository.ts:16 — `findByProposalId`
- libs/tools/src/repositories/player/fpms/log/player-top-up-record/player-top-up-record-repository.ts:27 — `addUsedEvent`
- libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:190 — `getPlayerLevelWithPlayerLevelObjId`
- libs/tools/src/client-grpc/payment-client-grpc/payment-client-grpc.ts:195 — `DeductPlayerCredit`
- apps/promotion/src/event-bus/producer.routes.ts:31 — `emitEvent`
- libs/tools/src/fpms-internal-server/fpms-internal-server.service.ts:173 — `createProposal`
- libs/common/common.ts:1397 — `log`
- libs/common/common.ts:1399 — `warn`

tool used: `knowledge_explore("PromoCodeProcessor.applyOpenPromoCode")`
**踩坑记录**：返回体 **66,663 字符**，超过单次工具输出上限，被落盘到 `tool-results/…txt`，我用 `jq` 抽 `calls` + `callPath` 才拿到答案。
confidence: **high**（`calls` 10 条与 callPath depth-4 一一对上）；结果带 `1 INFERRED edge` 警告

---

### Q7 · callees of `createLeaderBoardRewardProposal`
focus：`apps/promotion/src/leaderboard/leaderboard.processor.ts:579`

answer（图里有的 10 个）：
- apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:1404 — `leaderboard.incrementMessageDedup`
- apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:1415 — `leaderboard.checkAndAddEventSession`
- libs/tools/src/manager/fpms-platform-cache/fpms-platform-cache-manager.ts:36 — `getPlatformByPlatformId`
- libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:242 — `getPlayerInfoInternal`
- libs/tools/src/manager/player-level-cache/player-level-cache-manager.ts:41 — `getPlayerLevelByPlayerLevelObjId`
- libs/tools/src/repositories/common/proposal-type/proposal-type-repository.ts:18 — `getProposalTypeByName`
- libs/common/common.ts:258 — `getStartAndEndDate`
- apps/promotion/src/leaderboard/leaderboard.service.ts:365 — `getTotalRewardCountForDay`
- libs/common/common.ts:1236 — `createGrpcMetadataWithTrace`
- libs/common/common.ts:1399 — `warn`（`this.logger.warn`）

tool used: `knowledge_explore("LeaderboardProcessor.createLeaderBoardRewardProposal")`
confidence: **medium — 已知缺边**。`focus.source` 里明确还有两个调用：
- `proposalSDK.getProposalData({...})`
- `proposalSDK.createProposal(proposalPayload, undefined, metadata)`

这两个是**这个方法的业务主干**（查重 + 真正下单），但 `calls[]` 里完全没有，`unresolvedReferenceCount=0` 也没提示。原因大概是 `proposalSDK` 来自外部 npm 包（FPMS-Proposal-SDK），不在本 repo 的符号表里。**这是本轮最危险的一处：列表看起来「10 条整整齐齐」，实际漏掉了最关键的两跳，且索引不告诉你它漏了。**

---

### Q8 · endpoint `GET /healthcheck`

answer：
- handler（索引把该路由收敛成**一个** endpoint 节点，挂了**两个** handler）：
  - apps/livechat/src/http-health-check/http-health-check.controller.ts:12 — `HttpHealthCheckController.check`
  - libs/tools/src/http-health-check/http-health-check.controller.ts:12 — `HttpHealthCheckController.check`
- handler 往下调：
  - apps/livechat/src/http-health-check/http-health-check.service.ts:20 — `HttpHealthCheckService.check`
  - libs/tools/src/http-health-check/http-health-check.service.ts:35 — `HttpHealthCheckService.check`
- 再往下（depth 3）：
  - libs/common/base-redis.service.ts:717 — `ping`
  - libs/common/base-redis.service.ts:721 — `getConnectionStr`

tool used: `knowledge_explore("GET /healthcheck")` → 9 个跨 repo 候选 → FPMS-NT 的 `node_4d3b6c2e…`
confidence: **medium**。两个问题：(1) endpoint 节点不区分是哪个 app 挂的路由，两个 controller 共享同一节点，我无法从索引判断「跑起来到底哪个生效」；(2) `@nestjs/terminus` 的 `healthCheck.check` / `mongooseHealth.pingCheck` / `typeOrmHealth.pingCheck` 都没进图（同 Q7 的外部包缺边）。

---

### Q9 · endpoint `POST /internal/vip-cohort/retention-risk`

answer：
- handler：apps/promotion-event-scheduler/src/vip-cohort/vip-cohort-trigger.controller.ts:45 — `VipCohortTriggerController.triggerRetentionRisk`
- 往下只调一个：apps/promotion/src/modules/vip-cohort/services/vip-cohort-runner.service.ts:101 — `VipCohortRunnerService.run`
  - `run` 内部再展开（depth 3+）：`isDisabledBySwitch`:314 / `isWithinWindow`:80 / `config.load`:52 / `vipCohortRunLockKey`:219 / `runRepo.startRun`:25 / `drainPages`:334 / `emitBatch`:480 / `runRepo.finishRun`:43 / `emptyDropCounters`:78 / `isVipCohortTraceEnabled`:381
- 关联测试：apps/promotion-event-scheduler/src/vip-cohort/vip-cohort-trigger.controller.spec.ts

tool used: `knowledge_explore("POST /internal/vip-cohort/retention-risk")`
confidence: **high**（`routes[].via="direct"`，一次命中零消歧，`handles` 边唯一。这是 12 题里索引表现最干净的一题——跨 app 的 scheduler→promotion 调用链也完整跟到了）

---

### Q10 · endpoint `POST /promotion/GetPlayerFreeSpinInfo`

answer：
- handler：apps/promotion/src/free-spin/controllers/free-spin-http.controller.ts:20 — `FreeSpinHttpController.getPlayerFreeSpinInfoRestful`
- 往下调 2 个：
  - apps/promotion/src/free-spin/processors/get-player-free-spin-info.transformer.ts:11 — `transformRestfulReqToNt`
  - apps/promotion/src/free-spin/processors/get-player-free-spin-info.processor.ts:117 — `GetPlayerFreeSpinInfoProcessor.execute`
- `execute` 再往下（depth 3）：
  - libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:206 — `getFreeSpinPlayerInfo`
  - apps/promotion/src/free-spin/processors/get-player-free-spin-info/strategies/verify-free-spin-strategy.factory.ts:12 — `createStrategy`
  - apps/promotion/src/free-spin/processors/get-player-free-spin-info.processor.ts:177 — `buildVerifyFreeSpinPlayerData`
  - libs/tools/src/redis2/redis2.service.ts:986 — `getPlayerFreeSpinClaimed`

tool used: `knowledge_explore("POST /promotion/GetPlayerFreeSpinInfo")`
confidence: **high**（一次命中）。小注：`strategy.verify()` / `strategy.getOngoingEventIds()` 是接口多态调用，图里只到 `createStrategy`，没有展开到具体 strategy 实现——这是静态分析的正常边界，不算 bug，但用的人要知道。

---

### Q11 · file_symbols `apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts`

answer：**无法用索引回答，留空。**

可确认的事实：
- 文件节点存在：`node_bd10709e-f4b3-4dfe-8e92-c244efce4a0d`，`status=fresh`
- 它有 **12 条 outgoing `defines` 边**（`provenance: defines EXTRACTED confidence=1 count=12`）——**索引知道这里定义了 12 个符号**
- 但没有任何 MCP 工具能把这 12 个符号列出来

我试过的 5 条路，全部走不通：

| 尝试 | 结果 |
|---|---|
| `knowledge_explore(<file path>)` | 解析成功但 `resultStatus=no_static_edge`，`sources=[]`，**不展开 defines** |
| `knowledge_graph_query(defines, out)` | 入参形状打不通：`GRAPH_QUERY_DEPTH_INVALID` ↔ `GRAPH_QUERY_LIMIT_INVALID` 反复横跳（depth 放 `request` 里能过，limit 无论放顶层 / `request.limit` / `request.maxResults` / `request.resultLimit` / traverse item 里都 invalid） |
| `explore_graph(...)` | `start` 试了 `{nodeId}` `{target}` `{id}` `{symbol}` `{query}` 五种形状，全部返回 `target.requested=""` + `resolutionStatus=ambiguous`；且它的 mode 枚举里**根本没有 defines 方向** |
| `knowledge_search` | `searchedLanes` 只有 `source`，**symbol lane 从不参与**；用 `livechat-bot-processor.ts::`（identityKey 前缀）substring 搜 → NO_MATCH |
| `find_dead_code(repo, path)` | **repo / path 入参被完全忽略**，返回的是 `rust-axum-template` 那个 Rust 仓库的符号（`AppState` / `WsHub` / `from_request_parts` …）——完全不相干 |

我**没有**用「12 个 defines」去反推符号名，也没有退回 `knowledge_get_hit` 去把文件源码读出来自己解析——后者虽然是 Penguin 工具，但那等于在测「文件读取」而不是「索引」，违反题目意图。

tool used: `knowledge_explore` / `knowledge_graph_query` / `explore_graph` / `knowledge_search` / `find_dead_code`
confidence: **low — 缺的是「按文件枚举符号」这个 API 能力，不是数据**

---

### Q12 · file_symbols `apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts`

answer：**无法用索引回答，留空**（原因同 Q11）。

可确认的事实：
- 文件节点：`node_0d5cda5a-848c-4283-a0ce-f84847aad0b3`，`status=fresh`
- **10 条 `defines` 边** + 12 条 `imports`（`outgoingByType: {defines:10, imports:10, reads_field:1}`，`incomingByType: {imports:2}`）
- 符号名与行号无法从索引取出

tool used: 同 Q11
confidence: **low**

---

## 3. 我遇到的问题（按严重度排序，附证据）

### 3.1 🔴 P0 — 按文件枚举符号：数据有，出口没有
`defines` 边在库里、count 准确（12 / 10）、confidence=1，但**没有一个工具能遍历它**。
- 直接后果：12 题里 2 题（17%）直接答不了。
- 影响面远超答题：「这个文件里有什么」是 code review、重构、写测试、判断 dead code 的最高频入口之一。现在这个入口只能退回 `cat` / `grep`——而 Penguin 的整个卖点就是「别 grep」。
- `knowledge_explore` 对文件节点的 diagnostics 还会说 *"is indexed but has no outgoing calls/references — it may be a terminal/leaf symbol"*，这句话对文件节点是**误导性的**：它有 12 条 defines 和 3 条 imports，不是 leaf。

### 3.2 🔴 P0 — 外部包调用静默缺边（最危险）
Q7：`proposalSDK.getProposalData` / `proposalSDK.createProposal` 是该方法的业务主干，`calls[]` 里没有，且：
- `unresolvedReferenceCount = 0`
- `coverageGaps` 只有一条无关的 `unresolved_reference_counts_not_persisted`
- `confidence.level = "high"`，`inferredEdges = 0`

也就是说**索引以高置信度给了一份不完整的答案，而且不承认自己不完整**。Q8 同理（`@nestjs/terminus` 三个 pingCheck 全丢）。
> 这比「查不到」严重得多。查不到我会去 grep；「high confidence 的残缺列表」我会直接信。如果我没有拿 `focus.source` 反查，Q7 就是一个看起来满分、实际漏掉核心两跳的答案。

### 3.3 🟠 P1 — filter 入参被静默忽略
`find_dead_code({repo:"FPMS-NT", path:"apps/livechat/..."})` 返回 `rust-axum-template` 的 Rust 符号。
- 不报错、不警告、不说明 filter 未生效 → 一个不警惕的调用方会把别的仓库的结论写进 FPMS-NT 的报告里。
- 这类工具的 schema 是 `additionalProperties: true`，等于**任何拼错或不支持的参数都会被吞掉**。

### 3.4 🟠 P1 — `knowledge_search` 的两个坑
1. **path scope 假阴性**：`mode=exact, query="catchGrpcError", scope.paths=["libs/tools/src/client-grpc/promotion-client-grpc.ts"]` → `NO_MATCH_INCOMPLETE`，但该文本确实在这个文件的 131 行。`scopeApplied=true`、`resolvedScope` 只回了 repo 没回 path——path 过滤要么没实现要么把结果全滤掉了。
2. **symbol lane 从不被搜**：工具描述写着覆盖 "SYMBOL NAMES + SIGNATURES"，实际每次 `searchedLanes` 都只有 `["source"]` 或 `["path"]`。
- 叠加效果：`NO_MATCH` + `COVERAGE_INCOMPLETE` 警告一起出现时，我无法区分「真没有」和「过滤器把它吃了」。

### 3.5 🟠 P1 — 同名符号消歧成本极高
| 查询 | 候选数 |
|---|---|
| `accumulatePlayerDeposit` | **20** |
| `addPlayerFreeSpin` | 12 |
| `CMSGenBaseResponse` | 10 |
| `GET /healthcheck` | 9 |

原因是三重叠加：(a) 26 个 repo 里有大量 vendored/复制的同名文件（`libs/tools/src/client-grpc/promotion-client-grpc.ts` 在 5 个 repo 里都存在）；(b) 同一 repo 内三层同名（consumer / service / state-service 都叫 `accumulatePlayerDeposit`）；(c) 候选里混进了 `nodeType: "field"` 的 spec mock（`redeem-physical-gift.processor.spec.ts::<object>::addPlayerFreeSpin`）。

更糟的是：**候选列表里大部分 `filePath` 是 `null`**（只有当前 repo 当前 branch 的才有值）。跨 repo 候选只有 `identityKey` 能看出文件——能用，但要人肉解析 `repo_xxx::path::Class.method` 字符串。

### 3.6 🟡 P2 — callers/calls 不带坐标，补坐标很贵
`callers[]` / `calls[]` 只有 `{nodeId, title, nodeType}`。要 file:line 就得：
- 从 `callPath` 白捡（能捡到多少不确定，Q5 全捡到、Q1 只捡到 1 个），或
- 每个节点打一次 `get_node` —— 而 **`get_node` 无脑返回整个符号的全量源码**。Q2 补一个 `redeemPhysicalGift` 的行号，代价是一段 **860+ 行**的方法体灌进上下文。

同类问题：`knowledge_explore("PromoCodeProcessor.applyOpenPromoCode")` 单次返回 **66,663 字符**，直接超限落盘，我得 `jq` 才能读。这两个加起来是本轮最大的 token 开销来源，而**我要的只是 8 行 `path:line — name`**。

### 3.7 🟡 P2 — endpoint 节点跨 app 合并
`GET /healthcheck` 一个 endpoint 节点挂两个不同 app 的 controller（`apps/livechat` + `libs/tools`）。路由字符串相同就合并，丢掉了「哪个服务/哪个 app」这一维。在 monorepo 里 `/healthcheck`、`/metrics`、`/version` 这种路径必然多 app 重名。

### 3.8 🟡 P2 — 图查询 API 的入参 schema 不可发现
`knowledge_graph_query` / `explore_graph` 的 schema 是 `{start: object, traverse: array, project: array, limit: number}` —— **object/array 内部形状完全没描述**。我花了 8 次调用做二分猜测，最后仍未打通，且错误码互相矛盾（加上 `request.limit` 后 depth 又变 invalid）。对 agent 来说，这等于这两个工具**不可用**。

---

## 4. 优点（这套索引真正好用的地方）

不能只列问题。以下几点是明显强于 grep 的：

1. **快照可信度是一等公民。** 每次返回都带 `trust`（indexedCommit vs headCommit、worktreeState、dirtyFiles、parserVersion、schemaVersion）+ `freshness` + `revision`。我能一句话说清「我答的是哪个 commit」——这是 grep 永远给不了的，也是把结论写进文档时最需要的东西。
2. **`provenance` + `confidence` 分离得很好。** 每类边标 `origin=parser / method=EXTRACTED|INFERRED / confidence`，还会显式提示 `1 INFERRED edge(s) — verify`。Q2 那条 0.45 的 INFERRED 边让我立刻知道「整体 low 是被无关的 reads_field 拉低的，caller 判定本身是 1.0」。**这个设计我很欣赏：它让我能给出有层次的 confidence，而不是二元的信/不信。**
3. **`callPath` 是白送的深度信息。** Q5 十个 callee 的 file:line 全部从 callPath 白捡，零次 `get_node`。Q9 更是一路跟到 depth 5，跨 `promotion-event-scheduler` → `promotion` 两个 app，链条完整。
4. **`ambiguousCandidates` 的失败姿态是对的。** 撞名不瞎猜、不返回「最像的那个」，而是把候选摊开让调用方选。**这一点直接决定了这次答题的诚实度**——如果它随便挑一个 `CMSGenBaseResponse` 返回，我很可能拿 FPMS-NT-Payment 的副本当答案交上去而毫不知情。
5. **附赠信息有用。** `routes[]`（"reachable from 1 HTTP route(s) — public-facing"）、`tests[]`（自动关联 spec 文件）、`blastRadius`、`sourcesOmitted`（明确告诉你「哪几个 caller 因为行数预算被裁了」）——`sourcesOmitted` 尤其体贴，它让「输出被截断」变成显式信息而不是静默丢失。
6. **`focus.source` 是最好的自检工具。** 它给的是查询时从磁盘重读的逐字源码，正因为有它，我才能拿源码去反查图有没有漏边（Q7 的缺边就是这么抓的）。**这个交叉校验能力，建议在文档里明确推荐给所有调用方。**

---

## 5. 缺点 / 风险总结

| # | 问题 | 严重度 | 表现 | 后果 |
|---|---|---|---|---|
| 1 | 按文件枚举符号无出口 | P0 | defines 边有数据、无 API | 2/12 题答不出；最高频入口退回 grep |
| 2 | 外部包调用静默缺边 | P0 | Q7 漏 `proposalSDK.*`，仍报 high confidence | **高置信度的残缺答案**，比查不到危险 |
| 3 | filter 入参被吞 | P1 | `find_dead_code` 跨仓返回 | 结论串仓，且无警告 |
| 4 | search path scope 假阴性 / symbol lane 不搜 | P1 | 文本明明存在却 NO_MATCH | 无法区分「没有」和「被过滤」 |
| 5 | 同名消歧成本高 + 候选 filePath 为 null | P1 | 最多 20 候选，跨 repo 只能读 identityKey | 每题多 1–2 次调用；有选错风险 |
| 6 | callers/calls 无坐标 + get_node 返回全量源码 | P2 | 补 8 个行号 = 灌 8 段方法体 | token 爆炸（单次 66KB 超限落盘） |
| 7 | endpoint 跨 app 合并 | P2 | 一个 `/healthcheck` 两个 handler | monorepo 下路由归属不可判 |
| 8 | 图查询 API schema 不可发现 | P2 | 8 次猜测未打通，错误码矛盾 | 对 agent 等于不可用 |
| 9 | 接口多态不展开 | 可接受 | 只到 `createStrategy` | 静态分析正常边界，但需在文档写明 |

**一句话结论**：**这套索引「说得清自己有多可信」的能力（元数据层）明显强于「答得全」的能力（数据层）**。P0-2 是唯一会让人做出错误决策的问题——因为它同时满足「答案不全」+「声称高可信」+「不提示缺口」三个条件。

---

## 6. 建议（按投入产出排序）

### 优先级 1：补 `defines` 出口（1 个小 API，解掉 P0-1）
```
knowledge_file_symbols(file_path, repo?, branch?)
  → [{ nodeId, title, kind, startLine, endLine, signature, visibility, parentSymbol }]
```
要点：
- 返回**扁平表 + parentSymbol**，别嵌套；带 `kind`（class/method/function/const/type）好过滤。
- **不带 source code**（这是 §3.6 的教训）。
- 顺手修 `knowledge_explore` 对文件节点的 diagnostics：不该说 leaf，应该说 "file node: 12 defines, 3 imports — use knowledge_file_symbols to enumerate"。

### 优先级 2：让缺边可见（解掉 P0-2，最重要）
不要求真的解析外部包（那是大工程），只要求**承认**：
```json
"externalCalls": [
  { "callee": "proposalSDK.createProposal", "resolvedTo": null,
    "reason": "external_package", "line": 748 },
  { "callee": "proposalSDK.getProposalData", "resolvedTo": null,
    "reason": "external_package", "line": 690 }
],
"coverageGaps": ["external_package_calls_unresolved:2"]
```
并且：**只要 `externalCalls` 非空，`confidence.level` 就不能是 `high`**。
> 这一条的价值在于把「未知」从静默变成显式。现在的行为是「不知道的就当不存在」，这会让下游做出错误决策；改成「不知道的明说不知道」，答案的可用性反而上升。

### 优先级 3：坐标随边返回（解掉 P2-6，省一半 token）
`callers[]` / `calls[]` 每项直接补 `filePath` / `startLine` / `endLine`：
```json
{ "nodeId": "...", "title": "grantFreeSpin", "nodeType": "symbol",
  "filePath": "apps/promotion/src/winsday-billion/services/reward-grant.service.ts",
  "startLine": 65, "endLine": 105 }
```
本轮我打了 **13 次 `get_node`** 纯粹为了补行号，其中有 860 行、260 行的方法体被无意义地灌进上下文。这一个改动能砍掉这 13 次调用和绝大部分 token。
配套：`get_node` 加 `include_source: false`（默认 false 更好），`knowledge_explore` 加 `include_sources: false` / `max_source_lines`。

### 优先级 4：修 filter + search lane（解掉 P1-3/4）
- 所有工具的 `repo` / `path` / `scope` 入参：**要么生效，要么显式报 `UNSUPPORTED_FILTER`，绝不静默忽略**。把 `additionalProperties: true` 收紧成 false，拼错参数直接报错。
- `knowledge_search` 默认把 symbol lane 纳入 `searchedLanes`；`scope.paths` 修好，并在 `resolvedScope` 里回显实际生效的 path。
- `NO_MATCH` 时区分 `NO_MATCH_TRUE`（搜了、没有）和 `NO_MATCH_FILTERED`（过滤后为空）。

### 优先级 5：消歧体感（解掉 P1-5）
- `ambiguousCandidates` **每项都补 `filePath` + `repoName` + `branch`**（现在跨 repo 项全是 `null`，只能人肉解析 identityKey）。
- 支持带路径的目标语法：`knowledge_explore("apps/promotion/src/budget/budget-base-response.ts::CMSGenBaseResponse")` —— 题目本来就是这么给定义位置的，一步命中，不用来回两趟。
- 候选默认按「当前 repo 优先 + `nodeType: symbol` 优先」排序，把 spec 里的 mock field 降权或用 `include_test_artifacts: false` 过掉。

### 优先级 6：其它
- `endpoint` 节点的 identityKey 加上 app/service 维度（`apps/livechat::GET /healthcheck`），解 P2-7。
- `knowledge_graph_query` / `explore_graph` 的 schema 把 `start` / `traverse` 的内部形状写全，并在 error 里带上一个可运行的最小示例（`GRAPH_QUERY_DEPTH_INVALID: expected request.depth (1-12), got undefined. Example: {...}`），解 P2-8。

---

## 7. 一些想法（关于这份测评本身）

### 7.1 这套题设计得很好，好在「不给答案」
`index-quality-answers.md` 不放在同一个文件里，这一条比什么都重要。我全程无法自我校验，只能靠「工具说了什么」和「focus.source 说了什么」做交叉验证。**这直接把「猜得像」和「查得到」区分开了**——Q11/Q12 我完全可以用 12 个 defines + 一点 NestJS 常识编出一份「LiveChatBotProcessor + 11 个私有方法」的列表，看起来会非常合理，也几乎肯定错。规则 3（诚实的「查不到」比幸运的猜测更值钱）应该继续保留在最前面。

### 7.2 建议加的题型
现在 4 类题（callers / callees / endpoint / file_symbols）都是**正向查询**。缺三类：
1. **负向题**：问一个索引里**确实不存在**的符号 / 一个已删除的函数。测「会不会编」和「NO_MATCH 是否可信」。
2. **陷阱题**：故意问一个**跨包/外部 SDK 调用密集**的方法（比如就用 Q7 这种），标准答案里包含 `proposalSDK.*`。这样能把 §3.2 那类「静默残缺」直接量化成扣分项，而不是靠答题人恰好去反查源码才发现。
3. **stale 题**：故意在一个 dirty / stale 的 repo（现成的：`FPMS-NT-Proposal`、`grpc-web-debugger`、`penguin-src`、`rust-axum-template` 都是 stale）上问一题，测规则 4 是否真的会被触发和传递。本轮 FPMS-NT 全 fresh，规则 4 实际上没被考到。

### 7.3 建议加的评分维度
除了「答对没有」，再记三列：
| 维度 | 本轮实测 |
|---|---|
| 每题工具调用次数 | 最少 1（Q9/Q10），最多 8+（Q11 未果） |
| 每题 token 成本 | 最贵 Q6（66KB 超限落盘）、Q2（860 行方法体） |
| 是否需要人肉解析非结构化字段 | 需要（跨 repo 候选只能读 identityKey 字符串） |

> 理由：一个「答得对但要 8 次调用 + 60KB 输出」的索引，在真实 agent 循环里是不可用的。**准确率之外，还要测「拿到答案的代价」。**

### 7.4 一个更狠的自动化玩法
这 12 题的标准答案其实可以用 `ts-morph` / TypeScript compiler API 自动生成（callers / callees / file symbols 都是编译器原生能力），然后：
- 把 quiz 变成 **CI 里的回归测试**：每次 `penguin index` 后自动跑，输出 precision / recall；
- **recall 掉了就是缺边，precision 掉了就是脏边**，比人工答题客观得多；
- 人工答题（像这次）保留下来专门测**「体感」**：消歧成本、错误码可读性、token 开销、schema 可发现性——这些恰恰是自动化测不出来、但决定 agent 能不能真的用起来的东西。

两者分工：**自动化测数据层，人工测 API 层。** 本轮暴露的 9 个问题里，只有 P0-2（缺边）能被自动化抓到，其余 8 个全是 API 层问题——这说明人工答题这条路值得继续跑。

---

## 8. 附：本轮工具调用统计

| 工具 | 次数 | 备注 |
|---|---|---|
| `index_status` | 1 | 开局锁快照 |
| `knowledge_explore` | 11 | 其中 4 次返回 ambiguous 需二次定位，1 次 66KB 超限落盘 |
| `get_node` | 13 | 全部只为补 file:line，代价是全量源码 |
| `knowledge_search` | 3 | 1 次 path scope 假阴性，2 次 NO_MATCH |
| `knowledge_graph_query` | 6 | 全部失败（入参 schema 猜不出） |
| `explore_graph` | 5 | 全部失败（`start` 形状猜不出） |
| `find_dead_code` | 1 | filter 被忽略，返回错仓库 |
| **合计** | **40** | **有效 25，纯探索 API 形状浪费 12** |

12 题成绩：**完整作答 10 题**（Q7、Q8 带已知缺口标注），**诚实留空 2 题**（Q11、Q12）。
