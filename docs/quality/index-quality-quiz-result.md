# Penguin Index Quality Quiz 结果报告

## 结论摘要

本次测试表明，Penguin 对部分已解析的 symbol 和 endpoint 能提供较好的调用关系、文件路径及行号证据，但整体覆盖和定位能力不稳定：12 道题中，Q1、Q3、Q6、Q7 能返回部分或大部分关系，Q9、Q10 能较完整地追踪 endpoint；Q2、Q4、Q5、Q8、Q11、Q12 无法完整回答。

因此，本次索引质量结论是：

> 基础索引和部分调用图可用，但还不足以支持完整的代码导航、文件级 symbol 清单和无歧义的跨模块查询。

## 测试约束

- 只使用 Penguin 的 `knowledge_explore`。
- 没有使用 grep、源文件读取或其他代码搜索工具。
- 每道题独立查询，没有用源代码或常识补全缺失结果。
- 对无法确认的内容明确标记为“无法从索引确认”。
- 成功解析的查询显示 FPMS-NT `brazil-v2` 索引为 fresh。
- indexed commit：`3f0f1984b9e4337668529a13bad5264501729908`。

## 各题结果

### Q1 — `CMSGenBaseResponse` callers

索引确认了 8 个 caller：

- `success`
- `forbidden`
- `internalError`
- `notFound`
- `unauthorized`
- `statusUnspecified`
- `illegalArgs`
- `alreadyExists`

其中前 3 个返回了明确行号：26、34、42；其余 caller 被列出，但 source 结果被工具限制，未返回完整行号。

评价：关系数量完整，但证据展开不完整。

### Q2 — `addPlayerFreeSpin` callers

无法确认。精确文件路径查询没有找到 symbol；仅按名称查询得到 12 个歧义匹配。

评价：同名 symbol 过多，路径限定没有成功消除歧义，导致索引无法回答。

### Q3 — `addPlayerMudDisbursement` callers

索引确认了 8 个 caller：

- `dispatchMud`
- `addPlayerMud`
- `addPlayerMudToRewardRecordBatch`
- `dispatch`
- `grantMud`
- `dispatchReward`
- `claimTaskRewardByTaskId`
- `grantMud`

前 3 个返回了明确 source 定位；其余 caller 只有名称或部分路径信息。

评价：调用关系覆盖较好，但重复名称和结果截断影响了完整性。

### Q4 — `catchGrpcError` callers

无法确认。精确路径查询没有找到 symbol；仅按名称查询得到 20 个歧义匹配。

评价：同名函数数量较多，当前查询解析不足。

### Q5 — `accumulatePlayerDeposit` callees

无法确认。精确路径查询没有找到 symbol；仅按名称查询得到 20 个歧义匹配。

评价：这是一个明显的索引定位缺口，因为题目已提供了完整文件路径，理论上应当能直接解析。

### Q6 — `applyOpenPromoCode` callees

索引列出了 10 个 callee，包括：

- `findActiveOpenTemplate`
- `query`
- `findByProposalId`
- `getPlayerLevelWithPlayerLevelObjId`
- `DeductPlayerCredit`
- `emitEvent`
- `warn`
- `createProposal`
- `log`
- `addUsedEvent`

前 3 个返回了明确文件与行号。其余 callee 被工具限制，没有返回完整 source 定位。工具还报告了 1 条 inferred edge。

评价：关系发现能力较强，但不能把 inferred edge 与 parser 提取的事实等价看待。

### Q7 — `createLeaderBoardRewardProposal` callees

索引列出了 10 个 callee，包括：

- `incrementMessageDedup`
- `checkAndAddEventSession`
- `getPlatformByPlatformId`
- `getPlayerInfoInternal`
- `getPlayerLevelByPlayerLevelObjId`
- `getProposalTypeByName`
- `getStartAndEndDate`
- `getTotalRewardCountForDay`
- `createGrpcMetadataWithTrace`
- `warn`

前 3 个返回了明确文件与行号，其余 callee 未返回完整 source 定位。

评价：能识别较复杂方法的依赖，但结果展开受限，不能直接作为“完整文件级证据”。

### Q8 — `GET /healthcheck`

无法确认。该 endpoint 查询得到 9 个歧义匹配，未能解析具体 handler。

评价：endpoint 索引存在，但路由唯一性或查询解析能力不足。

### Q9 — `POST /internal/vip-cohort/retention-risk`

索引确认：

- handler：`triggerRetentionRisk`
- 文件：`apps/promotion-event-scheduler/src/vip-cohort/vip-cohort-trigger.controller.ts`
- handler 行号：45–60
- 下一步调用：`this.runner.run(...)`
- 目标方法：`run`
- 目标文件：`apps/promotion/src/modules/vip-cohort/services/vip-cohort-runner.service.ts`
- 目标方法行号：101–220

评价：endpoint → handler → service 的链路清晰，结果完整度较高。

### Q10 — `POST /promotion/GetPlayerFreeSpinInfo`

索引确认：

- handler：`getPlayerFreeSpinInfoRestful`
- 文件：`apps/promotion/src/free-spin/controllers/free-spin-http.controller.ts`
- handler 行号：20–29
- 下一步调用：`transformRestfulReqToNt`
- transformer 文件：`apps/promotion/src/free-spin/processors/get-player-free-spin-info.transformer.ts`
- transformer 行号：11–23
- processor 调用：`execute`
- processor 文件：`apps/promotion/src/free-spin/processors/get-player-free-spin-info.processor.ts`
- processor 行号：117–175

评价：endpoint 到 handler、transformer 和 processor 的链路都能被索引识别。

### Q11 — livechat bot 文件 symbol

索引只报告该文件定义了 12 个 symbol，没有返回具体名称或行号。

评价：文件级 defines 计数存在，但 file_symbols 查询无法展开 symbol 明细。

### Q12 — livechat conversation 文件 symbol

索引只报告该文件定义了 10 个 symbol，没有返回具体名称或行号。

评价：与 Q11 相同，文件被索引，但 symbol 明细没有暴露给查询结果。

## 我遇到的问题

### 1. 路径限定并不总能解析 symbol

Q2、Q4、Q5 的查询已经带上题目给出的文件路径，但 Penguin 仍返回“找不到 symbol”或退化为歧义匹配。这说明当前 identity key、路径匹配或分支绑定之间可能存在不一致。

### 2. 同名 symbol 歧义严重

`CMSGenBaseResponse`、`catchGrpcError`、`accumulatePlayerDeposit` 等名称在多个仓库、分支或文件中重复出现。名称搜索能发现候选项，但不能稳定地选择目标 symbol。

### 3. 结果有数量限制，无法保证完整证据

Q1、Q3、Q6、Q7 中，索引的关系数量比返回的 source 证据更多。工具通过 `sourcesOmitted` 明确提示了被省略的 caller/callee。

### 4. 文件节点没有展开 defines

Q11、Q12 的文件节点报告了 defines 数量，但 `sources` 为空，无法取得具体 symbol 名称和行号。

### 5. endpoint 解析能力不一致

Q9、Q10 可以准确追踪；Q8 却出现 9 个歧义匹配。这可能与多个服务都注册了相同健康检查路由，或者 endpoint 索引缺少服务/文件限定有关。

### 6. inferred edge 需要单独标注

Q6 报告了 1 条 inferred edge。它可以作为探索线索，但不应当与 parser 提取的调用关系混合成同等级事实。

## 优点

- `knowledge_explore` 一次查询可以同时返回 focus、callers、callees、routes、sources 和 freshness。
- 对已成功解析的 symbol，能够提供文件、行号和角色信息。
- endpoint 查询可以建立 handler 到下一层 service/processor 的调用链。
- 结果包含 provenance 和 confidence，能区分 parser 提取关系与 inferred edge。
- freshness、indexed commit、worktree 状态等信息有助于判断结果是否对应当前代码。
- 工具会显式报告 ambiguous、no symbol found、sourcesOmitted 等问题，便于识别索引缺口。

## 缺点

- 精确路径查询仍可能无法解析目标 symbol。
- 同名 symbol 的消歧能力不足，尤其是跨仓库和跨分支场景。
- `sourcesOmitted` 会导致“关系数量完整但文件/行号证据不完整”。
- 文件节点查询不能直接列出所有定义的 symbol。
- endpoint 可能因为重复注册或索引表示方式而产生大量歧义。
- 对 inferred edge 的细节不足，调用方不容易知道具体是哪一条关系属于推断。
- `confidence: high` 可能只代表已返回关系的解析置信度，不代表答案覆盖率完整；这需要在使用时特别注意。

## 建议

### 短期建议

1. 为 `knowledge_explore` 增加稳定的 revision、branch 或 node identity 参数，让调用者可以直接指定目标 symbol，而不依赖名称猜测。
2. 当查询包含完整文件路径时，优先使用“文件路径 + symbol 名称”做严格匹配，避免退化到全局名称搜索。
3. 提供 `expand_callers`、`expand_callees` 或分页 cursor，让调用者能取得所有关系的完整文件与行号。
4. 对 file 节点增加 `defined_symbols` 返回字段，至少包含 symbol 名称、kind、startLine 和 endLine。
5. endpoint 查询增加 controller/module/service 过滤条件，帮助处理同一路由在多个应用中的情况。

### 中期建议

1. 统一 node identity 格式，明确区分 repo、branch、commit、file path 和 symbol name。
2. 为“未找到 symbol”和“找到多个 symbol”返回结构化候选项，并让候选项可以直接作为下一次 `knowledge_explore` 的 target。
3. 将 coverage、sources 截断、unresolved references 和 inferred edges 分开计数，避免只看 `confidence` 就误判索引质量。
4. 增加针对路径解析、同名 symbol、endpoint 歧义和 file_symbols 展开的自动化回归测试。
5. 对返回结果提供“完整性状态”，例如 `complete`、`partial`、`ambiguous`、`not_indexed`。

### 测试流程建议

后续质量测验可以增加以下指标：

- symbol 定位成功率；
- caller/callee 数量召回率；
- 返回关系的文件/行号完整率；
- endpoint handler 解析成功率；
- file_symbols 展开成功率；
- stale 或 trust unavailable 的检测准确率；
- inferred edge 与 parser edge 的区分准确率。

## 最终判断

Penguin 当前最适合用于：

- 快速定位已知且唯一的 symbol；
- 探索常见调用关系；
- 追踪部分 HTTP endpoint 的 handler 链路；
- 判断索引 freshness 和基本 provenance。

当前不适合单独用于：

- 要求 100% 完整 caller/callee 文件行号的审计；
- 同名 symbol 很多时的自动化精确导航；
- 文件级完整 symbol 清单；
- 未经额外验证的架构或影响范围结论。

本次结果最重要的发现不是“哪些题答出来了”，而是：工具已经能够暴露自身的覆盖边界，但这些边界仍然影响完整代码理解任务的可靠性。
