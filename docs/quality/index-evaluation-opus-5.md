# Penguin 索引质量评估 — Opus 5

> 评估日期 2026-08-29 · 目标仓库 `FPMS-NT@brazil-v2` `3f0f198`
> 全部结论仅来自 Penguin CLI 输出。没有 grep，没有直接打开源码文件。
> 报告中出现的源码片段，全部是 `penguin explore` 的 `implementation.source` /
> `sources[]` 字段返回的内容——即索引自己存的源码。我用它来**交叉检查索引自己的
> 图谱**（"你存的源码里有这个调用，你的 calls 列表里为什么没有"），这是评估手段，
> 不是绕过规则。凡是这样用的地方我都标注了。

---

## 1. Summary

**会用，但只在两类问题上无条件信任它：「谁调用了这个符号」和「改这个符号会波及哪些
endpoint」。** 这两件事上它比 grep 快一个数量级，而且给出的是跨 26 个仓库、跨 gRPC
边界的答案——`explore "gRPC PlayerService.GetFreeSpinPlayerInfo"` 直接从 FPMS-NT 跳进
FPMS-NT-Auth-Player 的 controller，这是 grep 做不到的。

**不信任的是「这个符号调用了什么」。** callee 图有系统性缺口（构造函数调用、接口
派发、回调体内的调用、静态方法调用大量丢失），而且——这是最严重的问题——
`completeness.status` 在这些缺口上照样返回 `"complete"`。我拿到过一个函数，索引说它
`calls: []`、`completeness: complete`，而索引自己存的源码里明摆着有 5 个调用
（详见 §5.1）。一个会自信地报告"完整"的不完整答案，比一个承认自己不知道的答案危险。

**第二类问题是 text 输出会把错误渲染成空结果。** `penguin callers CMSGenBaseResponse
--repo FPMS-NT` 打印 `(none)`；同一次查询的 `--json` 是 `resultStatus:
"query_error"`。如果我按 text 输出下结论，我会告诉团队"这个函数没人调用"，而真相是
8 个调用者。

条件：**用 `--json`，永远用 `--json`；`calls` 只当下界不当全集；`--repo` 别信，它在
一半命令里被静默忽略。**

---

## 2. Part A answers

### Q1
```
answer:
- apps/promotion/src/budget/budget-base-response.ts:26 — success
- apps/promotion/src/budget/budget-base-response.ts:34 — forbidden
- apps/promotion/src/budget/budget-base-response.ts:42 — internalError
- apps/promotion/src/budget/budget-base-response.ts:50 — notFound
- apps/promotion/src/budget/budget-base-response.ts:58 — unauthorized
- apps/promotion/src/budget/budget-base-response.ts:66 — statusUnspecified
- apps/promotion/src/budget/budget-base-response.ts:74 — illegalArgs
- apps/promotion/src/budget/budget-base-response.ts:82 — alreadyExists
tool used: explore("CMSGenBaseResponse", --repo FPMS-NT) → ambiguous(2)
          → explore("node_e8e51538-1f09-436e-92f1-bac9e5221eb5")
confidence: high — evidence.incomingByType.calls = 8，与列表数量一致
```
八个调用者全在定义文件内部（都是包装 `CMSGenBaseResponse` 的状态构造器）。同名符号在
`libs/common/base-response.ts:452` 还有一个，必须先解歧义。

**两步。** 第一次查询返回：
```
"diagnostics": ["ambiguous target: 2 matches", "\"CMSGenBaseResponse\" matches 2 symbols — specify one."]
```
好在 `ambiguousCandidates` 直接给了 nodeId，第二步就成了。

### Q2
```
answer:
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:191 — getRuntimeContext
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:59  — evaluateStateAndResetIfPeriodExpired
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:324       — shouldSkipAccumulate
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:74  — accumulatePlayerDeposit
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:21  — evaluateState
- apps/riskControl/src/antiAddiction/deposit-limit-config.service.ts:122 — isNotConfigured
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:241       — flushStateSnapshot
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:314       — isLimitReached
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:276       — recordDepositLimitChange
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:157 — notifyStateChanged
tool used: explore("accumulatePlayerDeposit") → ambiguous(6) → explore("node_cf76d4d7-…")
confidence: high
```
**这题是全卷答得最漂亮的一题。** 10 个 callee，我拿索引自己存的
`implementation.source` 逐行数了一遍，正好 10 个调用点，一个不多一个不少，
`externalCalls: []` 也对（这个方法确实不碰任何 npm 包）。

解歧义成本：6 个候选里 3 个是 `nodeType: "field"`、`filePath: null` 的
`this.accumulatePlayerDeposit` 影子节点，纯噪音。

### Q3
```
answer:
两个 handler（两个 app 各有一份同路由的 controller）：

A) apps/livechat/src/http-health-check/http-health-check.controller.ts:12-15 — check
   ↳ apps/livechat/src/http-health-check/http-health-check.service.ts:20-60 — check
     ↳ 索引报告 calls: []，completeness: "complete" —— 这是错的，见下

B) libs/tools/src/http-health-check/http-health-check.controller.ts:12-15 — check
   ↳ libs/tools/src/http-health-check/http-health-check.service.ts:35-65 — check
     ↳ libs/common/base-redis.service.ts:717 — ping
     ↳ libs/common/base-redis.service.ts:721 — getConnectionStr
tool used: flow("GET /healthcheck", --repo FPMS-NT --json)
          → explore(node_2d0fdeda-…) / explore(node_e5a33b40-…) / explore(node_e271da17-…)
confidence: medium —— B 链完整，A 链在 service 层断了，索引没有承认它断了
```
A 链断裂的证据（`explore(node_e5a33b40-…)`）：
```
calls: []
external [] completeness {'status': 'complete', 'externalCallCount': 0}
```
而同一次调用返回的 `implementation.source` 是：
```ts
this.mongooseHealth.pingCheck(`[${key}][${connectionString}]`, { connection })
() => this.typeOrmHealth.pingCheck('postgres')
const dbConnectionResult = await this.healthCheck.check(checks);
const redisResult = await redisInstance.ping();
console.info(`[${key}][${redisInstance.getConnectionStr()}]`, redisResult);
```
5 个调用，图里 0 个，状态"complete"。B 链的同名方法能解析出 `ping` /
`getConnectionStr`，差别在 A 用了 `Object.entries(...).map(([key, connection]) => …)`
的解构回调，B 用了预先算好的 `this.cachedRedisEntries`。**回调体里的调用会丢。**

两条链都漏了 `this.healthCheck.check(...)`（`@nestjs/terminus`），且 `externalCalls`
也是空的。

### Q4
```
answer:
- apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts:10  — class LiveChatBotProcessor
- apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts:20  — constructor
- apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts:34  — _initializeChatBotClient
- apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts:41  — create
- apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts:60  — destroy
- apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts:73  — _getChatbotClient
- apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts:83  — _releaseChatbotClient
- apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts:87  — _initBot
- apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts:97  — updateBotAccessToken
- apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts:103 — _getBotMatrixClient
- apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts:110 — delay   [kind=function]
- apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts:156 — updateNewAccessToken
tool used: filesymbols(branch_10012ad4-067a-4749-aafb-7a9c4f5c133d, <path>)
confidence: high（但见下面的保留）
```
保留：`delay` 被标成顶层 `function` 却夹在 `_getBotMatrixClient(:103)` 和
`updateNewAccessToken(:156)` 之间。看行号分布，它更像嵌套在方法里的局部箭头函数，被
提升成了跟 class method 同级的条目。这不影响"列出所有定义"这个答案本身，但意味着
symbol kind 不能拿来判断作用域。

### Q5
```
answer（离开本仓库的调用，6 个）:
- class-validator      → IsEnum        (line 16)
- class-validator      → IsArray       (line 19)
- class-validator      → ArrayMinSize  (line 20)
- class-validator      → ArrayMaxSize  (line 21)
- class-validator      → ValidateNested(line 22)
- class-transformer    → Type          (line 23)
tool used: explore("DynamicThresholdVipConfigDto", --repo FPMS-NT)
confidence: high（对这 6 个）/ medium（对"完整"这个判断）

完整吗 —— 对这个符号来说，是的，而且索引明确承认了它自己的边界：
  diagnostics: ["6 call(s) go to external packages and cannot be resolved to
                repo symbols — see externalCalls; the calls list is incomplete"]
  completeness: {"status": "partial", "externalCallCount": 6}
我怎么知道的：索引返回的 source 里，这个类只有 6 个装饰器 + 2 个字段声明，没有方法体。
6 个装饰器全部出现在 externalCalls 里，逐行号对得上。
```
一个缺口：`@Type(() => DynamicThresholdCellLevelConfigDto)` 引用了一个**仓内**类型，
它没有出现在 `calls` 里，只体现为 `outgoingByType.references: 1`。所以"这个符号依赖
谁"要看两个字段，`calls` 一个字段是不够的。

### Q6
```
answer: 77 个候选。scope = repo FPMS-NT / branch brazil-v2 / path prefix apps/admin/ /
判据 = "no inbound calls/references/handles/tests"。
tool used: deadcode(--repo FPMS-NT --path apps/admin/ --json)
confidence: 对"图上无入边"这个事实 high；对"真的是死代码"这个结论 **low**
```
完整清单（77 条）：

```
apps/admin/inteceptor/external.module.ts:14 — useFactory
apps/admin/inteceptor/external.module.ts:48 — ExternalModule
apps/admin/inteceptor/payment-external.service.ts:18 — constructor
apps/admin/libs/repositories/fpms/admin/game/game-repository.module.ts:19 — GameRepositoryModule
apps/admin/libs/repositories/fpms/admin/game/game-repository.ts:9 — constructor
apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.module.ts:19 — PlatformAnnouncementRepositoryModule
apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:8 — constructor
apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:13 — findById
apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:25 — findOne
apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:29 — find
apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:36 — update
apps/admin/libs/repositories/fpms/schemas/game.schema.ts:166 — GameDocument
apps/admin/libs/repositories/fpms/schemas/platform-announcement.schema.ts:44 — PlatformAnnouncementDocument
apps/admin/libs/spi/address/sites/base/base-address.provider.ts:12 — BaseAddressProvider
apps/admin/libs/spi/address/sites/base/base-address.provider.ts:13 — getAddressDetail
apps/admin/libs/spi/address/sites/bp/bp-address.provider.ts:14 — BpAddressProvider
apps/admin/libs/spi/address/sites/bp/bp-address.provider.ts:15 — getAddressDetail
apps/admin/src/address/address.controller.ts:6 — AddressController
apps/admin/src/address/address.controller.ts:7 — constructor
apps/admin/src/address/address.module.ts:11 — AddressModule
apps/admin/src/address/address.service.ts:10 — constructor
apps/admin/src/admin/admin.controller.ts:11 — AdminController
apps/admin/src/admin/admin.controller.ts:12 — constructor
apps/admin/src/admin/admin.module.ts:80 — AdminModule
apps/admin/src/admin/admin.service.ts:31 — constructor
apps/admin/src/admin/admin.service.ts:48 — onModuleInit
apps/admin/src/admin/admin.service.ts:263 — onModuleDestroy
apps/admin/src/admin/admin.service.ts:267 — onApplicationShutdown
apps/admin/src/admin/dto/check-has-permission.dto.ts:21 — constructor
apps/admin/src/admin/dto/update-platform-config.dto.ts:148 — constructor
apps/admin/src/config/config.controller.ts:13 — ConfigController
apps/admin/src/config/config.controller.ts:14 — constructor
apps/admin/src/config/config.module.ts:27 — ConfigModule
apps/admin/src/config/config.service.ts:17 — constructor
apps/admin/src/config/dto/get-config.dto.ts:13 — constructor
apps/admin/src/config/dto/get-eid-config-by-eid.dto.ts:12 — constructor
apps/admin/src/config/dto/get-platform-config-by-platform-id.dto.ts:8 — constructor
apps/admin/src/http-health-check/http-health-check.module.ts:27 — useFactory
apps/admin/src/http-health-check/http-health-check.module.ts:51 — HttpHealthCheckModule
apps/admin/src/jackpot/dto/update-live-jackpot-config.dto.ts:20 — JackpotConfigItemDto
apps/admin/src/jackpot/executors/jackpot.executor.ts:41 — constructor
apps/admin/src/jackpot/executors/jackpot.executor.ts:48 — onModuleInit
apps/admin/src/jackpot/executors/jackpot.executor.ts:150 — executeSuccess
apps/admin/src/jackpot/executors/jackpot.executor.ts:157 — executeReject
apps/admin/src/jackpot/jackpot-executor.module.ts:18 — useFactory
apps/admin/src/jackpot/jackpot-executor.module.ts:54 — JackpotExecutorModule
apps/admin/src/jackpot/jackpot.controller.ts:11 — JackpotController
apps/admin/src/jackpot/jackpot.controller.ts:12 — constructor
apps/admin/src/jackpot/jackpot.module.ts:20 — useFactory
apps/admin/src/jackpot/jackpot.module.ts:28 — JackpotModule
apps/admin/src/jackpot/jackpot.service.ts:21 — CreateAdminProposalResponse
apps/admin/src/jackpot/jackpot.service.ts:31 — constructor
apps/admin/src/jackpot/jackpot.service.ts:37 — checkPendingProposal
apps/admin/src/main.ts:31 — bootstrap
apps/admin/src/platform-announcement/dto/delete-player-mail.dto.ts:13 — constructor
apps/admin/src/platform-announcement/dto/read-player-mail.dto.ts:11 — constructor
apps/admin/src/platform-announcement/platform-announcement.controller.ts:10 — PlatformAnnouncementController
apps/admin/src/platform-announcement/platform-announcement.controller.ts:11 — constructor
apps/admin/src/platform-announcement/platform-announcement.module.ts:17 — PlatformAnnouncementModule
apps/admin/src/platform-announcement/platform-announcement.service.ts:12 — constructor
apps/admin/src/platform/dto/get-platform-country.dto.ts:9 — constructor
apps/admin/src/platform/platform-cache.manager.ts:37 — constructor
apps/admin/src/platform/platform.controller.ts:10 — PlatformController
apps/admin/src/platform/platform.controller.ts:11 — constructor
apps/admin/src/platform/platform.module.ts:13 — PlatformModule
apps/admin/src/platform/platform.service.ts:14 — constructor
apps/admin/src/player/admin-player.controller.ts:11 — constructor
apps/admin/src/player/admin-player.module.ts:11 — AdminPlayerModule
apps/admin/src/player/admin-player.service.spec.ts:11 — PlayerClientGrpcMock
apps/admin/src/player/admin-player.service.spec.ts:16 — createDto
apps/admin/src/player/admin-player.service.spec.ts:20 — createBaseResponse
apps/admin/src/player/admin-player.service.ts:14 — constructor
apps/admin/src/player/dto/unbind-player-phone-number.dto.ts:3 — UnbindPlayerPhoneNumberDto
apps/admin/test/e2e/setup-jest-e2e.ts:3 — initEnv
apps/admin/test/unit/admin/admin.service.spec.ts:37 — createAdminTestingModule
apps/admin/test/unit/admin/admin.service.spec.ts:64 — createUpdatePlatformConfigRequest
apps/admin/test/unit/admin/platform-cache.manager.spec.ts:99 — countryResult
```

**这 77 条里绝大多数不是死代码。** 按 title / path 分类统计（77 条全量）：
`constructor` 27 条、`@Module` 类 13 条、`@Controller` 类 6 条、`*.spec.ts`/`test/`
内的符号 6 条、`useFactory` 4 条、NestJS 生命周期钩子（`onModuleInit` /
`onModuleDestroy` / `onApplicationShutdown`）4 条、mongoose Document type 2 条、
SPI provider 类 2 条、`bootstrap` 入口 1 条 —— **合计 65 / 77**。这些全部由 DI 容器 /
装饰器 / 运行时反射 / 测试框架驱动，图上本来就不会有入边。工具的 note 里确实写了这条
免责声明：

```
verify: DI, reflection, framework magic, dynamic import, and public entry points
are false positives.
```

但把免责声明放在结果里、把 77 条噪音原样端出来，等于把过滤工作整个推给使用者。
在一个 NestJS 仓库里这条命令的信噪比接近于 0。

一个真值得看的假阳性（说明缺口不止 DI）：
`apps/admin/test/unit/admin/admin.service.spec.ts:37 — createAdminTestingModule`。
`explore` 说它 `CALLERS: []`，但它是同文件里的 testing-module 工厂——一定被
`beforeEach` / `it(...)` 的回调体调用。这不是 DI 假阳性，这是**回调体内的调用丢边**
（跟 Q3 A 链同一个根因）。

### Q7
```
answer:
- apps/promotion/src/free-spin/controllers/free-spin.internal.controller.ts:19 — addPlayerFreeSpin
- apps/promotion/src/modules/growth-task/services/reward-dispatcher.service.ts:182 — dispatchFreeSpin
- apps/promotion/src/reward-grant/adapters/free-spin-grant.adapter.ts:30 — dispatch
- apps/promotion/src/winsday-billion/services/reward-grant.service.ts:65 — grantFreeSpin
- apps/promotion/src/modules/color-land/services/color-land-reward.service.ts:47 — dispatchReward
- apps/promotion/src/physical-gift/processors/redeem-physical-gift.processor.ts:88 — redeemPhysicalGift
- apps/promotion/src/special-event/services/special-event-mission.service.ts:1731 — claimTaskReward
- apps/promotion/src/winsday-billion/services/post-win-share.service.ts:457 — grantFreeSpin
tool used: explore("addPlayerFreeSpin") → ambiguous(10) → explore("node_c628b4a7-…")
confidence: medium —— 索引自己说这 8 条里有 1 条是猜的，但不说是哪条
```
原文：
```
diagnostics: ["1 INFERRED edge(s) — some relations are best-guess, verify", …]
confidence: {"level": "low", "minimum": 0.45, "inferredEdges": 1, "totalEdges": 118}
```
`evidence.incomingByType.calls = 8`，跟列表数量一致，所以 8 条都在。但**没有任何字段
告诉我哪一条是 inferred**。我拿到一个"其中一条可能是错的"的清单，却无法把它剔掉——
这条警告等于把整个清单降级了。

顺带：`diagnostics` 说 `reachable from 1 HTTP route(s)`，`routes` 字段里写的是
`gRPC FreeSpinInternalService.AddPlayerFreeSpin`。gRPC 被 diagnostics 叫成 HTTP。

### Q8
```
answer（仓内 10 个）:
- libs/tools/src/repositories/player/fpms/logs2/open-promo-code-template/open-promo-code-template-repository.ts:16 — findActiveOpenTemplate
- libs/tools/src/clickhouse/pcr-clickhouse.service.ts:54 — query
- libs/tools/src/repositories/player/fpms/log/player-top-up-record/player-top-up-record-repository.ts:16 — findByProposalId
- libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:190 — getPlayerLevelWithPlayerLevelObjId
- libs/tools/src/client-grpc/payment-client-grpc/payment-client-grpc.ts:195 — DeductPlayerCredit
- apps/promotion/src/event-bus/producer.routes.ts:31 — emitEvent
- libs/common/common.ts:1399 — warn
- libs/tools/src/fpms-internal-server/fpms-internal-server.service.ts:173 — createProposal
- libs/common/common.ts:1397 — log
- libs/tools/src/repositories/player/fpms/log/player-top-up-record/player-top-up-record-repository.ts:27 — addUsedEvent

外部（4，全部 @snsoft/proposal-sdk）:
- proposalSDK.getProposalTypeList (line 1317)
- proposalSDK.getProposalData     (line 1332)
- proposalSDK.getProposalData     (line 1338)
- proposalSDK.getProposalData     (line 1407)
tool used: explore("applyOpenPromoCode", --repo FPMS-NT)
confidence: medium —— completeness 自称 partial，我认为实际缺口比它承认的更大
```
唯一调用者：`apps/promotion/src/promo-code/promo-code.processor.ts:704 — processPromoCode`。

一个观察：`evidence.outgoingByType.calls = 11`，但 `calls` 数组只有 10 项。用 nodeId 重
跑 `penguin calls` 同样是 10。差的那条大概是同一目标的第二次调用被按节点去重了——
合理，但这意味着 `evidence` 的计数和列表长度不能互相校验。

### Q9
```
answer:
handler: apps/promotion-event-scheduler/src/vip-cohort/vip-cohort-trigger.controller.ts:44 — triggerRetentionRisk
  ↳ apps/promotion/src/modules/vip-cohort/services/vip-cohort-runner.service.ts:101 — run
（外部：@nestjs/common Query，line 46）
tool used: flow("POST /internal/vip-cohort/retention-risk", --repo FPMS-NT)
          → explore("triggerRetentionRisk", --repo FPMS-NT)
confidence: high
```
handler 一步命中，`routes: [{route: "POST /internal/vip-cohort/retention-risk",
via: "direct"}]`，还带上了 `vip-cohort-trigger.controller.spec.ts` 作为测试。
索引存的 source 确认它就只调 `this.runner.run(...)` 一个仓内函数，
`this.logger.log(...)` 被归成 `emits_log: 1` 而不是 call——这是设计选择，说得通。

但 `flow` 的树形渲染是错的，见 §5.3。

### Q10
```
answer:
- apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts:18  — class LiveChatConvoProcessor
- apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts:20  — constructor
- apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts:35  — updateConversationReview
- apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts:62  — updateConversationTag
- apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts:97  — getConversationTag
- apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts:113 — _endConversation
- apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts:213 — storeConversationData
- apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts:300 — _createConversation
- apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts:466 — getConversationList
- apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts:527 — data          ⚠ STALE
- apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts:553 — updateConversationTagList
- apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts:563 — tagObjects     ⚠ STALE
tool used: filesymbols(branch_10012ad4-…, <path>)
confidence: medium —— 两个条目被索引自己标记为 stale
```
**按规则 4 如实转达：** `data:527` 和 `tagObjects:563` 后面带 `(stale)` 标记，我不把它们
当作当前状态。

这里有个说不通的地方：`penguin status` 对同一个分支报的是
`trust.stale = False / worktreeState = clean / headCommit == indexedCommit / dirtyFiles = 0`，
同时 `staleSymbols = 725`。一个"干净且已对齐"的分支上挂着 725 个陈旧符号，两个信号互相
矛盾，我无从判断该信哪个。详见 §5.6。

### Q11
```
answer（externalCalls 报告的 6 个）:
- @nestjs/common → ExecutionContext (line 20)   ← 其实是类型标注，不是调用
- @nestjs/common → CallHandler      (line 20)   ← 同上
- rxjs           → Observable       (line 20)   ← 同上
- rxjs           → map              (line 24)
- rxjs           → catchError       (line 31)
- rxjs           → of               (line 35)
tool used: explore("intercept", --repo FPMS-NT) → ambiguous(14) → explore("node_a39de83e-…")
confidence: high（对"索引给了什么"）

完整吗 —— **不完整，而且能证明。**
```
索引自己存的 source（`implementation.source`）里，下面这些离开本仓库的调用一个都没
出现在 `externalCalls` 里：

| 源码里的调用 | 来自 | 在 externalCalls 里？ |
|---|---|---|
| `context.getHandler()` | `@nestjs/common` ExecutionContext | ❌ |
| `next.handle()` | `@nestjs/common` CallHandler | ❌ |
| `.pipe(...)` | `rxjs` Observable | ❌ |
| `new CommonPb.BaseResponse({...})` ×2 | protobuf 生成包 | ❌ |
| `this.logger.error(...)` | — | 只体现为 `emits_log: 1` |

同时它把 3 个**纯类型标注**（`ExecutionContext` / `CallHandler` / `Observable` 出现在
第 20 行的签名里）算成了"调用"。所以这个列表既漏又多：**漏掉全部"在导入对象上调方法"
和全部构造函数调用，多算了类型引用。**

判断依据是索引自己返回的 source 与它自己返回的 `externalCalls` 对不上——不需要打开
任何文件。

### Q12
```
answer:
- apps/promotion/src/modules/growth-task/services/reward-dispatcher.service.ts:66 — dispatchMud
- apps/promotion/src/mud/controllers/mud.internal.controller.ts:18 — addPlayerMud
- apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts:155 — addPlayerMudToRewardRecordBatch
- apps/promotion/src/reward-grant/adapters/mud-grant.adapter.ts:24 — dispatch
- apps/promotion/src/winsday-billion/services/reward-grant.service.ts:107 — grantMud
- apps/promotion/src/modules/color-land/services/color-land-reward.service.ts:47 — dispatchReward
- apps/promotion/src/special-event/services/special-event-mission.service.ts:2323 — claimTaskRewardByTaskId
- apps/promotion/src/winsday-billion/services/post-win-share.service.ts:504 — grantMud
tool used: explore("addPlayerMudDisbursement", --repo FPMS-NT)
confidence: high
```
**一次命中，零解歧义**，`confidence.level = "high"`、`inferredEdges = 0`、
`evidence.incomingByType.calls = 8` 与列表一致。跟 Q7 结构完全对称的一题，
Q7 要两步且带 inferred 警告，这题一步且干净——同样的 codebase、同样的形状，
结果质量不一致，这本身是个信息。

### Q13
```
answer（仓内 10 个）:
- apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:1404 — incrementMessageDedup
- apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:1415 — checkAndAddEventSession
- libs/tools/src/manager/fpms-platform-cache/fpms-platform-cache-manager.ts:36 — getPlatformByPlatformId
- libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:242 — getPlayerInfoInternal
- libs/tools/src/manager/player-level-cache/player-level-cache-manager.ts:41 — getPlayerLevelByPlayerLevelObjId
- libs/tools/src/repositories/common/proposal-type/proposal-type-repository.ts:18 — getProposalTypeByName
- libs/common/common.ts:258 — getStartAndEndDate
- apps/promotion/src/leaderboard/leaderboard.service.ts:365 — getTotalRewardCountForDay
- libs/common/common.ts:1236 — createGrpcMetadataWithTrace
- libs/common/common.ts:1399 — warn

外部（2）:
- @snsoft/proposal-sdk → proposalSDK.getProposalData (line 693)
- @snsoft/proposal-sdk → proposalSDK.createProposal  (line 756)

唯一调用者: apps/promotion/src/pulsar/leaderboard-reward/leaderboard-reward.consumer.ts:60 — handleMessage
tool used: explore("createLeaderBoardRewardProposal", --repo FPMS-NT)
confidence: high（对上述 12 条）—— 但这个方法调的东西不止这 12 个
```
逐行核对索引存的 source，上面 12 条全部正确、位置对得上。**漏掉的**：

- `new LeaderboardRewardRejectError(...)` —— 仓内类的构造函数，源码里出现 9 次，
  图里只体现为 `outgoingByType.throws: 9`，`calls` 里一条都没有。
- `new Types.ObjectId(playerData.playerLevelObjId)` —— mongoose 的外部构造函数调用，
  `externalCalls` 里没有。

**构造函数调用（`new Foo()`）不进 call graph。** 这跟 Q11 的
`new CommonPb.BaseResponse(...)` 是同一条规律，两处独立证据。

### Q14
```
answer:
handler: apps/promotion/src/free-spin/controllers/free-spin-http.controller.ts:20 — getPlayerFreeSpinInfoRestful
  ↳ apps/promotion/src/free-spin/processors/get-player-free-spin-info.transformer.ts:11 — transformRestfulReqToNt
  ↳ apps/promotion/src/free-spin/processors/get-player-free-spin-info.processor.ts:117 — execute
（外部：@nestjs/common Body line 21 / Headers line 22 —— 又是把参数装饰器当调用）
tool used: flow("POST /promotion/GetPlayerFreeSpinInfo", --repo FPMS-NT)
          → explore("getPlayerFreeSpinInfoRestful", --repo FPMS-NT)
confidence: high
```
`routes: [{route: "POST /promotion/GetPlayerFreeSpinInfo", via: "direct"}]`，索引存的
source 里 handler body 只有这两个调用，完全吻合。再往下的链条见 §3.2（B2）。

---

## 3. Part B write-ups

### B1 · 入职第一天：FPMS-NT

先说结论：**Penguin 能给我一张不错的地形图，给不了我一张作战地图。** 我能说出这个仓
库有哪些子系统、哪些文件是枢纽；我说不出"哪些入口最忙"，因为索引里根本没有这个查询。

#### 我跑了什么

```sh
penguin status --json                 # 先确认能不能信
penguin coverage --repo FPMS-NT --json
penguin onboarding FPMS-NT            # ← 完全没用，见下
penguin architecture --json           # ← --repo 被忽略
penguin repograph FPMS-NT --json      # ← 号称 top hubs，没有 degree
penguin communities 400 --json        # ← --repo 被忽略，只能自己过滤
penguin files FPMS-NT --json          # ← 这个有用
```

#### 结构：这是一个 NestJS monorepo，24 个 app + 6 个 lib

`penguin files FPMS-NT --json` 返回 3333 个文件，按顶层目录聚合：

```
 1686  apps/promotion          ← 一半的代码在这里
  589  libs/tools              ← 共享 gRPC client / repository / redis / manager
  293  apps/payment
  127  apps/user-engagement
  102  apps/livechat
   66  apps/admin
   66  libs/common             ← common.ts / enum.ts / types.ts / base-repository
   55  apps/riskControl
   48  apps/push
   46  apps/provider
   41  apps/offline-casino
   29  apps/cms
   23  apps/promotion-scheduler
   22  apps/recommend
   15  apps/card-system
   13  apps/promotion-event-scheduler
   10  apps/auth · 10 apps/internal · 8 apps/livechat_scheduler
   5×4 各类 *_scheduler · 4 apps/player · 3 apps/scraper-schedule
```

一句话：**`apps/promotion` 是主战场，`libs/tools` + `libs/common` 是所有 app 的公共
底座，剩下十几个 `*-scheduler` 是 cron 侧车。**

#### 子系统：来自 community 检测（这是全场最好用的一个命令）

`penguin communities 400 --json`（我自己在客户端按 `repos == ["FPMS-NT"]` 过滤，因为
`--repo` 无效）给出的簇，带 degree，可读性很好：

| 簇 | 规模 | 核心成员（degree） | 我的解读 |
|---|---|---|---|
| #5 | 3085 | `libs/common/common.ts`(336) · `enum.ts`(293) · `base-repository/base-repository.ts`(220) · `constants.ts`(156) · `types.ts`(148) | **公共内核**。改这里等于改全仓库 |
| #6 | 1802 | `libs/tools/src/vault/vault-fetcher.ts`(149) · `promotion.module.ts`(114) · `promotion/libs/utils/constants.ts`(105) | **promotion 主体 + Vault 配置层** |
| #9 | 703 | `apps/payment/libs/utils/commonServices.ts`(87) · `payment.module.ts`(78) · `errorCodeConstants.ts`(53) | **支付子系统**，自带一套 error code 体系 |
| #12 | 552 | `libs/tools/src/redis2/redis2.service.ts`(116) · `libs/common/base-redis.service.ts`(68) · `redisCms.service.ts`(61) | **Redis 访问层**（注意有 redis1/redis2/redisCms 三套） |
| #20 | 398 | color-land transformer/service + `event-configs.schema.ts` | 活动玩法：Color Land |
| #24 | 304 | `player-client-grpc.ts`(110) · `frontend-game-provider.processor.ts`(42) | **跨服务边界：玩家信息 + 游戏商** |
| #28 | 287 | winsday-billion constants/redis/module/controller | 活动玩法：Winsday Billion |
| #30 | 281 | `getSecret`(301) · `VaultFetcher`(288) · `vault-providers.ts`(257) | **配置中心**，degree 最高的单点 |
| #51 | 216 | livechat redis/matrix/agent/core processor | 在线客服（基于 Matrix） |
| #74 | 160 | probability-config service/controller/repository ×2 | 概率配置 |

#### 我会从哪读起

1. `libs/common/common.ts` + `enum.ts` + `types.ts` —— 簇 #5 的中心，所有 app 都依赖。
2. `libs/tools/src/vault/vault-fetcher.ts` —— `getSecret` degree 301，全仓最高，配置
   怎么来的必须先搞清。
3. `apps/promotion/src/promotion/promotion.module.ts` —— 主 app 的装配清单，一眼看完
   promotion 挂了哪些模块。
4. `libs/tools/src/client-grpc/` —— 所有跨服务出口都在这里；顺手能看到本仓库和
   FPMS-NT-Auth-Player / Payment / Provider 的契约。
5. 挑一条端到端的链走一遍，比如 `penguin flow "POST /promotion/GetPlayerFreeSpinInfo"`
   （见 B2），一次就能看到 controller → processor → gRPC → 隔壁仓库 controller 的完整
   形状。

#### 置信度：**中等偏低**

- 结构（哪些 app、谁是枢纽）：**高**。文件清单和 community degree 是硬数据。
- 入口（哪些 endpoint 最忙）：**答不出来**。见下。
- 运行时形态（几个进程？谁跟谁部署在一起？消息中间件是什么？）：**答不出来**。
  我只在 community 里瞥见 `apps/promotion/src/pulsar/…`，推断有 Pulsar，但这是我从
  文件名猜的，不是索引告诉我的。

#### 索引没告诉我、而我需要的

**1. "最忙的入口"这个查询不存在。** 这是 B1 明确要求的东西，我拿不到：

- `penguin architecture` 的 `entryPoints` 是**按字母序截断的前 30 个**，且不分仓库：
  ```
  AccountActivityService.GetAccountActivityRecord
  AccumulativeBetRewardFrontendService.GetAccumulativeBetRewardProgression
  … 一直到 AuthService.CreatePlayerInfoAPI 就没了
  ```
  没有排序，没有 degree，没有 repo 归属。26 个仓库共 1638 个 endpoint 节点，这里给我
  看 30 个 A 开头的。

- `penguin repograph FPMS-NT` 帮助里写着 "repo/branch graph (top hubs by degree)"，
  实际 text 输出只有一行：
  ```
  150 nodes, 524 edges
  ```
  `--json` 的 150 个节点里 `degree` 字段全是 `null`，而且排在最前面的是一堆
  `*.spec.ts` 文件。对 onboarding 毫无价值。

- `penguin architecture` 的 `hubs` 是全局的，前几名
  （`genFxStatusMessage`、`playerDetailController`、`marketingController`）全部来自
  FPMS 那个老 JS 仓库，跟 FPMS-NT 没有关系。

**没有任何一条命令能回答"给我 FPMS-NT 按入边排序的前 20 个 endpoint"。**

**2. `penguin onboarding FPMS-NT` 是一个空模板。** 完整输出：

```markdown
## 1. 系统边界
- FPMS-NT: /Users/shieng/Desktop/Projects/fpmsnt
## 2. 主要 actor 和术语
- 术语来自已索引的 service、endpoint、entity 和 notes。
## 3. 关键请求/事件流程
- 使用 `penguin flow <endpoint>` 查看已验证的线性流程。
## 4. 数据和状态
- 使用 `penguin architecture` 查看当前索引概况。
…
## 8. 推荐阅读顺序
- Search → Context → Graph → Evidence
```

八个小节，七个是"你去跑另一个命令"。唯一的实际内容是仓库路径。这是**最应该服务
B1 的命令**，而它一个符号、一个模块、一个 endpoint 都没提。上面那张地形图是我用
`files` + `communities` 手工拼出来的，`onboarding` 没帮上任何忙。

**3. `--repo` / `--branch` 在 `architecture` 和 `communities` 上被静默忽略。**
两个命令加不加 scope 输出完全一致（我对比过 `--repo FPMS-NT` 和
`--branch branch_10012ad4-…`，字节级相同）。help 里 `--repo/--branch` 写在
"Global: … (scope selectors)"下面，所以这不是我用错了。

**4. 拿不到"这个仓库有哪些 endpoint"的清单。** `search` 上限 50 条且返回的是源码片段
不是结构化 endpoint；`flow` 要求我**已经知道** endpoint 名字。新人恰恰不知道。

---

### B2 · 追一条请求：`POST /promotion/GetPlayerFreeSpinInfo`

选它是因为它跨了两个仓库，能同时考察链路深度和跨服务能力。

#### 命令

```sh
penguin flow "POST /promotion/GetPlayerFreeSpinInfo" --repo FPMS-NT
penguin explore getPlayerFreeSpinInfoRestful --repo FPMS-NT
penguin explore GetPlayerFreeSpinInfoProcessor.execute --repo FPMS-NT
penguin explore getFreeSpinPlayerInfo --repo FPMS-NT      # → ambiguous(5)
penguin explore node_9620972d-1315-4131-96b2-09371edefa04  # PlayerClientGrpc
penguin explore getPlayerFreeSpinClaimed --repo FPMS-NT   # → ambiguous(6)
penguin explore node_0128a2ce-824d-4045-a732-2cfa3d2398d5  # Redis2Service
penguin explore "gRPC PlayerService.GetFreeSpinPlayerInfo"
```

#### 这条请求上发生了什么

```
POST /promotion/GetPlayerFreeSpinInfo
│
├─ FreeSpinHttpController.getPlayerFreeSpinInfoRestful
│    free-spin-http.controller.ts:20    (@Controller('promotion'), @Post(...))
│    ├─ GetPlayerFreeSpinInfoTransformer.transformRestfulReqToNt(data, headers)
│    │    get-player-free-spin-info.transformer.ts:11
│    │    ——把 REST body + header 拼成内部 DTO（token 从 header 来，不在 body 里）
│    └─ GetPlayerFreeSpinInfoProcessor.execute(payload)
│         get-player-free-spin-info.processor.ts:117
│
├─ 1) 用 token 换玩家身份 —— 跨服务
│    PlayerClientGrpc.getFreeSpinPlayerInfo(token)
│      libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:206
│      ├─ new Metadata(); metadata.add('authorization', `Bearer ${token}`)
│      ├─ firstValueFrom( this.playerService.GetFreeSpinPlayerInfo({}, metadata) )   [rxjs]
│      ├─ catchGrpcError(error)  → player-client-grpc.ts:160
│      └─ PlayerClientGrpcTransformer.transformGetFreeSpinPlayerInfoResPbToNt(result)
│           player-client-grpc.transformer.ts:8
│      ↓  invokes（跨仓库！）
│    gRPC PlayerService.GetFreeSpinPlayerInfo
│      ⇒ FPMS-NT-Auth-Player 仓库
│        apps/player/src/player/controllers/player-internal.controller.ts:49
│          getFreeSpinPlayerInfoRes
│        └─ get-free-spin-player-info-res.processor.ts:63 — transformToGrpc
│      失败时：processor 里 .catch() 吞掉，返回 PromotionBaseRes.notFound('Player not found')
│
├─ 2) 三个并发查询（Promise.all）
│    ├─ Redis2Service.freeSpin.getPlayerFreeSpinClaimed(playerData.phoneNumber)
│    │    libs/tools/src/redis2/redis2.service.ts:986
│    │    └─ this.smembers(`freeSpinClaimed:${phoneNumber}`)
│    │         libs/common/base-redis.service.ts:300      ← 数据层落点：Redis SMEMBERS
│    ├─ strategy.verify(verifyFreeSpinPlayerData)          ✗ 图里没有
│    └─ strategy.getOngoingEventIds()                      ✗ 图里没有
│
└─ 3) 组装响应 GetPlayerFreeSpinInfoRes
```

策略对象来自 `VerifyFreeSpinStrategyFactory.createStrategy(freeSpinSessionToken,
category)`（`strategies/verify-free-spin-strategy.factory.ts:12`），入参由
`buildVerifyFreeSpinPlayerData(playerData)`（processor 自己的 `:177`）构造。

#### 链在哪断的，我怎么发现的

**断点 1 —— 接口派发（processor → strategy）。** `explore` 对 processor.execute 报：

```
CALLS:
   libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:206 — getFreeSpinPlayerInfo
   .../strategies/verify-free-spin-strategy.factory.ts:12 — createStrategy
   get-player-free-spin-info.processor.ts:177 — buildVerifyFreeSpinPlayerData
   libs/tools/src/redis2/redis2.service.ts:986 — getPlayerFreeSpinClaimed
external [] completeness {'status': 'complete', 'externalCallCount': 0}
```

四条。而同一次调用返回的 source 里还有：

```ts
const verifyFreeSpinPromise      = strategy.verify(verifyFreeSpinPlayerData);
const ongoingEventObjIdsPromise  = strategy.getOngoingEventIds();
…
baseResponse: PromotionBaseRes.notFound('Player not found'),
```

`strategy.verify` / `strategy.getOngoingEventIds`（`IVerifyFreeSpinStrategy` 接口派
发）和 `PromotionBaseRes.notFound`（静态方法）三个调用不在图里。**这条请求真正的业务
判定逻辑就藏在 `strategy.verify` 后面，而它恰好是断掉的那一条。** 只看图，我会以为这
个 endpoint 除了查 Redis 什么都不干。

发现方式：`completeness: "complete"` 与索引自己存的 source 对不上。如果我信了那个
`"complete"`，我不会去看 source，也就不会发现。

**断点 2 —— 跨服务方向是单向的。** 跨仓库这一跳本身**做得很好**：

```
$ penguin explore "gRPC PlayerService.GetFreeSpinPlayerInfo"
diagnostics: ['reachable from 1 HTTP route(s) — public-facing',
              'invoked by 15 caller(s) in other services — cross-service contract']
IMPL apps/player/src/player/controllers/player-internal.controller.ts
provenance: [{"edgeType":"invokes","origin":"parser","method":"EXTRACTED","confidence":1,"count":15}]
```

它自动从 FPMS-NT 跳到了 FPMS-NT-Auth-Player，`indexedAt` 都换成了那个仓库的时间戳
（`2026-08-29T02:08:05Z` vs FPMS-NT 的 `01:52:16Z`）。**这是整个工具最亮的一手。**

但反过来查不了：

```
$ penguin callers "gRPC PlayerService.GetFreeSpinPlayerInfo"
(none)
$ penguin impact "gRPC PlayerService.GetFreeSpinPlayerInfo"
(none)
```

`provenance` 里白纸黑字写着 15 条 `invokes` 边存在于库里，`callers` /
`invokedDynamicallyBy` / `blastRadius` 三个字段全是空数组，没有任何字段列出这 15 个调
用方。想知道"我改这个 gRPC 契约会影响哪些服务"——**这正是跨服务索引最该回答的问
题**——现在只能得到 `(none)`，一个跟"真的没人调"完全无法区分的答案。

**断点 3 —— 单个词条歧义严重。** 链上每往下走一步就要解一次歧义：
`getFreeSpinPlayerInfo` 5 个候选、`getPlayerFreeSpinClaimed` 6 个候选。多出来的候选
里，绝大部分是 spec 文件里 mock 对象的 `field` 影子节点
（`…e2e.spec.ts::mockPlayerClientGrpc::getFreeSpinPlayerInfo`）。这条链走完花了
8 条命令，其中 3 条纯粹是在解歧义。

---

### B3 · 改签名会炸掉什么：`FpmsPlatformCacheManager.getPlatformByPlatformId`

```sh
penguin explore getPlatformByPlatformId --repo FPMS-NT      # → ambiguous(19)
penguin explore node_cea72db6-abab-4112-9f57-6478f6652d2d
penguin impact  node_cea72db6-… --json
penguin affected libs/tools/src/manager/fpms-platform-cache/fpms-platform-cache-manager.ts
```

目标：`libs/tools/src/manager/fpms-platform-cache/fpms-platform-cache-manager.ts:36`，
签名 `async getPlatformByPlatformId(platformId: string)`。索引主动预警：

```
diagnostics: ['high fan-in: 11 callers — changes ripple widely']
```

#### 直接调用者（11 个，全部 file:line）

```
apps/promotion/src/lucky-coins/processors/redeem-lucky-coins.processor.ts:93        — redeemPlayerLuckyCoins
apps/provider/src/provider/provider.service.ts:89                                   — notifyJackpotPlayer
apps/user-engagement/src/callback/processors/callback.processor.ts:29               — callBackToUser
apps/promotion/src/leaderboard/leaderboard.processor.ts:104                         — dispatchLeaderboardMudAndFreespin
apps/promotion/src/leaderboard/leaderboard.processor.ts:579                         — createLeaderBoardRewardProposal
apps/promotion/src/physical-gift/processors/redeem-hotel-voucher.handler.ts:71      — handle
apps/promotion/src/promo-code/promo-code.processor.ts:111                           — getPromoCode
apps/promotion/src/promo-code/promo-code.processor.ts:704                           — processPromoCode
apps/provider/src/game-provider/frontend/frontend-game-provider.processor.ts:112    — getRecentPlayedGames
apps/provider/src/game-provider/frontend/frontend-game-provider.processor.ts:266    — getLoginURL
apps/provider/src/game-provider/frontend/frontend-game-provider.processor.ts:1064   — transferToProvider
```

跨 4 个 app：`promotion` / `provider` / `user-engagement`。

#### 传递影响（`impact`，26 个节点）

除上面 11 个，还多出 15 个上游：

```
apps/promotion/src/lucky-coins/lucky-coins.controller.ts:29                    — redeemPlayerLuckyCoins
apps/promotion/src/lucky-coins/services/redeem-player-lucky-coins-internal.service.ts:29 — execute
apps/promotion/src/lucky-coins/controllers/lucky-coins.controller.ts:86        — redeemPlayerLuckyCoins
apps/promotion/src/lucky-coins/controllers/lucky-coins.internal.controller.ts:184 — redeemPlayerLuckyCoinsInternal
apps/provider/src/provider/provider.controller.ts:30                           — notifyJackpotPlayer
apps/user-engagement/src/callback/controllers/callback.controller.ts:26        — callBackToUser
apps/promotion/src/pulsar/leaderboard-reward/leaderboard-reward.consumer.ts:60 — handleMessage
apps/promotion/src/physical-gift/processors/redeem-physical-gift.processor.ts:88 — redeemPhysicalGift
apps/promotion/src/physical-gift/controllers/physical-gift.controller.ts:31    — redeemPhysicalGift
apps/promotion/src/promo-code/controllers/frontend-promo-code.controller.ts:17 — getPromoCode
apps/promotion/src/promo-code/controllers/frontend-promo-code.controller.ts:34 — applyPromoCode
apps/promotion/src/promo-code/controllers/promo-code.controller.ts:91          — processPromoCode
apps/provider/src/game-provider/frontend/frontend-game-provider.controller.ts:26 — getRecentPlayedGames
apps/provider/src/game-provider/frontend/frontend-game-provider.controller.ts:38 — getLoginURL
apps/provider/src/game-provider/frontend/frontend-game-provider.controller.ts:87 — transferToProvider
```

#### 会炸的对外入口（`affected`，14 条）

```
changed 17 · impacted 157 · tests 28 · routes 14
  gRPC v1.TransactionInternalService.RedeemPlayerLuckyCoinsInternal
  gRPC FrontendPlatformService.GetPlatformConfig
  gRPC FrontendGameProviderService.TransferToProvider
  gRPC promotion.v1.FrontendLuckyCoinsService.RedeemPlayerLuckyCoins
  gRPC FrontendPlatformService.GetAllLevel
  gRPC FrontendGameProviderService.GetLoginURL
  gRPC FrontendPromotionService.GetPromoCode
  gRPC FrontendGameProviderService.GetRecentPlayedGames
  gRPC PromoCodeService.ProcessPromoCode
  POST /provider/notifyJackpotPlayer
  gRPC FrontendPromotionService.ApplyPromoCode
  gRPC v1.FrontendPhysicalGiftService.RedeemPhysicalGift
  gRPC RecaptchaCallbackService.CallbackToUser
  gRPC v1.FrontendLuckyCoinsService.RedeemPlayerLuckyCoins
```

**这一段是 Penguin 最有说服力的输出。** "改一个 cache manager 的签名会打到 14 个对外
接口，其中有玩家侧的 GetLoginURL 和 RedeemPhysicalGift"——这个判断 grep 给不了我，
它需要传递闭包 + 路由归属。

#### 真要动手，我信到什么程度

**信 80%，但不敢只拿它当唯一依据，三个理由：**

**1. 给的是"调用者的定义行"，不是"调用点的行"。** 清单里
`promo-code.processor.ts:704 — processPromoCode` 的 704 是 `processPromoCode` 这个方法
的起始行，`getPlatformByPlatformId(...)` 的实际调用点在方法体内部某处。
`leaderboard.processor.ts:579 — createLeaderBoardRewardProposal` 更明显：我在 Q13 看过
这个方法的完整 source，`getPlatformByPlatformId` 的调用出现在方法体大约 1/3 处，离
579 有几十行。**改签名时我需要跳到调用点，索引把我送到函数开头。** 11 个调用者里有
两对同文件（promo-code ×2、frontend-game-provider ×3），逐个翻方法体是免不了的。

而且"每个调用者只有一条记录"意味着：如果某个函数里调用了目标两次，我只会看到一行。
Q8 里 `evidence.calls = 11` vs 列表 10 项已经证明了这种去重确实存在。

**2. 只覆盖静态解析得到的边。** 从 Q3 / Q6 / B2 的证据看，至少这几类调用不进图：
接口派发（`strategy.verify`）、静态方法（`PromotionBaseRes.notFound`）、
回调体内的调用、构造函数（`new Foo()`）。如果有人是通过接口类型或 DI token 拿到这个
manager 再调的，这 11 条里就不会有它。**这个清单是下界，不是全集。**

对这次这个具体目标我不算太担心（`FpmsPlatformCacheManager` 是个具体类，靠构造函数注
入），但这个保留是结构性的，换个走接口的目标就会咬人。

**3. 索引自己也没看清这个方法内部。** `explore` 给的 callee 是：

```
CALLS:
   libs/common/common.ts:754 — async
completeness {'status': 'complete', 'externalCallCount': 0}
```

一个叫 **`async`** 的符号。它对应源码里的 `ExecuteWithSpan.async(...)`——被拆成了一个
名为 `async` 的节点。而真正重要的
`this.platformRepository.findOne({ platformId })`、`this.cacheManager.get/set(cacheKey)`
全部不在图里（它们在 `ExecuteWithSpan.async` 的回调体内，又是回调丢边）。

也就是说：**索引知道谁调用了这个函数，但不知道这个函数会读数据库。** 如果我的改动
涉及缓存 key 或返回结构，"它到底碰了什么存储"这个问题索引答不了，还告诉我
`completeness: complete`。

**实际会怎么做**：拿 `impact` 的 26 条 + `affected` 的 14 条路由当**回归测试范围**
（这个用途它非常够用，`affected` 还给了 `tests 28`），但改签名之前仍然会用编译器
（`tsc`）兜底，而不是靠这个清单收工。

---

### B4 · 找一个真问题：`PlayerClientGrpc` 有两份，消费方被劈成两半

```sh
penguin explore getFreeSpinPlayerInfo --repo FPMS-NT     # → ambiguous(5)，看到两个同名 class
penguin filesymbols branch_10012ad4-… libs/tools/src/client-grpc/player-client-grpc.ts
penguin filesymbols branch_10012ad4-… libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts
penguin deadcode --repo FPMS-NT --path libs/tools/src/client-grpc/ --json
penguin explore getFPMSPlayersInfo / getAllPlayerLevel / getPlayerInfoWithPlayerId --repo FPMS-NT
```

#### 发现

仓库里有**两个都叫 `PlayerClientGrpc` 的类**：

| | 旧（扁平文件） | 新（目录版） |
|---|---|---|
| 路径 | `libs/tools/src/client-grpc/player-client-grpc.ts` | `libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts` |
| class 行号 | :107 | — |
| 方法数 | 13 | 21 |

**9 个方法在两边同名同在**：`constructor` · `onModuleInit` · `catchGrpcError` ·
`getPlayerProfileByJwt` · `getPlayerLevelWithPlayerLevelObjId` · `getFreeSpinPlayerInfo` ·
`getPlayerInfoInternal` · `getPlayersProfileInternal` · `getPlayerInfo`

这不是"名字撞车"，是**同一份实现被复制了一遍**。对比两边的 `getFreeSpinPlayerInfo`：

```
# 旧 player-client-grpc.ts:176
CALLS: player-client-grpc.ts:120 — catchGrpcError
       player-client-grpc/player-client-grpc.transformer.ts:8 — transformGetFreeSpinPlayerInfoResPbToNt
EXTERNAL: rxjs → firstValueFrom(line 181), catchError(line 183)
CALLERS: (空)

# 新 player-client-grpc/player-client-grpc.ts:206
CALLS: player-client-grpc/player-client-grpc.ts:160 — catchGrpcError
       player-client-grpc/player-client-grpc.transformer.ts:8 — transformGetFreeSpinPlayerInfoResPbToNt
EXTERNAL: rxjs → firstValueFrom(line 211), catchError(line 213)
CALLERS: check-free-spin-event.processor.ts:14 · get-player-free-spin-info.processor.ts:117
```

结构逐行同构，连行号都只差 30。**注意旧文件里的方法引用的 transformer 是新目录下的
那个**（`player-client-grpc/player-client-grpc.transformer.ts:8`）——迁移做了一半。

#### 迁移停在了半路上，这是可以下手的部分

`deadcode --path libs/tools/src/client-grpc/` 的结果里，旧文件贡献了 7 条：

```
libs/tools/src/client-grpc/player-client-grpc.ts:111 — constructor
libs/tools/src/client-grpc/player-client-grpc.ts:113 — onModuleInit
libs/tools/src/client-grpc/player-client-grpc.ts:127 — getPlayerProfileByJwt
libs/tools/src/client-grpc/player-client-grpc.ts:143 — getPlayerLevelWithPlayerLevelObjId
libs/tools/src/client-grpc/player-client-grpc.ts:176 — getFreeSpinPlayerInfo
libs/tools/src/client-grpc/player-client-grpc.ts:247 — getPlayerInfoInternal
libs/tools/src/client-grpc/player-client-grpc.ts:283 — getPlayerValidCreditByPlayerObjId
```

**"两边都有"的方法在旧文件里全部零入边**——消费方已经切到新类了。

但旧文件删不掉，因为还有 3 个方法**只存在于旧文件**且仍在被调用（这三个 `explore`
一次命中、无歧义，说明新类里没有同名实现）：

```
getFPMSPlayersInfo        (:159) ← apps/user-engagement/src/pulsar/campaign-pulsar-consumer.service.ts:50
getAllPlayerLevel         (:299) ← apps/offline-casino/src/platform-entry-config/platform-entry-config.processor.ts:20
getPlayerInfoWithPlayerId (:194) ← apps/promotion/src/modules/event-configs-consumer/services/event-configs-consumer-common.service.ts:32
                                 ← apps/promotion/src/modules/event-configs-consumer/services/event-configs-consumer-common.service.ts:77
                                 ← apps/promotion/src/pulsar/kyc-success/kyc-success-processor/kyc-success-processor.ts:40
```

#### 为什么这是真问题，不是"maybe"

1. **两个 `@Injectable()` 同名 class 同时被不同模块注入**，靠 import 路径区分。谁都可
   能 import 错一个，TypeScript 不会报错（结构兼容），运行时才会发现方法不存在。
2. **修 bug 会修错文件。** `catchGrpcError` 两边各一份（旧 :120 / 新 :160），
   `getFreeSpinPlayerInfo` 两边各一份。有人修了新的那份，旧的那份还在给
   user-engagement / offline-casino 的调用路径服务。
3. **两份都在维护 gRPC 契约。** 隔壁 `PlayerService` 改 proto 的时候，两个 client 都要
   跟着改，漏一个就是运行时 500。

#### 建议的动作（成本很低）

把仅存于旧文件的 3 个方法（`getFPMSPlayersInfo` / `getAllPlayerLevel` /
`getPlayerInfoWithPlayerId`）搬进新目录的类，改掉那 5 个调用点，删掉
`libs/tools/src/client-grpc/player-client-grpc.ts` 整个文件。7 个死方法随之消失，
同名 class 的歧义消失，`explore getFreeSpinPlayerInfo` 的候选从 5 个降到 3 个。

#### 附带发现（同一批查询里顺手看到的）

- **`libs/tools/src/redis2/executor/free-spin.executor.ts` 整个类零入边。**
  `FreeSpinExecutor.getPlayerFreeSpinClaimed(:27)` 和 `Redis2Service` 里的同名方法
  （`redis2.service.ts:986`）逻辑一模一样（都是 `smembers(freeSpinClaimed:<phone>)`），
  实际被三个 caller 用的是 `Redis2Service` 那个。executor 版本疑似一次未完成的重构残留。
  *（这条我标为"疑似"：executor 通过构造函数注入函数式依赖，索引无法解析
  `this.smembers`，所以"零入边"里有一部分可能是索引的盲区而非事实。）*

- **`http-health-check` 有两份且行为已经分叉。** `apps/livechat/src/http-health-check/`
  和 `libs/tools/src/http-health-check/` 各有一套 controller+service，都注册在
  `@Controller('healthcheck')`。但 `libs/tools` 版用的是预计算的
  `this.cachedHealthChecks` / `this.cachedRedisEntries`，`apps/livechat` 版还在每次请求
  里 `Object.entries(this.mongodbInstances ?? {}).map(...)` 现算——后者还多查了
  mongo，前者没有。同名同路由、不同健康语义。

---

## 4. What worked well

**1. `explore` 的 callee 列表在"纯方法调用"场景下是逐行精确的。**

Q2 是最硬的证据。`explore(node_cf76d4d7-…)` 给了 10 个 callee，我拿它自己返回的
`implementation.source` 数了一遍：

```ts
const context = await this.stateService.getRuntimeContext(playerId);            // 1
const before  = await this.stateService.evaluateStateAndResetIfPeriodExpired(…); // 2
if (this.shouldSkipAccumulate(topUpType)) return before;                         // 3
await this.stateService.accumulatePlayerDeposit(…);                              // 4
const after = await this.stateService.evaluateState(playerId, context);          // 5
if (!this.configService.isNotConfigured(after.config)) {                         // 6
  await this.flushStateSnapshot(playerId, before, after);                        // 7
if (this.isLimitReached(before, after)) {                                        // 8
  await this.recordDepositLimitChange(…);                                        // 9
  await this.stateService.notifyStateChanged(playerId, after);                   // 10
```

10 个调用点，10 条边，每条都带正确的目标文件+行号，跨了 3 个 service 文件。
`externalCalls: []` 也对。**没有一条多余，没有一条遗漏。** 这就是它状态好的时候的样子。

**2. 跨服务的 gRPC 跳转是真的能跳。**

```
$ penguin explore "gRPC PlayerService.GetFreeSpinPlayerInfo"
IMPL apps/player/src/player/controllers/player-internal.controller.ts
freshness {'indexedAt': '2026-08-29T02:08:05.174Z'}      ← 注意，另一个仓库的时间戳
```

我从 FPMS-NT 的一个 client 方法出发，一条命令落到了 FPMS-NT-Auth-Player 的 controller。
grep 在这里是彻底没辙的（proto 方法名和 TS 方法名不同、跨 repo）。这是这个工具存在的
理由。

**3. `affected` 把"改一个文件"翻译成"哪些对外接口会动"。**

```
$ penguin affected libs/tools/src/manager/fpms-platform-cache/fpms-platform-cache-manager.ts
changed 17 · impacted 157 · tests 28 · routes 14
  gRPC FrontendGameProviderService.GetLoginURL
  gRPC v1.FrontendPhysicalGiftService.RedeemPhysicalGift
  …
```

一条命令，从文件路径到玩家侧接口清单。做 PR 风险评估、圈回归范围，这一条命令抵得上
半小时。

**4. 主动预警写得很到位（当它触发的时候）。**

```
'high fan-in: 11 callers — changes ripple widely'
'calls 1 remote gRPC endpoint(s) — cross-service dependency'
'invoked by 15 caller(s) in other services — cross-service contract'
'"X" is indexed but has no outgoing calls/references — it may be a terminal/leaf
 symbol, or its callees aren'\''t indexed.'
```

最后一条尤其好：它区分了"叶子节点"和"callee 没索引到"两种可能，没有假装确定。
`deadcode` 的免责声明（`verify: DI, reflection, framework magic…`）同样诚实。
**问题不是它不会警告，是这些警告在最该出现的地方（§5.1）没出现。**

**5. `communities` 是我没预期到的好东西。**

带 degree 的模块聚类，直接给出"公共内核 / promotion 主体 / 支付 / Redis 层 / 各活动玩
法"的分层，比我自己看目录树准。B1 的地形图基本是这一条命令拼出来的。

**6. 歧义候选带 `identityKey` 和 `nodeId`，可以机器消费。**

```json
{"nodeId":"node_e8e51538-…","identityKey":"repo_c58d…::apps/promotion/src/budget/budget-base-response.ts::CMSGenBaseResponse",
 "filePath":"apps/promotion/src/budget/budget-base-response.ts","startLine":14}
```
歧义虽然烦，但至少第二步是确定的：挑 nodeId 重跑就行，不用猜。

---

## 5. What did not work

### 5.1 `completeness: "complete"` 是假的，而且是危险的假

这是全篇最严重的一条。`completeness.status` 只反映"有没有未解析的**外部包**调用"，
但它的措辞（complete / partial）会被读成"callee 列表完不完整"。结果是：**callee 图有
洞的时候，它照样报 complete。**

三处独立证据。

**(a) `apps/livechat/src/http-health-check/http-health-check.service.ts:20 check`**
```
calls: []
external [] completeness {'status': 'complete', 'externalCallCount': 0}
```
索引自己存的 source：
```ts
this.mongooseHealth.pingCheck(`[${key}][${connectionString}]`, { connection })
() => this.typeOrmHealth.pingCheck('postgres')
const dbConnectionResult = await this.healthCheck.check(checks);
const redisResult = await redisInstance.ping();
console.info(`…${redisInstance.getConnectionStr()}…`, redisResult);
```
**5 个调用，0 条边，状态 "complete"。**

**(b) `GetPlayerFreeSpinInfoProcessor.execute`（B2 那条链的核心）**
```
CALLS: 4 条
external [] completeness {'status': 'complete', 'externalCallCount': 0}
```
source 里另有 `strategy.verify(...)`、`strategy.getOngoingEventIds()`、
`PromotionBaseRes.notFound(...)`。**这个 endpoint 的业务判定逻辑整个不在图里，状态
"complete"。**

**(c) `FpmsPlatformCacheManager.getPlatformByPlatformId`（B3 的目标）**
```
CALLS: libs/common/common.ts:754 — async
completeness {'status': 'complete', 'externalCallCount': 0}
```
source 里有 `this.platformRepository.findOne({ platformId })` 和
`this.cacheManager.get/set(...)`。**"这个函数会不会读数据库"答错了，状态 "complete"。**

**(d) 加个反例证明这个字段本身就不是在描述 callee 完整性**：查一个不存在的符号
```
$ penguin explore node_x
diagnostics: ['"node_x" is not indexed — no symbol, note, or gRPC endpoint matches this name.']
resolutionStatus: "no_match"
completeness: {"status": "complete", "externalCallCount": 0}
```
**一个 `no_match` 的错误响应，completeness 是 "complete"。** 同理，Q1/Q7/Q11 的
`ambiguous` 错误响应也全部是 `completeness: "complete"`。这个字段在错误路径上照样输出
"完整"。

我的判断：**这个字段现在的语义（"外部调用有没有全解析"）和它的命名（completeness）
不匹配，而且在错误路径上不设防。** 一个 AI agent 读到 `completeness: complete` +
`calls: []` 会直接下结论"这个函数不调用任何东西"，然后写出错误的分析。这比没有这个
字段更糟。

### 5.2 text 输出把错误渲染成 `(none)`

```
$ penguin callers CMSGenBaseResponse --repo FPMS-NT
(none)
```
同一次查询的 `--json`：
```json
{"mode":"who_calls","nodes":[],
 "diagnostics":{"resolutionStatus":"ambiguous","resultStatus":"query_error", …}}
```

**`query_error` 被渲染成 `(none)`。** 真相是 8 个调用者。

同样的问题在跨服务查询上更致命：
```
$ penguin callers "gRPC PlayerService.GetFreeSpinPlayerInfo"
(none)
$ penguin impact "gRPC PlayerService.GetFreeSpinPlayerInfo"
(none)
```
而同一个节点的 `explore` 说 `invoked by 15 caller(s) in other services`，
`provenance` 里 `{"edgeType":"invokes","count":15}`。

brief 里那句"`--json` shows fields the text output abbreviates"低估了这个问题：这不是
"简略"，是**把错误和空结果混成同一个字符串**。text 模式还有第二个硬伤——
`penguin callers <nodeId>` 的输出是：
```
symbol	success
symbol	forbidden
…
```
**没有 file:line。** 任何需要 file:line 的任务（这份 quiz 的每一题）都必须走 `--json`。

**建议：`(none)` 只在 `resultStatus == "ok" && nodes == []` 时打印；其余情况打印
`error: ambiguous (N matches) — 用 --json 看候选` 之类，并以非零退出码返回。**

### 5.3 `flow` 的树形缩进把 callee 挂到了错误的父节点上

```
$ penguin flow "POST /internal/vip-cohort/retention-risk" --repo FPMS-NT
`POST /internal/vip-cohort/retention-risk` _(endpoint)_
  ↳ handles → `triggerRetentionRisk`
    ↳ calls → `run`
    ↳ references → `VipCohortRunResult`
      ↳ calls → `isDisabledBySwitch`
      ↳ calls → `finishRun`
      ↳ calls → `vipCohortRunLockKey`
      …
```

按缩进读，`isDisabledBySwitch` / `finishRun` 是 **`VipCohortRunResult` 这个类型** 的
callee。这不可能——`VipCohortRunResult` 是个接口。它们实际是 `run` 的 callee。

看 `--json` 就明白了：`steps[]` 是一个**扁平的、只带 depth 字段的数组**，text 渲染器
把所有 depth=N 的节点挂到最后一个 depth=N-1 的节点下面。`GET /healthcheck` 也一样：

```
  ↳ handles → `check`      ← livechat controller
  ↳ handles → `check`      ← libs/tools controller
    ↳ calls → `check`      ← 这两个 service 分别属于上面哪个 controller？
    ↳ calls → `check`
      ↳ calls → `getConnectionStr`
      ↳ calls → `ping`
```
四个 `check`，没有文件名，无法判断谁调谁。我必须用 `--json` 拿 filePath，再逐个
`explore` 才能把两条链分开。

**`flow` 的整个卖点是"线性执行链"，而 text 输出恰恰无法表达链的分叉。** 而且
text 模式完全不带 filePath——同名节点根本没法区分。

**建议：`steps` 带上 `parentNodeId`；text 渲染按父子关系缩进；每行加上
`file:line` 后缀。**

### 5.4 `--repo` / `--branch` 在部分命令上被静默忽略

```
$ penguin architecture --repo FPMS-NT
repos: FPMS(4br), FPMS-CCMS(1br), FPMS-NT(1br), … （全部 26 个）
hubs: genFxStatusMessage, playerDetailController, monitorPaymentController, parseInt, …
```

`hubs` 全部来自 FPMS 那个老 JS 仓库。我加不加 `--repo`、加 `--branch branch_10012ad4-…`，
输出**字节级相同**。`communities` 同样。

这两个命令恰好是"了解一个仓库"最该用的两个，而它们无视 scope。help 里
`--repo/--branch/--commit/--snapshot` 明确列在 "Global: … (scope selectors)"，所以
这不是用法错误。

**沉默是最坏的处理方式**——如果它报 `--repo not supported for this command` 我会立刻
改路子，现在我看到的是一份"看起来像答案"的错误答案，`hubs` 里那些 `playerDetailController`
足以把不熟悉这些仓库的人带沟里。

### 5.5 `field` 影子节点把歧义放大到无法忍受

每一个 `this.foo` / `mockBar.foo` 都会生成一个 `nodeType: "field"`、`filePath: null`、
`startLine: null` 的节点，并且参与符号名解析。

```
$ penguin explore getPlatformByPlatformId --repo FPMS-NT
ambiguous target: 19 matches
```
19 个候选里 **15 个是 field 影子节点**，其中 10 个来自 `*.spec.ts` 的 mock 对象：
```
…event-reward-tickets.processor.spec.ts::mockPlatformCacheManager::getPlatformByPlatformId
…redeem-hotel-voucher.handler.spec.ts::fpmsPlatformCacheManager::getPlatformByPlatformId
…promo-code.processor.spec.ts::<object>::getPlatformByPlatformId
```
真正的 symbol 只有 4 个。`addPlayerFreeSpin` 10 个候选里 8 个是 field。
`intercept` 14 个里 3 个是 field。

这些节点**没有 filePath、没有行号、没有 source**，选中它们只会得到一个空壳
（见 5.7）。它们对"我要找哪个符号"这个问题零贡献，纯粹是噪音。

**建议：symbol 名解析默认只匹配 `nodeType == "symbol"`，field 只在
`--include-fields` 时参与；至少把 `*.spec.ts` 里的 mock field 排除掉。** 光这一条
就能让 Part A 的 14 题里至少 5 题从两步变一步。

### 5.6 staleness 的两个信号互相矛盾，而且不可操作

`penguin status` text：
```
FPMS-NT	brazil-v2(live,stale=725)
```
同一次查询的 `--json`：
```json
{"staleSymbols": 725,
 "trust": {"stale": false, "staleReason": null, "worktreeState": "clean",
           "headCommit": "3f0f1984…", "indexedCommit": "3f0f1984…",
           "dirtyFiles": [], "changedFiles": 0, "coverageGaps": []}}
```

**工作区干净、HEAD 和已索引 commit 完全一致、`trust.stale = false`，同时 725 个符号是
陈旧的。** 这两个说法我调和不了。而 `explore` 只看 `trust`，所以每次查询都报
`freshness: {stale: False}`——**725 个陈旧符号在 `explore` 里完全不可见**，只有
`filesymbols` 会在个别行尾打 `(stale)`（Q10 的 `data:527` / `tagObjects:563`）。

反过来，`stale=0` 也会骗人。另一个分支：
```
text:  aug-28-1841-cloud-script(live,stale=0)
json:  {"staleSymbols": 0, "trust": {"stale": true, "staleReason": "worktree_dirty",
                                     "dirtyFiles": ["CLAUDE.md"]}}
```
text 那列写的是 `staleSymbols`，`trust.stale` 是另一回事。**同一个词 "stale" 在同一行
输出里指两个不同的东西。**

还有第三种 stale。任何解析失败的查询都会返回：
```json
"freshness": {"stale": true, "reason": "trust_unavailable", "indexedAt": null,
              "coverageGaps": ["trust_unavailable"]}
```
Q1 / Q11 / B3 的 ambiguous 响应全是这个。**"数据陈旧"和"你的查询没解析出来"共用同一
个 `stale: true` 字段。** brief 的规则 4 让我"转达 staleness"，但我拿到的
`stale: true` 有一半其实是"查询失败"。

**我完全不知道该拿这 725 个陈旧符号怎么办**：`penguin index` 不会跑（HEAD 已对齐、
worktree 干净），也没有任何命令能列出"哪 725 个"。

### 5.7 `explore` 会"成功"返回一个空壳

```
$ penguin explore genFreeSpinClaimedKey --repo FPMS-NT
resolutionStatus: "resolved"
implementation: {"nodeId":"node_eee96736-…","title":"genFreeSpinClaimedKey",
                 "nodeType":"field","kind":null,"filePath":null,
                 "signature":null,"source":null,"branches":[]}
sources: []
diagnostics: ['"genFreeSpinClaimedKey" is indexed but has no outgoing calls/references…']
scope: FPMS-NT@brazil-v2 3f0f198 (aligned)
```

`resolved`、有 nodeId、有 scope 行——**看起来是成功的答案，实际上一个字段都没有。**

而这个方法是真实存在的。`FreeSpinExecutor.getPlayerFreeSpinClaimed` 的 source（索引自
己给的）里写着 `const key = this.genFreeSpinClaimedKey(phoneNumber);`。但
`filesymbols` 对那个文件只列出 8 个符号：

```
class FreeSpinExecutor:1 / constructor:2 / getPlayerFreeSpinClaimed:27 /
getEventObjId:32 / getGenerateTime:37 / deleteFreeSpinSessionIdKey:44 /
lockFreeSpinEventInProgress:49 / storeFreeSpinKey:59
```

**`genFreeSpinClaimedKey` 不在里面。** 一个类的私有方法在符号索引里缺失，而
`explore` 用一个同名 field 节点把这个缺失掩盖成了 "resolved"。

**这类"resolved 但全空"的响应必须报成 `no_symbol_match`。** 现在的行为会让 agent
以为自己拿到了答案。

### 5.8 `deadcode` 在 NestJS 仓库里信噪比接近 0

`apps/admin/` 77 个候选，分类统计：constructor 27、`@Module` 类 13、`@Controller` 类 6、
测试文件内符号 6、`useFactory` 4、生命周期钩子 4、mongoose Document 2、SPI provider 类 2、
`bootstrap` 1 —— **65 / 77 是框架或测试必然产生的假阳性。**

工具知道这一点（note 里写了 DI/reflection 免责声明），但没有据此过滤。在一个每个
service 都有 constructor、每个模块都是 `@Module` 的仓库里，输出 77 条让人自己筛，
等于没做这件事。

而且假阳性不止 DI 一类：`apps/admin/test/unit/admin/admin.service.spec.ts:37 —
createAdminTestingModule` 是同文件里的 testing-module 工厂，一定被 `beforeEach`/`it`
的回调调用——这是 5.9 的回调丢边导致的假阳性，跟 DI 无关。

**建议：默认排除 `constructor` / `on{Module,Application}*` 生命周期钩子 /
带 `@Module`·`@Controller`·`@Injectable` 装饰器的类 / `useFactory` / `bootstrap` /
`*.spec.ts` 内的符号，把它们收进 `--include-framework` 开关。**
77 条能降到十几条，那十几条才值得看。

### 5.9 callee 图的系统性缺口（四类）

从 Part A + B 的证据里能归纳出四条稳定规律。**每一条我都有至少两处独立证据，且每一处
索引都没有承认自己漏了。**

| 缺口 | 证据 1 | 证据 2 |
|---|---|---|
| **构造函数 `new Foo()`** | Q13：`new LeaderboardRewardRejectError(...)` ×9 → 只有 `throws:9`，`calls` 里 0 条；`new Types.ObjectId(...)` 不在 `externalCalls` | Q11：`new CommonPb.BaseResponse({...})` ×2，两个列表都没有 |
| **回调 / 箭头函数体内的调用** | Q3(a)：`Object.entries(...).map(([k,v]) => this.mongooseHealth.pingCheck(...))` 整块丢失；同名方法在不走回调的 (b) 版本里能解析出来 | B3：`ExecuteWithSpan.async(async () => { this.platformRepository.findOne(...) })` 内的 DB 访问全丢 · Q6：`createAdminTestingModule` 因此显示零入边 |
| **接口派发 / 静态方法** | B2：`strategy.verify()` / `strategy.getOngoingEventIds()`（`IVerifyFreeSpinStrategy`）不在图里 | B2：`PromotionBaseRes.notFound(...)` 静态调用不在图里 |
| **在导入对象上调方法** | Q11：`context.getHandler()` / `next.handle()` / `.pipe(...)` 全不在 `externalCalls`，而**同一行的类型标注** `ExecutionContext`/`CallHandler`/`Observable` 被算成了调用 | Q3：`this.healthCheck.check(checks)`（`@nestjs/terminus`）两个版本都没有 |

第四行还有个反向问题：**类型标注被当成调用计入 `externalCalls`**。
`intercept(context: ExecutionContext, next: CallHandler): Observable<unknown>` 这一行
签名贡献了 3 个"外部调用"。`@Body()` / `@Query()` / `@Res()` 参数装饰器也被算作调用
（Q14 / Q9 / Q3）。所以 `externalCallCount` 这个数字既高估（含类型和装饰器）又低估
（漏方法调用），不能拿来当依赖度量。

### 5.10 "有一条边是猜的，但不告诉你是哪条"

```
$ penguin explore node_c628b4a7-…      # Q7 addPlayerFreeSpin
diagnostics: ['1 INFERRED edge(s) — some relations are best-guess, verify', …]
confidence: {"level":"low","minimum":0.45,"inferredEdges":1,"totalEdges":118}
CALLERS: （8 条，全部长得一样）
```

`provenance` 数组在这个节点上没有区分到边级别，`callers[]` 的每一项也没有
`origin` / `confidence` 字段。**结果是整个 8 条清单被降级到 `confidence: low`，而我无
法把那 1 条剔出去。** 一条不确定的边污染了 7 条确定的边。

**建议：把 `origin`（parser / inferred）和 `confidence` 放到每个 caller/callee 条目
上，而不是只放在汇总里。**

### 5.11 一些较小但真实的摩擦

- **`filesymbols` 只认 branch UUID，不认分支名。**
  ```
  $ penguin filesymbols brazil-v2 apps/livechat/.../livechat-bot-processor.ts
  no indexed repo or branch matches "brazil-v2" — see `penguin status` for the indexed names
  ```
  但 `penguin status` 显示的就是 `brazil-v2`，UUID 只在 `--json` 里。错误信息把我指向
  一个不含所需信息的命令。而且同一个 CLI 里 `--repo FPMS-NT` 用名字、
  `filesymbols` 要 UUID，不一致。

- **`explore` / `calls` / `callers` 对同一个字符串的解析结果不一致。**
  `applyOpenPromoCode`：`explore` 一次命中并返回完整结果；`penguin calls
  applyOpenPromoCode --repo FPMS-NT` 却是 `resolutionStatus: "ambiguous"`。
  `CMSGenBaseResponse` 反过来：两个都 ambiguous，但 `explore` 给候选、`callers` 给
  `(none)`。**同一个解析器应该给同一个答案。**

- **`search` 输出重复。** `penguin search "vip-cohort" --repo FPMS-NT` 里
  `vip-cohort-crons.service.spec.ts:4` 和 `:5` 各出现两次，内容完全相同。50 条上限本来
  就紧，一半浪费在重复上。

- **`repograph <repo>` 的 text 输出只有 `150 nodes, 524 edges`。** help 说是
  "top hubs by degree"，`--json` 里 `degree` 全是 `null`，排序看不出依据，头部全是
  `*.spec.ts`。

- **`coverage` 只给数字不给名单。**
  ```
  $ penguin coverage --repo FPMS-NT --json
  {"discovered":3340,"admitted":3333,"excluded":7,"failed":0,"stale":0}
  ```
  排除了 7 个文件，**没有任何办法知道是哪 7 个**。而 `search` 每次都在提醒
  `warnings: COVERAGE_INCOMPLETE / next: penguin index <repo-path> — refresh stale or
  failed coverage before relying on a negative result`——它让我在下否定结论前先确认覆
  盖，却不告诉我缺口在哪。（注意这里 `stale:0` 又和 `status` 的 `staleSymbols:725`
  对不上，这是第四个 stale 语义。）

- **`diagnostics` 把 gRPC 叫成 HTTP。** Q7/Q12：`reachable from 1 HTTP route(s) —
  public-facing`，而 `routes` 里是 `gRPC FreeSpinInternalService.AddPlayerFreeSpin`。
  在这个 codebase 里"公网 HTTP 入口"和"内部 gRPC 入口"的安全含义差很远。

- **`tests` 字段时有时无。** Q7 的 `addPlayerFreeSpin` 返回 `tests: []`，但它的歧义候
  选里明明有 `redeem-physical-gift-routing.spec.ts` 和
  `redeem-physical-gift.processor.spec.ts` 里的 mock。Q8/Q12/Q13 就都有 `tests`。
  空的 `tests` 不能读成"没有测试"。

---

## 6. Pros and cons

判断基准：**当日常工具用，对手是 grep + 读文件。**

| | Penguin | grep + 读文件 |
|---|---|---|
| **"谁调用了 X"** | ✅ 一到两条命令，跨 26 仓库跨文件，带 file:line。Q12 一次命中 8 个调用者 | ❌ 同名符号无法区分（`getPlatformByPlatformId` 4 个真实定义），`this.foo(` 和 `foo(` 要分别搜 |
| **"X 调用了什么"** | ⚠️ **不可信**。构造函数/回调/接口派发/静态方法系统性丢失，且报 `complete` | ✅ 打开文件从头读到尾，100% 准确，代价是慢 |
| **跨服务 gRPC 追踪** | ✅ **无可替代**。proto 方法名 → 隔壁仓库 controller，一条命令 | ❌ 基本做不到，要人肉对 proto |
| **反向跨服务（谁调这个 gRPC）** | ❌ `(none)`，而库里明明有 15 条边 | ⚠️ 全仓 grep 方法名，慢但能出结果 |
| **改动影响面 / 回归范围** | ✅ **最强项**。`affected` 一条命令给 14 条受影响路由 + 28 个测试 | ❌ 传递闭包靠人肉，路由归属根本算不出来 |
| **精确到调用点行号** | ❌ 给的是调用者**定义行**，不是调用点 | ✅ grep 天然给调用点 |
| **仓库地形 / 模块划分** | ✅ `communities` + `files` 很好用 | ⚠️ 只能看目录树，看不出耦合 |
| **入口清单 / 最忙的接口** | ❌ **没有这个能力**。`entryPoints` 是字母序前 30、不分仓库 | ⚠️ grep `@Controller` 能凑合 |
| **死代码** | ⚠️ 方向对，NestJS 下噪音过大（77 条里过半假阳性） | ❌ grep 做不了 |
| **重复实现检测** | ✅ 歧义候选反而成了线索——两个同名 class 一眼看见（B4） | ⚠️ 得先怀疑才会去搜 |
| **答案可信度自述** | ⚠️ 分裂：`diagnostics` 很诚实，`completeness` 在撒谎 | ✅ 你亲眼看的，你自己负责 |
| **上手成本** | ⚠️ 必须学会：永远 `--json`、field 噪音、UUID vs 名字、哪些命令无视 `--repo` | ✅ 零 |
| **速度** | ✅ 全部亚秒级 | ❌ 大仓库 grep + 读几十个文件 |
| **token 成本（对 agent）** | ✅ 结构化、体量小 | ❌ 读文件极贵 |

**净判断：** 我会把它当**第一跳**——找符号、找调用者、算影响面——但**不会拿它当最后
一跳**。任何"这个函数做了什么"的问题，我仍然会去看代码。它现在是一个优秀的
*导航器*，还不是一个可信的 *阅读替代品*。而 brief 里那句"an AI agent can understand
unfamiliar code from the index faster and more reliably than by grepping and reading
files"——**faster 成立，more reliably 只在入边方向上成立。**

---

## 7. Suggestions

按"能挽回多少错误结论"排序。

### P0 — 修 `completeness`，或者干脆删掉它

**问题**：`completeness: "complete"` 在 callee 图有洞时照样输出，在 `no_match` /
`ambiguous` 的错误响应上也输出（§5.1）。一个 agent 读到它就会停止怀疑。

**改法**（任选，从便宜到贵）：
1. **改名 + 加字段**（半天）。现字段改叫 `externalResolution: complete|partial`，另加
   `calleeGraphCoverage: "unverified"`——因为现在系统根本不知道自己漏没漏。
2. **错误路径一律不输出 completeness**（一小时）。`resultStatus != "has_results"` 时
   这个字段应该是 `null`。这一条最便宜且立刻止血。
3. **真做覆盖校验**（几天）。解析期统计"AST 里的 CallExpression / NewExpression 总数"
   vs "落库的 calls 边数"，差值 > 0 就报 `partial` 并给出未解析的调用点行号。这才是
   使用者真正需要的信号，而且顺带把 §5.9 的四类缺口变成**可见**的。

**收益**：这一条比其余全部加起来都重要。现在的行为会让下游产生**自信的错误结论**，
而这正是 brief 说"a plausible guess hides the exact gap"想避免的东西。

### P0 — text 输出不许把错误渲染成 `(none)`

**问题**：§5.2。`query_error` → `(none)`，8 个调用者变成"没人调用"。

**改法**（一天）：`(none)` 仅在 `resultStatus == "has_results" && nodes.length == 0`
时打印。其他情况打印 `error: <resolutionStatus> (N candidates) — rerun with --json`
并返回非零退出码。顺带给 `callers` / `calls` 的 text 输出补上 `file:line`——现在它只
打 `symbol <name>`，任何需要定位的任务都被逼去用 `--json`。

**收益**：消灭最危险的一类静默错误。成本极低。

### P1 — 补上构造函数调用边

**问题**：§5.9 第一行。`new Foo()` 不产生 `calls` 边。在这个 codebase 里，异常类
（`new LeaderboardRewardRejectError` ×9）、protobuf 消息（`new CommonPb.BaseResponse`）、
mongoose ObjectId（`new Types.ObjectId`）全是 `new`。**"谁在构造这个 DTO / 抛这个异常"
现在完全查不到。**

**改法**：解析器把 `NewExpression` 也当调用点处理，边类型 `constructs`（或直接并入
`calls`）。tree-sitter 层面这是个小改动，主要成本在重新索引。

**收益**：`calls` 从"部分方法调用"变成"大部分调用"。异常传播分析、DTO 使用面分析从
不可能变为可能。

### P1 — symbol 解析默认排除 `field` 影子节点

**问题**：§5.5。`getPlatformByPlatformId` 19 个候选里 15 个是 field，10 个来自
spec mock。这些节点没有 filePath / 行号 / source，选中了也没用。

**改法**（一天）：名称解析默认只匹配 `nodeType == "symbol"`；`--include-fields` 开关
保留旧行为。如果嫌激进，至少排除 `*.spec.ts` / `*.test.ts` 里的 field。

**收益**：Part A 14 题里至少 5 题从两条命令变一条。对 agent 来说，每次歧义都是一轮额
外往返 + 一次挑错节点的机会。

### P1 — 让 `--repo` / `--branch` 要么生效，要么报错

**问题**：§5.4。`architecture` / `communities` 静默忽略 scope，返回全局结果。
`architecture --repo FPMS-NT` 的 `hubs` 全是另一个仓库的符号。

**改法**（半天）：不支持的命令直接报
`--repo is not supported by 'architecture'; use 'penguin repograph <repo>'` 并退出。
支持是更好，但先别骗人。

**收益**：把"看起来对的错答案"变成"明确的拒绝"。

### P1 — caller / callee 条目给出**调用点**行号

**问题**：§B3。清单给的是调用者的定义行，改签名时人要自己去方法体里翻。同一函数里
多次调用被去重成一行（Q8：`evidence.calls = 11` vs 列表 10 项）。

**改法**：`calls` 边上存 `callSiteLine`（解析时就有），
`callers[]` / `calls[]` 每项加 `callSites: [line, …]`。

**收益**：B3 那类任务从"11 个函数，自己去找"变成"17 个调用点，直接跳过去"。这是把
`impact` 从"风险提示"升级成"改动清单"的关键一步。

### P2 — `deadcode` 默认过滤框架符号

**问题**：§5.8。77 条里过半是 constructor / `@Module` / `@Controller` / `useFactory` /
生命周期钩子。

**改法**（一到两天）：默认排除 —— `constructor`、`on{Module,Application}{Init,Destroy,
Bootstrap,Shutdown}`、带 `@Module`/`@Controller`/`@Injectable`/`@Global` 装饰器的类、
`useFactory`/`useValue` 工厂、`bootstrap`、`*.spec.ts` 内的符号。用
`--include-framework` 保留旧行为。输出里给每条标注 `reason`（"no inbound calls" /
"filtered: DI-managed"）。

**收益**：77 → 12 条左右（按上面的分类，只有 12 条落在"其他"）。现在这条命令我不会
用第二次；过滤之后我会。

### P2 — `flow` 输出要能表达分叉

**问题**：§5.3。`steps[]` 只有 depth，text 渲染把所有 depth=N 挂到最后一个
depth=N-1 上，导致 callee 挂在 interface 名下。text 模式还完全没有 filePath，
四个同名 `check` 无法区分。

**改法**：`steps[]` 加 `parentNodeId`；渲染按真实父子关系；每行加
` — path/to/file.ts:LINE` 后缀。

**收益**：`flow` 是这个工具最好卖的命令（"一条命令看懂一个 endpoint"），现在它的
text 输出在有分叉时是**误导性的**。

### P2 — 统一 staleness 的语义

**问题**：§5.6。同一个词在四个地方指四件事：`status` text 的 `stale=N`（符号数）、
`trust.stale`（布尔）、`explore.freshness.stale`（含 `trust_unavailable`，其实是查询
失败）、`coverage.stale`（又是 0）。而且"worktree 干净 + HEAD 对齐 + 725 个陈旧符号"
这个状态我无从处理，也没有命令能列出那 725 个。

**改法**：
- `explore.freshness` 里把"查询失败"拆成独立字段，别复用 `stale`。
- `status` text 那一列改成 `staleSymbols=725`，`trust.stale` 单独一列。
- 加 `penguin status --stale-symbols <repo>` 列出陈旧符号，并说明怎么修（如果
  `penguin index` 修不了，说明是索引 bug 而不是用户操作问题）。

### P2 — 让"resolved 但全空"变成 `no_match`

**问题**：§5.7。`explore genFreeSpinClaimedKey` 返回 `resolutionStatus: "resolved"`、
带 scope 行，但 `filePath` / `source` / `signature` / `branches` 全空——因为它解析到了
一个 field 影子节点，而真正的私有方法根本没进符号索引。

**改法**：解析结果若 `filePath == null && source == null`，报
`no_symbol_match: "X" only exists as a field reference; the defining symbol is not indexed`。
顺带查一下为什么 `FreeSpinExecutor` 的私有方法会缺失——`filesymbols` 对那个文件只
列出 8 个符号，缺的不止一个。

---

### 我想要但完全找不到的能力（这些是新功能，不是修 bug）

**1. 按仓库、按入边排序的 endpoint 清单。**
```sh
penguin endpoints FPMS-NT --sort fan-in --limit 20
```
B1 明确要求"哪些入口最忙"，我拿不到。`entryPoints` 是字母序前 30 且不分仓库，
`repograph` 的 degree 是 null。**新人入职最需要的一条命令不存在。**

**2. 反向跨服务查询：谁在调这个 gRPC 契约。**
边已经在库里（`provenance: {"edgeType":"invokes","count":15}`），只是没有任何输出
字段暴露它。这是**最容易实现、收益最大**的一条——数据都有了，只差一个字段。
改 gRPC proto 的影响面分析现在完全做不了。

**3. "这个符号碰哪些存储"。**
```sh
penguin storage <symbol>     # → mongo collections / redis keys / clickhouse tables
```
B2/B3 里最想问的问题。索引里明明有 `redisCms.service` / `base-redis.service` /
`pcr-clickhouse.service` / `*-repository.ts` 这些明确的数据层符号，把它们打个标记，
再沿 call graph 传递闭包，就能回答"改这个 endpoint 会写哪些 collection"。
现在只能一跳一跳手工往下走，而且走到回调就断（§5.9）。

**4. `penguin onboarding` 真的生成点内容。**
现在八个小节里七个是"你去跑另一个命令"（§B1）。它已经能拿到的数据——
`files` 的目录分布、`communities` 的簇 + degree、该仓库的 endpoint 列表、
`architecture` 的语言分布——填进去就是一份能用的入职文档。**素材全都在库里，
只差把它们拼起来。** 我在 B1 手工做的就是这件事，一个下午的工作量。

**5. 重复实现检测。**
B4 那个 `PlayerClientGrpc` ×2 是我从"歧义候选列表"里**偶然**看到的。既然索引已经知
道两个同名 class 有 9 个同名方法、结构同构、行号偏移固定，它完全可以主动报：
```sh
penguin duplicates --repo FPMS-NT
# PlayerClientGrpc: 2 definitions, 9 overlapping methods, 7 of them dead in the older copy
# GrpcResponseInterceptor: 2 definitions (apps/promotion/libs/interceptor/ vs libs/common/interceptor/)
# GrpcLogger: 2 definitions (apps/livechat/src/ vs libs/tools/src/trace/)
# HttpHealthCheckController/Service: 2 definitions, behaviour diverged
```
上面四条我都是在做别的事情时撞见的。这是这个索引**独有**能力——grep 做不了结构对
比——却没有做成功能。

---

## 8. How it felt to use

**头十五分钟很顺，然后撞上了第一堵墙。**

第一条真正的查询是 Q1，我照 brief 说的先用 `explore`。它说 ambiguous，给了两个候选，
带 nodeId，第二步就出答案了——很好，这正是我期待的交互。然后我出于对照的目的跑了
一遍 `penguin callers CMSGenBaseResponse --repo FPMS-NT`，屏幕上是：

```
(none)
```

**那一刻我意识到，如果我先跑的是这条命令，我会写下"没有函数调用它"，然后交卷。**
真相是 8 个。我回头把 `--json` 加上，看到 `resultStatus: "query_error"`。从那之后我
所有查询都强制走 `--json` + 一个 Python 解析脚本——不是因为我想要更多字段，是因为
**我不再相信 text 输出在说真话。**

这个不信任后来一直没消。`penguin callers "gRPC PlayerService.GetFreeSpinPlayerInfo"`
也是 `(none)`，而 `explore` 同一个节点说"invoked by 15 caller(s) in other services"。
两个命令，同一个数据库，一个说 15 个一个说 0 个。

**第二堵墙是 `completeness`，而它比第一堵更让我不舒服。**

第一次是 Q3。健康检查的 service 报 `calls: []`、`completeness: "complete"`。我差点就
写"这个 handler 不调用任何东西"了——健康检查嘛，听起来也说得通。是因为 `explore` 顺
手把 source 一起返回了，我瞟了一眼，看见五行 `pingCheck` / `healthCheck.check` /
`ping` / `getConnectionStr` 摆在那儿。

**索引把答案和推翻答案的证据装在同一个 JSON 里返回给我。** 这件事本身挺荒诞的，但也
是我唯一的检查手段——之后每一个 `completeness: complete` 我都会去读它自己存的 source
核一遍。B2 追那条 free-spin 链的时候，processor 报了 4 个 callee 和 `complete`，
source 里躺着 `strategy.verify(...)`——那个 endpoint 全部的业务判定就在这个调用后面。
**索引对这条链最重要的一跳一无所知，而且报告说自己完整。**

后来我拿一个不存在的符号试了一下：`penguin explore node_x`，返回
`resolutionStatus: "no_match"`，`completeness: {"status": "complete"}`。
**连"查无此物"都是 complete。** 到这里我就明白这个字段不该被读成它字面的意思了。

**最让人沮丧的一段是 B1。**

这是四个任务里最像真实工作的一个——新人接手一个 3333 文件的 monorepo。我第一条就跑
`penguin onboarding FPMS-NT`，因为名字摆在那儿。返回的是八个小节的空模板，唯一的实
质内容是仓库路径，其余七节都在说"用 `penguin flow`"、"用 `penguin architecture`"。

**这是全场最让我意外的一次。** 不是因为它不好，是因为**它本来是最容易做好的一个**。
后面我用 `files` 拉出目录分布、用 `communities` 拉出带 degree 的模块簇——花了大概四条
命令，拼出来的东西比那个模板有用一百倍。数据全都在库里。`onboarding` 只是没去拿。

然后我想回答"哪些入口最忙"，发现这个查询根本不存在。`architecture` 的 `entryPoints`
是字母序前 30 个、跨全部 26 个仓库——我盯着一屏 `AccumulativeEventConfigAdminService.*`
看了几秒才反应过来它就是从 A 开始截断的。`repograph FPMS-NT` 帮助里写着 "top hubs by
degree"，实际输出是 `150 nodes, 524 edges` 一行；`--json` 里 degree 字段全是 null，
排头的是一堆 spec 文件。三条路都不通。**B1 明确点名要的东西，我最后只能写"答不出来"。**

`--repo FPMS-NT` 被 `architecture` 和 `communities` 静默忽略，我是对比了两次输出发现
字节级相同才确认的。help 里 `--repo` 明明白白写在 "Global: … scope selectors" 下面。
**这种沉默比报错难受得多**——报错我三秒钟换路子，沉默让我盯着一屏 FPMS 老仓库的
`playerDetailController` 想了半天"FPMS-NT 里怎么会有这个"。

**然后它突然让我刮目相看了一次。**

B2 追到 `PlayerClientGrpc.getFreeSpinPlayerInfo`，下一跳是 gRPC，我本来准备写"链在这
里断了，跨服务追不了"。顺手试了一下：

```sh
penguin explore "gRPC PlayerService.GetFreeSpinPlayerInfo"
```

它跳到了 FPMS-NT-Auth-Player 的 `apps/player/src/player/controllers/player-internal.controller.ts`，
`indexedAt` 都换成了那个仓库的时间戳。**一条命令跨了仓库边界。** grep 在这里毫无办
法——proto 方法名和 TS 方法名不一样，两个仓库在不同目录。这是我整个 session 里唯一
一次觉得"这个东西做了别人做不到的事"。

结果下一秒就凉了：想反过来看"这 15 个跨服务调用方是谁"，
`callers` 返回 `(none)`、`impact` 返回 `(none)`、`invokedDynamicallyBy` 是空数组。
`provenance` 里 `{"edgeType":"invokes","count":15}` 白纸黑字。**边在库里，没有一个字
段把它吐出来。** 正向能跳、反向不能查——而"改这个 gRPC 契约会影响谁"恰恰是跨服务索引
最该回答的问题。

**卡得最久的地方是符号歧义。**

`getPlatformByPlatformId` 19 个候选。我一条条读 identityKey，发现 15 个是
`filePath: null` 的 field 影子节点，其中 10 个来自 spec 文件里的 mock 对象：
`…promo-code.processor.spec.ts::<object>::getPlatformByPlatformId`。
选中这些节点会得到什么？我试了一个类似的（`genFreeSpinClaimedKey`）——
`resolutionStatus: "resolved"`，然后 filePath / source / signature / branches 全是 null，
底下还工工整整跟着一行 `scope: FPMS-NT@brazil-v2 3f0f198 (aligned)`。**一个长得像成功
答案的空壳。** 而那个私有方法其实是真实存在的，只是根本没进符号索引——
`filesymbols` 对那个文件只列出 8 个符号，它不在里面。

Part A 十四题，我估计有五题的第二次查询纯粹是在跟这些 field 节点搏斗。对人来说是烦，
对 agent 来说每一次都是一轮额外往返加一次挑错节点的机会。

**什么会让我再用它。**

B3。`affected` 那一条命令——从一个文件路径直接给出
`changed 17 · impacted 157 · tests 28 · routes 14`，然后列出
`gRPC FrontendGameProviderService.GetLoginURL`、
`gRPC v1.FrontendPhysicalGiftService.RedeemPhysicalGift` 这些玩家侧接口。
"改一个 cache manager 会打到 14 个对外接口"——这个判断我人肉算不出来，它一秒钟给我。
写 PR 描述、圈回归范围、给 reviewer 交代风险，这一条命令值回票价。

Q2 也让我印象很深：10 个 callee，我逐行核对索引自己存的 source，一个不多一个不少，
跨 3 个文件全部行号正确。**它状态好的时候是真的准。** 问题从来不是它做不到，是我无
法预先知道这一次它准不准。

**什么会让我不用它。**

就一件事：**我没有办法在不读源码的情况下知道某个答案可不可信。** `diagnostics` 有时
候很诚实——`high fan-in: 11 callers`、`1 INFERRED edge(s)`、
`"X" is indexed but has no outgoing calls…` 这些都写得很好。但同一份输出里的
`completeness: "complete"` 在骗我，而且骗得毫无征兆。Q2 是 complete 且真完整，
B2 的 processor 是 complete 但漏了三个关键调用——**两个响应长得一模一样。**

所以现在我的用法固定成了：**入边方向（谁调我、改我会波及谁）直接用，出边方向
（我调了谁）当成一个下界，然后去读代码。** 这仍然比纯 grep 快很多——它帮我把要读的
文件从几十个缩到三五个。但它没能做到 brief 里说的那件事，即"比读文件更可靠"。

**修好 `completeness` 和 `(none)` 这两条，我对它的信任会立刻上一个台阶。** 这两条都
不是难题——一个是别在错误路径上输出乐观字段，一个是别把错误渲染成空结果。它们之所
以要紧，是因为这个工具的目标用户是 AI agent，而 agent 不会像我这样多疑地去交叉核对
它自己返回的 source。它会读到 `completeness: complete`，然后自信地写下错误的答案。
