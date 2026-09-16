# Pulsar Admin API Allowlist（源码真实调用清单）

## 这份文档是什么

这不是把产品规格 §12.2 的表格抄一遍。规格里的表格是**意图**——预先设计的允许清单；本文档记录的是**代码实际发出的每一个 HTTP 请求**，逐条对照规格，写明两者一致或分歧的地方。分歧不是缺陷报告，只要是有意为之并留了理由，就照实记下来，让 reviewer 和授权凭据的 SRE 都能核对。

来源（只读，未执行任何写操作）：

- `src-tauri/src/broker/ports.rs` —— `BrokerAdmin` trait，一个方法对应一个端点
- `src-tauri/src/broker/adapters/pulsar/admin_rest.rs` —— 实际拼接的路径与 Query 参数
- `src-tauri/src/broker/capability.rs` —— `discover()` 在建立连接时额外发出的探测调用
- `src-tauri/src/broker/stats.rs`（`TOPIC_STATS_REQUEST_SCOPE`）—— `/stats` 五个 Query 参数的取值来源
- `docs/superpowers/specs/2026-09-16-penguin-pulsar-panel-product-spec.md` §1.3 (B-01~B-10)、§1.4、§2.5、§7、§12.2、§12.3、§12.4 —— 对照的规格条款

方法论：先列 trait 的每一个方法，再看 adapter 里它实际发出什么请求，再回头核对规格表格里有没有对应行。规格表格里有但代码没实现的，标注"未实现"；代码调用了但规格表格没列的，单独一节说明理由。

## 1. 实际调用的端点（`BrokerAdmin` trait，`PulsarAdminRest` 实现）

| Trait 方法 | HTTP | 路径模板 | Query 参数 | 产品用途 | 规格 §12.2 是否列出 |
|---|---|---|---|---|---|
| `broker_version` | GET | `/admin/v2/brokers/version` | 无 | 版本识别；`capability::discover` 的第一步，失败即终止发现流程 | 未列出（§12.2 表格没有这一行，但属于同一批只读拓扑调用） |
| `list_clusters` | GET | `/admin/v2/clusters` | 无 | 见下方「2. `list_clusters` 的双重用途」 | **未列出**（§12.2 表格全文搜索不到 `clusters`） |
| `list_tenants` | GET | `/admin/v2/tenants` | 无 | Tenant 列表 | 是（"Tenants 列表"一行，路径与用途逐字匹配） |
| `list_namespaces` | GET | `/admin/v2/namespaces/{tenant}` | 无 | 指定 Tenant 下的 Namespace 列表 | 是（"Tenant 下 Namespaces"一行，逐字匹配） |
| `list_topics` | GET | `/admin/v2/persistent/{tenant}/{namespace}` | 无 | 展开列出该 Namespace 下的 Persistent Topic（含分区展开，折叠为逻辑 Topic 是调用方的工作） | 是（"Persistent Topics"一行，逐字匹配）—— **但路径硬编码 `persistent`，trait 签名本身不接受 domain 参数，无法请求 `non-persistent` 列表**，见本节下方说明 |
| `list_partitioned_topics` | GET | `/admin/v2/persistent/{tenant}/{namespace}/partitioned` | 无 | 该 Namespace 下已分区 Topic 的名称列表，供列表页做"逻辑 Topic 归一化" | 是（"Partitioned Topics"一行，路径与用途逐字匹配） |
| `get_topic_stats` | GET | `/admin/v2/persistent/{tenant}/{namespace}/{topic}/stats` | `getPreciseBacklog`、`subscriptionBacklogSize`、`getEarliestTimeInBacklog`、`excludePublishers`、`excludeConsumers`（全部显式 `false`，见第 3 节） | Topic/Subscription/Consumer/Producer 页面的主要数据来源 | 是（"普通 Topic Stats"一行） |
| `get_topic_internal_stats` | GET | `/admin/v2/persistent/{tenant}/{namespace}/{topic}/internalStats` | 无 | 见下方「2. `internalStats`：调用了但 §12.2 没列」 | **未列出**（有意为之，理由见下节） |
| `list_subscriptions` | GET | `/admin/v2/persistent/{tenant}/{namespace}/{topic}/subscriptions` | 无 | trait 方法存在、`PulsarAdminRest` 也实现了它，但**生产命令代码中从未调用**，见下方「5.1」 | 是（"已有订阅名称"一行），代码比规格的"使用规则"更保守——见「5.1」 |

`TopicRef::rest_path()`（`ports.rs`）根据 `persistent: bool` 决定 domain 前缀（`persistent` 或 `non-persistent`），所以 `get_topic_stats`/`get_topic_internal_stats`/`list_subscriptions` 这三个按 Topic 寻址的调用理论上对 non-persistent Topic 同样可用；但由于 `list_topics`/`list_partitioned_topics` 只硬编码 `persistent`，实际上目前没有任何路径能发现一个 non-persistent Topic 并拿到它的 `TopicRef`——除非调用方已经从别处知道了它的坐标。这正是规格 §12.2 结尾那句"不能机械假设所有 Persistent 订阅/存储接口都适用"想要提醒的情形，只是方向反过来了：这里不是接口不适用，而是发现路径本身缺失。

## 2. 两个"调用了但 §12.2 没列"的端点

### 2.1 `internalStats`（任务本身要记录的重点）

`GET /admin/v2/{domain}/{tenant}/{namespace}/{topic}/internalStats`，被 `src-tauri/src/broker/commands/topic_detail.rs:160` 在 `broker_get_topic_detail` 命令里按需调用（每次打开一个 Topic 的详情面板才发一次，参见 `src/hooks/useTopicDetail.ts` —— 没有轮询、没有自动刷新，只在选中 Topic 或用户点击 Refresh 时调用）。

**为什么这不算违规、也不是遗漏：**

- 这是一个合法的只读 GET，不创建、不修改任何资源。
- `stats` 只能回答"这个订阅报告了多少积压、多少速率"；`internalStats` 才能回答"这个订阅的 Cursor 在 Ledger 里到底停在哪"。`src-tauri/src/broker/internal_stats.rs` 模块文档原话："This is what separates 'consuming slowly' from 'not consuming at all': a subscription can report a reasonable backlog in `stats` while its cursor in `internalStats` has not moved in days." 这正是规格 §7.4 诊断表格里"Backlog > 0，在线 Consumer = 0"和"连续多个采样积压增长"两行想要区分、但仅凭 `stats` 区分不了的信息。
- 规格 §12.4（"明确不允许的操作"）把"未审核的 Internal Stats/配置转储"划在默认 Observe 之外，但同一条也留了口子："需要高级 Internal Stats 时，另建明确的只读操作、按需调用、独立负载预算与权限审核；不默认加入首页刷新。"代码符合这个口子的全部三个条件：它是独立的一次按需调用（不在首页/列表的默认刷新里）、只读、且没有被塞进任何轮询循环。
- 结论：不在 §12.2 表格里是因为规格写表格时把它当作"高级操作"单列在 §12.4，而不是因为它是一次未经审视的试探。本文档把它正式补进白名单，是任务本身要求做的事。

### 2.2 `/admin/v2/clusters`（`list_clusters`）——本次核对中发现的第二个分歧

`§12.2` 表格全文搜索不到 `clusters` 这个词；但 `list_clusters` 在 trait 里是独立方法，`capability.rs::discover` 在每次建立连接时都会调用它，且承担两个职责：

1. **信息性**：把返回的 cluster 名称列表塞进 `CapabilitySnapshot.clusters`，用于连接详情抽屉展示。
2. **推断 `can_write`**（`capability.rs:107-130`，`infer_write_capability`）：这是 Stage 0 任务 2 的产物——早期版本靠创建/删除一个 `broker-probe-write-*` Topic 来测试写权限，任务 2 把这个真实写操作移除了（详见 `capability.rs` 模块文档"Write capability: inferred, never probed"一节）。移除后代码需要一个廉价、无副作用的只读调用来推断写能力：`list_clusters` 返回 `401`/`403` 时，可以确定性地得出"连不上读、必然也写不了"（`can_write: false, can_write_probed: true`）；除此之外任何结果都不能证明能写，标记为"未测量"而非"测量为不能写"（单测 `a_401_on_the_read_probe_is_a_conclusive_negative_write_measurement` 等已覆盖这四种分支）。

这是同一类"合法只读、有明确理由、只是规格表格没单列"的调用，记在这里以保持完整性。

### 2.3 `/metrics/`（Prometheus 抓取路径，不是 Admin REST）

`capability.rs:211-220` 在 `discover()` 里额外探测 `{admin_url}/metrics/`，用途仅仅是把 `has_metrics: bool` 填进 `CapabilitySnapshot`（是否暴露了 Prometheus 指标，纯信息性，界面上目前没有任何功能读它）。这不是 `/admin/v2/*` 路径，严格说不算"Admin API"，但既然是 discovery 阶段真实发出的 HTTP GET，为完整性一并记录。同样走 `EndpointGuard` 校验，同样不写任何东西，请求失败就静默记为 `false`。

## 3. `/stats` 的五个 Query 参数

`src-tauri/src/broker/adapters/pulsar/admin_rest.rs` 的 `stats_request_path()` 固定拼出：

```
GET /admin/v2/{domain}/{tenant}/{namespace}/{topic}/stats
    ?getPreciseBacklog=false
    &subscriptionBacklogSize=false
    &getEarliestTimeInBacklog=false
    &excludePublishers=false
    &excludeConsumers=false
```

取值全部来自 `src-tauri/src/broker/stats.rs` 里的常量 `TOPIC_STATS_REQUEST_SCOPE`（Stage 0 任务 1 的产物），与规格 §12.3 的参考请求逐字段一致。五个参数为什么都显式写 `false`，而不是干脆不传、让 broker 走它自己的默认值：

| 参数 | 取值 | 理由 |
|---|---|---|
| `getPreciseBacklog` | `false` | 精确计算走 Ledger 遍历，代价高；规格 §12.3 把它定为"仅手动、低频"，默认轮询不用。 |
| `subscriptionBacklogSize` | `false` | **规格 §12.3 明确警告**：v4.0.0 的 REST 实现里，这个参数可能对繁忙 Topic 取 Ledger 锁（源码注释本身提醒高流量时要谨慎）。这是它被设为 `false` 的直接原因，而不是随手挑的默认值。 |
| `getEarliestTimeInBacklog` | `false` | 按需读取，不进入默认统计。 |
| `excludePublishers` | `false` | 规格默认策略是"精简视图可 true，需要实例详情时 false"——本产品的 Topic 详情页需要完整的 Publisher 实例信息，所以显式要求 `false`。 |
| `excludeConsumers` | `false` | 同上是"需要实例详情"的选择，但这里还有一层更关键的理由：**`excludeConsumers=true` 时 Pulsar 返回 `consumers: []`，这与"这个订阅真的一个 Consumer 都没有"在响应形状上完全无法区分**（`stats.rs` 模块文档 fix round 2 的记录）。`broker::anomaly` 的异常引擎正是从"空数组"这一事实推导出 `BacklogWithNoConsumer`（积压且无 Consumer）这条告警的。如果为了减小响应体而把这个参数设成 `true`，就会把"我们没请求这份数据"伪造成"broker confirmed 没有 Consumer"，凭空制造一次不存在的故障。这正是它被显式钉在 `false` 的理由，也是为什么 `StatsRequestScope`（下方）要把这个标志一路带进异常判断逻辑，而不是让 `anomaly.rs` 自己再猜一次。 |

之所以把这五个值做成一个类型（`stats.rs` 的 `StatsRequestScope`），而不是散落在各处的字面量或注释，是为了让"这次请求实际问了 broker 什么"和"UI/异常引擎被告知可以信任什么"永远不会走散——同一个 `TOPIC_STATS_REQUEST_SCOPE` 常量既拼进 URL，也原样序列化进 `TopicStats.stats_request_scope` 字段（`rename_all = "camelCase"`，与 `packages/broker-contracts/src/topic-detail.ts` 的 `StatsRequestScope` 逐字段镜像）。

## 4. 这份清单记录的是"我们问了什么"，不是"broker 做了什么"

规格 §12.3 原话："未知版本可能忽略不认识的 Query 参数；不能仅凭返回 200 就认定危险选项已被关闭。无法证明安全行为时，降为手动低频读取或停用该操作，并请求版本契约。"

本文档同样只能证明代码在 URL 里写了 `subscriptionBacklogSize=false`，**不能**证明连接的目标 broker（版本未知、可能不是本项目验证过的 4.2.4/v4.0.0）真的按这个参数关闭了 Ledger 锁行为——一个不认识这个参数的旧版本或魔改版本完全可能直接忽略它，behave as if it were `true` or its own default。把这份清单当成"代码请求了什么"的记录是准确的；把它读成"broker 一定照做了"的保证，就是过度承诺，是这份文档明确要避免的读法。

## 5. 有意不调用的端点/操作

| 操作 | 状态 | 理由 |
|---|---|---|
| `POST /admin/v2/brokers/health`（主动健康检查） | **不调用** | 规格 §2.5：Pulsar v4.0.0 的实现会创建 Producer 和 Reader、发送并读取探测消息，"不适合本产品的被动连接检查"。约束 B-06："连接成功检查不得通过发送再接收消息完成"。代码改用两种被动方式代替：`capability.rs` 用一次裸的 `pulsar::Pulsar::builder(broker_url, ..).build()` 握手测二进制协议可达性（不碰任何 Topic），以及用 `list_clusters` 这个已有的只读 Admin 调用侧面证明"Admin API 可访问"。两者都不创建 Producer/Reader，也不发送任何探测消息。 |
| 任何写动词（`PUT`/`POST`/`DELETE` 创建或删除 Topic） | **已移除，不残留** | `capability.rs` 模块文档记录：早期版本（任务 14 的 `probe_write`）会 PUT 一个 `broker-probe-write-<pid>-<ts>` Topic 再 DELETE 掉，用来测写权限；Stage 0 任务 2 把这段逻辑整段删除，改为从既有只读调用（`list_clusters` 的 401/403）推断写能力，永远不再尝试真实写入，符合 B-07（不提供 Topic 创建/删除）、§11.9（禁止自动创建）、§14.3。文件内不再有任何 `reqwest`-风格的 PUT/DELETE 调用（未在本文档内嵌一个会自我匹配的 grep 断言，验证命令与结果留在 `capability.rs` 测试模块末尾的注释里）。 |
| Peek / 按 Message ID 读正文 | **未实现，非本阶段范围** | 规格 §1.4："Admin API 本身存在 Peek、按 Message ID 读取正文等接口……但它们属于另一类数据访问能力，当前产品不调用这些接口，也不把它们混进普通状态查询。"代码里唯一涉及 peek 语义的地方是 `docs/broker/retry-dlq-contract.md` 记录的一次性诊断脚本（`broker_sim` 调试用二进制，不是产品运行时代码路径），生产 `BrokerAdmin` trait 没有任何 peek 方法。 |
| Schema 相关端点（`/schemas/{tenant}/{namespace}/{topic}/schema`、`/schema/{version}`） | **未实现** | 规格 §12.2 列了这两行；`BrokerAdmin` trait 里没有对应方法。有一处相关但不是调用：`envelope.rs` 里已经写好了识别"Schema 兼容性检查失败"错误体的逻辑（`is_schema_incompatibility`），这是为将来接这个端点预先做的错误分类基础设施，**不代表现在有代码在调用 Schema 端点**。 |
| Namespace Retention / TTL / Backlog Quota（`/retention`、`/messageTTL`、`/backlogQuotaMap`） | **未实现** | 规格 §12.2 列了这三行；trait 里没有对应方法，adapter 里也没有拼过这三个路径。 |
| 分区元数据（`/admin/v2/persistent/{tenant}/{namespace}/{topic}/partitions`） | **未实现** | 规格 §12.2 单独列了这一行（"已验证版本中显式禁用自动创建检查路径"）。注意这与 `list_partitioned_topics` 调用的 `/admin/v2/persistent/{tenant}/{namespace}/partitioned`（namespace 级、返回分区 Topic 名称列表）是两个不同的端点——后者已实现，前者（单个 Topic 的分区元数据）没有。 |
| 分区 Topic Stats（`/admin/v2/persistent/{tenant}/{namespace}/{topic}/partitioned-stats`） | **未实现** | 规格 §12.2 列了这一行（"总览/分区视图按需调用"）；当前只有非分区的 `/stats` 被调用。 |

### 5.1 `/subscriptions`：trait 里有、adapter 里有，生产代码从不调用它

规格 §12.2 对"已有订阅名称"一行的使用规则写的是"已有 Stats 包含时不重复请求"——也就是允许调用，但要避免和 `stats` 重复。核对 `src-tauri/src/broker/commands/topic_detail.rs` 的模块文档后发现代码走得比这更彻底：文件开头第 6-14 行有一段专门的说明——设计文档原本为这个任务规划了第五个命令 `broker_list_subscriptions`，**没有被构建**，理由是 Pulsar 的 `stats` 响应本身已经带着完整的订阅列表和每个订阅的 Consumer，单独一个命令只会多发一次一模一样的 HTTP 请求，返回调用方已经从 `TopicDetailDto.stats.subscriptions` 里拿到的子集。

结果是：`BrokerAdmin::list_subscriptions`、`PulsarAdminRest` 对它的实现、`/admin/v2/.../subscriptions` 这个端点，三者都存在于代码里（并且被测试替身实现和练到），但从生产命令到这个方法之间**没有任何调用点**（`grep -rn "\.list_subscriptions(" src-tauri/src/broker --include="*.rs"` 排除测试文件后零匹配）。这不是遗漏，是比规格要求更保守的选择：规格允许"有 stats 就不重复调用"，代码干脆把这条路径完全没有接上任何命令。记在这里是因为它是一个真实存在、编译进二进制、却在运行时路径上永远不会被触达的端点——对审阅代码或审核权限的人来说，"这个方法存在"和"这个方法会被执行"是两件需要分开确认的事。

## 附：五个「不做」的硬性约束覆盖情况（规格 §1.3）

本文档聚焦 Admin REST 的 GET 调用清单，不重复整张 B-01~B-10 表格；仅指出与本清单直接相关的三条已在上文验证：B-06（不用发消息再收消息做连接检查——见第 5 节）、B-07（不提供创建/删除等写操作——见第 5 节）、B-08（"不把读取成功包装成整个集群健康"——`capability.rs` 的 `CapabilitySnapshot` 字段与警告文案均以"未测量"而非"健康"措辞，例如 `can_write_probed` 的三态设计）。其余约束（B-01~B-05、B-09、B-10）涉及 Producer/Consumer 二进制协议与部署环境，不在 Admin REST 端点清单的范围内。
