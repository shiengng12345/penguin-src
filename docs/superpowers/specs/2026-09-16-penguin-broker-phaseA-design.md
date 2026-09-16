# Penguin Broker — Phase A：Console 控制塔

> Status: Draft for review · Date: 2026-09-16 · Module: `broker`
> 前置：Phase 0 完成（分支 `feat/broker-module`，41 commits，273 测试，gate 通过）

> ## ⚠️ 状态更新（2026-09-16，Phase A 完成后）
>
> **本文档已被取代，保留为历史记录。**
>
> 用户在 Phase A 十四个任务完成后提供了一份完整产品规格
> （`2026-09-16-penguin-pulsar-panel-product-spec.md`，1861 行）。
> 本文档**不是**照那份规格写的 —— 它写在前面，由 brainstorm 会话产出。
>
> 后续工作依据 **`2026-09-16-penguin-pulsar-panel-conformance.md`**，
> 那份文档逐条核对了上游规格与本仓库现状，并列出 5 处违反项与完整差距清单。
>
> **本文档仍然有效的部分**：第 7 节的三条裁决 D-A1 / D-A2 / D-A3。
> 其中 D-A2（stats / subscription / consumer 一律不缓存）与上游 §2.2 的影响矩阵一致，
> D-A3（Overview 是异常面板而非仪表盘）与上游 §3 的导航结构一致。
>
> **本文档已知与上游规格冲突之处**，详见 conformance 文档 §3：
> - `broker_test_connection` 的写探测会建删 topic —— 违反上游 B-07 / §11.9
> - `/stats` 未带安全参数 —— 违反上游 §12.3
> - 64-bit 计数器以 JS Number 传输 —— 违反上游 §14.1 / §23
> - `subType` 仍塌成 `Option<String>` —— 与本仓库自己的裁决 R22 / R29 矛盾


## Goal

把"发现积压 → 定位到 topic/subscription → 看清 consumer 状态"这条排查路径，从手敲 curl 变成点击。

具体到本机环境：`fpms_topup` 上挂着 `rg_deposit_accumulate_LOCAL` 和
`anti_addiction_deposit_limit_fpmsnt` 两个订阅。Phase A 要能一眼看出**哪个在积压、
有没有活着的 consumer、是不是被未确认消息掐住了**。

## Non-Goals

- 消息内容读取 / Message Inspector（Phase B）
- 业务生命周期时间线（Phase C）
- Schema 版本与 diff（Phase D）
- 任何对 Pulsar 的写操作（Phase E）—— 本阶段**全部只读**
- SRE 非生产接入（Phase F）
- Kafka / RabbitMQ / RocketMQ adapter

---

## 1. Phase 0 交付给本阶段的地基

不需要重建，直接用：

| 已就绪 | 位置 |
|---|---|
| `BrokerAdmin` 8 个方法 | `ports.rs` — `broker_version`、`list_clusters`、`list_tenants`、`list_namespaces`、`list_topics`、`list_partitioned_topics`、`get_topic_stats`、`list_subscriptions` |
| Admin REST adapter | `adapters/pulsar/admin_rest.rs` — guard 前置、禁重定向、16 MiB 上限、UTF-8 校验、token 不入 Debug |
| 错误映射（两层一致） | `envelope.rs` / `packages/broker-core/src/error-map.ts` |
| 安全闸门 | `security.rs` — `WritePermit` 不可伪造、endpoint allowlist、`redact` |
| Rust 侧分页 + 分区折叠 | `topic_folding.rs` |
| 连接管理 + capability discovery | `commands.rs` 5 个 command |
| `DataTable` | 五态、可展开行、虚拟化、`rowProps`、`expandLabel`、`grow` |

**Phase A 基本不碰传输层和错误处理**，只加查询与界面。

---

## 2. Phase 0 留下的三笔债，本阶段必须处理

### 2.1 快照缓存是死的（必须接上）

`broker_topology_snapshots` 表、`store::put_snapshot`、`store::get_snapshot`
全部写好并测过，**但没有任何生产调用方**。`broker_list_topics` 每次翻页都重新
拉取完整的两份列表。

后果：
- `ResultEnvelope.source` 永远不会是 `"cache"`
- UI 的 `"stale"` 状态**不可达** —— 那是 `DataTable` 五态里唯一没被真实触发过的
- `store.rs` 和 `db.rs` 的注释声称"本模块基于缓存分页"，与实际不符

**本阶段必须接上，并定义新鲜度策略**（见 §4.1）。

### 2.2 `packages/broker-core` 没有生产消费者

那套 TypeScript 的 `error-map` / `pagination` / `topic-folding` 只被四个测试文件
import，真正运行的是 Rust 版本。

当前价值是**交叉验证参照**（Phase 0 的 review 逐条比对过两边行为），
成本是双份维护。

**决策点，见 §7 开放问题。**

### 2.3 `CapabilitySnapshot` 五个字段是硬编码常量

`can_peek`、`peek_requires_subscription`、`peek_on_partitioned_allowed`、
`web_socket_enabled`、`batch_frame_seen` —— 对着本地 4.2.4 测了一次就写死。
注释已改诚实（标明哪些探测、哪些是常量），但本阶段若要展示能力矩阵，
**必须明确标为"未针对此连接测量"**，不得渲染成实测结论。

---

## 3. 要建什么

### 3.1 导航：Tenant → Namespace

现状是写死 `public/default` 的平铺列表。`list_tenants` 和 `list_namespaces`
已经实现，只是没有界面。

接 SRE 环境时这是必须的 —— 那里不会只有一个 namespace。

### 3.2 Topic 详情

数据源已确认可用（Phase 0 V-A1/V-A2/V-A3）：

- `stats` — `msgRateIn/Out`、`msgThroughputIn/Out`、`backlogSize`、`storageSize`、`msgInCounter`、`backlogQuotaLimitSize`、`oldestBacklogMessageAgeSeconds`
- `internalStats` — `cursors.{sub}.markDeletePosition/readPosition`、`ledgers[]`、`lastConfirmedEntry`、`entriesAddedCounter`
- `partitioned-stats` — 分区 topic 的聚合

### 3.3 Subscription lag

每个订阅的 `msgBacklog`、`unackedMessages`、`msgRateOut`、类型（Shared/Exclusive/Failover/Key_Shared）、游标位置。

### 3.4 Consumer 详情

Phase 0 实测确认这些字段都有：

```
consumerName · address · clientVersion · availablePermits
unackedMessages · lastAckedTimestamp · lastConsumedTimestamp
msgRateOut · blockedConsumerOnUnackedMsgs
```

`blockedConsumerOnUnackedMsgs` 尤其有价值 —— 它直接说明"这个 consumer 被
broker 因未确认消息过多而掐住了"，不用靠猜。

### 3.5 Overview —— 异常面板（见 D-A3）

不做仪表盘。直接回答排查时的第一个问题：**哪里不对**。

- 有 backlog 但没有活跃 consumer 的订阅
- `blockedConsumerOnUnackedMsgs` 为真的 consumer
- backlog 最老消息年龄超阈值的 topic
- capability 探测失败的项

没有异常时显示明确的「未发现异常」，不留空白 —— 空白无法区分
「一切正常」和「查询失败」。

---

## 4. 关键设计决策

### 4.1 缓存新鲜度策略

这是本阶段最需要想清楚的一条，因为它决定 `stale` 状态何时出现。

**提议**：

| 数据 | TTL | 理由 |
|---|---|---|
| tenants / namespaces | 5 分钟 | 极少变动 |
| topic 列表 | 60 秒 | 中等变动 |
| topic stats / subscription / consumer | **不缓存** | 这些是排查时要看的实时数字，缓存会误导 |

- 超过 TTL 时：**仍然渲染缓存数据**，同时标 `stale` 并在后台刷新 —— 这是
  `DataTable` 五态设计的原意（陈旧数据仍是数据，藏起来更糟）
- 提供显式刷新按钮，绕过 TTL
- `ResultEnvelope.freshnessMs` 填真实值（Phase 0 目前恒为 0）
- **`source` 应从 `String` 改为枚举**（Phase 0 的 deferred minor）—— 那样
  `"cache"` 分支不可达就会变成编译期可见，而不是靠 review 发现

### 4.2 一条必须守住的产品规则

spec 原文：

> **`msgRateOut` 只说明消息交付给了 consumer，不能证明业务完成。**

Phase A 是第一个展示吞吐数字的阶段。一个写着"出站速率 500/s"的面板，
极易被读成"业务在正常处理" —— 而真相可能是 consumer 收到就抛异常。

**UI 必须让这个区别可见**：Pulsar 层的**交付**与业务层的**完成**是两件事，
后者要等 Phase C 才有依据。在此之前，任何界面不得暗示业务成功。

### 4.3 只读

本阶段**不产生任何写操作**。所有 command 走 `BrokerAdmin` 的只读方法，
不需要 `WritePermit`。如果实现中发现需要 permit，那是信号：做了不该做的事。

---

## 5. 新增的 Tauri commands

沿用 Phase 0 的约定：每个都显式接收 `connectionId`，不隐式读 active。

```
broker_list_tenants(connectionId) -> ResultEnvelope<Vec<String>>
broker_list_namespaces(connectionId, tenant) -> ResultEnvelope<Vec<String>>
broker_get_topic_detail(connectionId, topicRef) -> ResultEnvelope<TopicDetail>
broker_list_subscriptions(connectionId, topicRef) -> ResultEnvelope<Vec<SubscriptionSummary>>
broker_get_overview(connectionId) -> ResultEnvelope<Overview>
```

`TopicDetail` 和 `SubscriptionSummary` 需要新增到 `broker-contracts`，
并在 Rust 侧镜像 —— 注意 Phase 0 的教训：**两层必须逐字段一致**，
`observed_at` 那次 ISO-8601/Unix 秒的分歧就是这么来的。

`get_topic_stats` 现在返回 `serde_json::Value`。Phase A 应定义具体结构体，
但**只映射实际用到的字段**，未知字段保留原样 —— 不同 Pulsar 版本字段会变，
硬映射全部字段会在接 SRE 时炸。

---

## 6. 测试矩阵

| 层 | 必须测试 | 证据 |
|---|---|---|
| `broker-core` / Rust 纯逻辑 | stats 解析、lag 计算、异常订阅识别、缓存新鲜度判定 | `node --test` + `cargo test` |
| Rust adapter | 新增查询的错误映射、未知字段容忍、部分数据 | HTTP contract fixtures |
| 缓存层 | TTL 过期、stale 渲染、显式刷新绕过、并发刷新去重 | SQLite 集成测试 |
| 实活集成 | 对本机 Pulsar 查 `fpms_topup` 的两个真实订阅 | Docker 集成报告 |
| React | 树导航、详情页五态、lag 展示、**"交付≠完成"的表述** | Vitest + Testing Library |
| 可访问性 | 树的键盘导航、焦点、状态不依赖颜色 | Vitest |
| 故障注入 | 部分 source 失败、超时、连接中途断开 | fault-injection 报告 |

沿用 Phase 0 的规矩：`Implemented` / `Verified` / `Not run` / `Blocked` 四态记录，
**有 `Not run` 或 `Blocked` 就不放行**。

---

## 7. 已裁决的问题

三个问题在执行前由 controller 裁决并记录，理由与"判错的代价"一并写下。

### D-A1 — `packages/broker-core` 保留为交叉验证参照

Phase 0 的 review 靠逐条比对 TS 与 Rust 两侧行为，抓出过两处真实分歧
（schema 类名匹配的大小写敏感性、message 的 trim 差异）——
两者都会让 UI 和后端对同一个响应给出不同结论。

Phase C 的关联引擎（去重、乱序、时钟漂移）逻辑比这复杂得多，
那时有一份可对照的参照实现价值更大。

**代价（若判错）**：双份维护。缓解方式是 Phase A 不给 broker-core 加新职责 ——
它只维持现有的 `error-map` / `pagination` / `topic-folding` 三块，
新逻辑一律只写 Rust。若到 Phase C 前它仍无生产消费者且未再抓到分歧，届时删除。

### D-A2 — stats / subscription / consumer 一律不缓存

排查时看的就是实时数字。一个缓存过的 backlog 数值不是"稍旧的信息"，
而是**主动误导** —— 运维人员据此判断"积压在下降"，而实际可能仍在上升。

SRE 环境可能对 Admin REST 限流，但那是**没有证据的猜测**。真有限流会表现为
429，而错误映射已经把它归为可重试并有测试覆盖。到 Phase F 拿到真实环境时，
限流是可测量的事实，届时再加 TTL 是有依据的决定。

**代价（若判错）**：对限流的 broker 发出多余请求，表现为 429。
这是可见的失败，不是静默的错误答案。

### D-A3 — Overview 保留，但改成「异常面板」而非仪表盘

一个显示"12 个 topic、总 backlog 3400"的面板是好看多于有用的。
改成直接回答排查时的第一个问题：**哪里不对**。

内容限定为：
- 有 backlog 但**没有活跃 consumer** 的订阅
- `blockedConsumerOnUnackedMsgs` 为真的 consumer
- backlog 最老消息年龄超过阈值的 topic
- 连接层面的问题（capability 探测失败项）

没有异常时显示明确的"未发现异常"，而不是一片空白 —— 空白无法区分
"一切正常"和"查询失败"。

**代价（若判错）**：一个用得少的页面。但它复用的是 topic/subscription
查询，没有独立的数据路径需要维护。

---

## 8. Phase A Gate

- [ ] 快照缓存接上，`stale` 状态在真实场景下可达并验证
- [ ] `ResultEnvelope.freshnessMs` 填真实值
- [ ] 能在本机 broker 上导航 tenant/namespace，看到 `fpms_topup` 的两个真实订阅及其 lag
- [ ] Consumer 详情显示 `blockedConsumerOnUnackedMsgs`
- [ ] 任何界面都没有暗示"业务完成"的表述
- [ ] 硬编码的 capability 字段明确标为"未针对此连接测量"
- [ ] 新增 contracts 两层逐字段一致（有测试守住）
- [ ] 未知 stats 字段不导致解析失败
- [ ] 测试矩阵每行有结果，无 `Not run` / `Blocked`
- [ ] `cargo test`、`pnpm test:ui`、`pnpm typecheck` 全绿；`pnpm test` 失败集合仍为已知 6 个
- [ ] `pnpm broker:gate` 通过，broker 零残留
- [ ] **GUI 走查实际执行**（Phase 0 的教训：`cargo run` 起不来时 273 个测试全绿）
