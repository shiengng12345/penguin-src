# Penguin Pulsar Panel —— 产品规格符合性审计与实施计划

> Status: 现行权威计划 · Date: 2026-09-16 · Module: `broker`
>
> **上游规格**：[`2026-09-16-penguin-pulsar-panel-product-spec.md`](./2026-09-16-penguin-pulsar-panel-product-spec.md)（1861 行，用户提供）
>
> **本文档的作用**：上游规格定义产品「要什么」，本文档定义在**这个代码库里**它对应什么 —— 哪些已经存在（附文件行号）、哪些违反了、哪些还没有、按什么顺序补。
>
> **本文档取代** `2026-09-16-penguin-broker-phaseA-design.md` 作为后续工作的依据。该文档保留为 Phase A 的历史记录，其 D-A1/D-A2/D-A3 三条裁决仍然有效。

---

## 0. 来历，必须说清楚

Phase A 的 14 个任务**不是**照上游规格做的 —— 那份规格在 14 个任务全部完成后才出现。Phase A 依据的是 `2026-09-16-penguin-broker-phaseA-design.md`，由 brainstorm 会话产出。

两者方向高度一致（上游 §13.1 推荐的技术栈正好是本项目在用的 React + TS + Rust + Tauri 2），但**不是同一份文档，不能假装是**。本文档逐条核对后给出结论。

审计基线：分支 `feat/broker-module`，Phase A 十四任务完成，`cargo test` 302 / `pnpm test:ui` 142 / `pnpm typecheck` 0。

---

## 1. 产品边界（采纳上游 §1.3，逐条落到本仓库）

| 编号 | 约束 | 本仓库落实情况 |
|---|---|---|
| B-01 | 运行时不调用创建 Consumer / Reader / TableView | ✅ `binary::read_without_ack` 存在但**无任何 Tauri 命令可达**；唯一调用方是 `src-tauri/src/bin/broker_sim.rs`（开发用二进制）与 `tests/broker_binary.rs` |
| B-02 | 不创建/删除/修改 Subscription，不移动 Cursor | ✅ 无此路径 |
| B-03 | 不接收消息、不 ACK/NACK、不订阅 | ✅ |
| B-04 | Observe 不初始化 Producer | ✅ `capability.rs:189` 是裸连接握手（`Pulsar::builder().build()`），不碰 topic、不建 producer |
| B-05 | 只有明确发送操作可创建 Producer | ⏳ 尚无发送功能 |
| B-06 | 连接检查不得「发了再收」 | ✅ 同 B-04。**且未调用 `/admin/v2/brokers/health`** —— 上游 §2.5 警告 v4.0.0 该实现会创建 Producer 和 Reader |
| B-07 | 不提供 Topic 创建/删除等 | ❌ **违反，见 §3.1** |
| B-08 | 不把读取成功包装成集群健康 | ✅ `CapabilitySnapshot` 区分「已测量」与「未测量」，`can_write_probed` 即为此 |
| B-09 | 遵守公司权限与网络要求 | ⏳ SASE / 代理通路未验证 |
| B-10 | 安全限制落在可信执行层 | ✅ `security.rs` 的 `WritePermit` 不可伪造（私有字段，无 `Default`/`Clone`/`From`），闸门在 Rust 侧 |

**B-01 的补充说明**：上游 §1.3 特别指出 Pulsar 的 Reader 底层仍是 Consumer + 非持久订阅，TableView 底层是 Reader，因此不能用它们绕过承诺。本仓库的 `read_without_ack` 正是这类接口 —— 目前不可达，但**建议移出 lib**（见 §4.1），让这条保证从「没人调用」升级为「编译期不可能」。

---

## 2. 已符合的部分（Phase A 的工作有效）

| 上游要求 | 本仓库实现 | 位置 |
|---|---|---|
| 不重复统计父 Topic 与子 Partition（§23） | 分区折叠 | `broker/topic_folding.rs` |
| 区分 Broker 接收 ≠ 业务成功（§2.4、§11.5） | `DeliveryNotice` 单一文案来源 | `components/broker/DeliveryNotice.tsx` |
| 出站速率不得命名为「业务处理成功速度」（§4.3） | 全局约束，审核逐条读过每一句用户可见文案 | — |
| Loading/Empty/Forbidden/Stale/Partial/Unknown 分开（§4.5） | `DataTableState` 六态 | `components/ui/data-table-types.ts` |
| 缺失、未请求、无权限与真实 0 分开（§23） | 见下 | — |
| 大整数不因 JSON 往返丢精度（§14.1） | ❌ **违反，见 §3.3** | — |
| 只调用审核过的操作白名单（§2.4、§12） | `EndpointGuard` + `BrokerAdmin` 固定 9 方法 | `broker/security.rs`、`broker/ports.rs` |
| Secret 不入 URL / 前端存储 / 日志 / 导出（§16.3） | token 只以 handle 过 IPC；`redact()` 覆盖 Bearer/Basic/userinfo/7 个查询参数 | `broker/security.rs` |

### 2.1 「未知 ≠ 0」这条链，是 Phase A 最有价值的产出

上游 §23「数据正确性」整节要求缺失值与真实 0 分开。本仓库为此建立了三个三态类型，且**每一个都是在实测中发现 Pulsar 用 in-band 哨兵值编码「未知」之后补的**：

| 字段 | Pulsar 的哨兵 | 本仓库类型 | 位置 |
|---|---|---|---|
| `oldestBacklogMessageAgeSeconds` | `-1` = 从未有过 backlog | `BacklogAge { Seconds, NoBacklog, Unknown }` | `broker/stats.rs` |
| `lastAckedTimestamp` / `lastConsumedTimestamp` | `0` = 从未 ack | `ConsumerTimestamp { Millis, Never, Unknown }` | `broker/stats.rs` |
| `subscriptions[].type` | `"None"` = 未设置 | ❌ **仍塌成 `Option<String>`，见 §3.4** | `broker/stats.rs` |

前两个的线格式由测试钉死，TS 侧是判别联合，消费端是穷尽 `switch`（新增状态会编译失败而非静默落空）。**第三个是同一个缺陷的第三次出现，尚未修复。**

---

## 3. 违反项（现有代码，必须修）

### 3.1 【高】`broker_test_connection` 会在目标集群建 topic 再删

**位置**：`src-tauri/src/broker/capability.rs:301`（PUT 建 `broker-probe-write-<pid>-<ts>`）、`:319`（DELETE）

**违反**：B-07（不提供 topic 创建/删除）、§11.9（严格禁止自动创建）、§14.3（`connections.testObserve` 明写「不创建 Producer / Consumer」）

**为什么现在才严重**：本机 Pulsar 无认证，这个探测一直「能跑通」。用户的 QAT token 是 **super-admin scope**，所以在 QAT 上它**会真的执行** —— 在别人的集群上建一个 topic 再删掉。`read_only` 标记能挡，但不是默认值。

**修法**：写能力从 Admin API 的响应形状推断（401/403），或直接报告「未测量」。**绝不能靠实际写一次来证明。** `can_write_probed: false` 这个字段本来就是为「没测过」准备的。

### 3.2 【中】`/stats` 未带安全参数

**位置**：`src-tauri/src/broker/adapters/pulsar/admin_rest.rs:220`

**违反**：§12.3 —— v4.0.0 的 REST 实现中 `subscriptionBacklogSize` **可能涉及 Ledger 锁**，源码特别提醒高流量时谨慎，且 **REST 默认值与 CLI 默认值不同**。

**修法**：显式带 `?getPreciseBacklog=false&subscriptionBacklogSize=false&getEarliestTimeInBacklog=false`，需要精确值时再按需开启并在 UI 标明代价。

**为什么本机测不出来**：10 个空 topic 没有 Ledger 压力。QAT 有真实流量时才会显现。

### 3.3 【中】64-bit 计数器用 JS Number 传，静默丢精度

**违反**：§14.1（「64-bit Counter、Ledger ID、大尺寸字节量等通过十进制字符串或无损结构传给前端」）、§23（「大整数与 Message ID 保持精度和完整性」）

| Rust | TypeScript | 位置 |
|---|---|---|
| `msg_in_counter: Option<u64>` | `msgInCounter: number \| null` | `stats.rs:153` / `topic-detail.ts:127` |
| `storage_size: Option<u64>` | `storageSize: number \| null` | `stats.rs:151` / `topic-detail.ts:125` |
| `backlog_size: Option<u64>` | `backlogSize: number \| null` | `stats.rs:152` / `topic-detail.ts:126` |
| `entries_added_counter: Option<u64>` | `entriesAddedCounter: number \| null` | `internal_stats.rs:123` |
| `messages_consumed_counter: Option<u64>` | `messagesConsumedCounter: number \| null` | `internal_stats.rs:138` |

JS 安全整数上限 2⁵³−1 ≈ 9.007×10¹⁵；`u64` 上限 1.8×10¹⁹。长期运行的高流量 topic 的累计计数器会越过这条线，然后**数字静默变错，没有报错**。

这与本阶段一直在防的是同一类问题 ——「看起来像答案但不是」—— 只是换成了精度形式。

**修法**：serde 侧以十进制字符串序列化，TS 侧类型为 `string`，UI 格式化时用 `BigInt` 或字符串分组。

### 3.4 【高】`subType` 是第三个同形状哨兵，仍被压平

**位置**：`src-tauri/src/broker/stats.rs`，`normalize_sub_type`

```rust
fn normalize_sub_type(sub_type: Option<String>) -> Option<String> {
    sub_type.filter(|value| value != "None")
}
```

**实测确认**：用户真实的 `fpms_topup` 两个订阅当前均为 `type='None'`，界面 Type 列显示 **"Unknown"** —— 声称 broker 没回答，而 broker 答了。

**违反**：§23（缺失与真实值分开）；并与本仓库自己的裁决 **R22**、**R29** 矛盾 —— 那两条分别为 backlog 年龄和时间戳修过同一个缺陷。

**修法**：`SubscriptionType { Named { name }, Unset, Unknown }`，照 `BacklogAge` 的形状（内部标记、线格式钉测试、TS 判别联合、穷尽 switch）。**不要抽泛型 `Tri<T>`** —— 三者 payload 与领域含义不同，ledger 已就此裁决。

### 3.5 【低】`internalStats` 不在 §12.2 白名单内

**位置**：`admin_rest.rs:223`、`ports.rs`

不算违规 —— 它是合法只读接口，且是区分「消费慢」与「完全没消费」的**唯一**手段（上游 §7 本身也要这个能力）。但 §12.2 结尾要求「暂时未验证的能力显示 Unsupported，而不是调用任意路径试探」。

**修法**：补进白名单文档并写明理由与版本适用范围，或在能力矩阵里标注为待 SRE 确认。

---

## 4. 差距（上游要求，尚未建）

### 4.1 边界加固（建议）
将 `binary::read_without_ack` 移出 lib（仅测试可见），使 B-01/B-03 从「无人调用」变为「编译期不可能」。上游 §1.3 明确警告 Reader 底层即 Consumer。

### 4.2 Observe 补齐

| 能力 | 上游章节 | 备注 |
|---|---|---|
| Producers 视图（跨 Topic 索引） | §3、§8 | stats 已含 `publishers`，未取用 |
| Schema 查看 | §10、§12.2 | `/admin/v2/schemas/...` |
| 只读 Policies（retention / TTL / backlogQuota） | §10、§12.2 | 需标明配置层级 |
| 分区下钻 / `partitioned-stats` | §9、§12.2 | 现仅折叠，不可下钻 |
| non-persistent topic | §12.2 | 现仅 persistent |
| `observe.pause` | §14.3、§4.5 | 暂停刷新，UI 明示非实时 |
| `diagnostics.export`（脱敏） | §14.3、§16.6 | CSV 需处理公式注入 |

### 4.3 Send Message（§11 全文）

状态机八态：`Draft → Validated → AwaitingConfirmation → Sending → Accepted / Rejected / CancelledBeforeSend / UnknownOutcome`

关键约束，按难度排序：

1. **`UnknownOutcome` 不得自动重发**（§11.7）。超时不等于没发出去。重发必须用户明确点击，并提示可能重复。
2. **`confirmationToken` 由可信层生成**（§14.2），绑定内容指纹、权限、会话与有效期，一次性使用。不是前端写个 `confirmed: true`。
3. **仅 Shared Producer**（§11.8）。禁止 Exclusive / WaitForExclusive / ExclusiveWithFencing —— 不能驱逐现有 Producer。冲突只报告。
4. **发送前 Topic 必须已存在**（§11.9），且客户端预检不能单独保证不自动创建，需部署侧配置配合。
5. **最终字节在可信层冻结**（§14.2）。用户确认后不得再格式化或改序列化 —— 金额、大整数、签名字段尤其。
6. 默认 1 条 / 次，1 次/秒/连接，每 Topic 并发 1（§11.11）。

### 4.4 本地存储与审计（§14.4、§16.5）
`favorites`、`payload_templates`、`send_history`、`metric_samples`、`audit_events`。发送历史默认不存 Payload 正文。

### 4.5 `Metric<T>` 结构性改造（§14.1）—— **需用户决策**

上游要求每个字段自带质量标记：

```ts
interface Metric<T> {
  value: T | null;
  quality: "fresh" | "stale" | "partial" | "notRequested" | "unsupported" | "forbidden" | "unknown";
  observedAt: string | null;
  reason?: string;
}
```

本仓库现状：`T | null` + envelope 级 `warnings[]` + `source` + `freshnessMs`。**方向一致，粒度不同** —— 我们能分「未知 / 真实 0」，分不出「没请求 / 无权限 / 不支持」。

不做，§23 的「缺失、未请求、无权限与 0 分开表示」只能做到一半。做，触及每一层。**越早决定越便宜。**

---

## 5. 接口映射（上游 §14.3 → 本仓库）

| 上游接口 | 本仓库命令 | 状态 |
|---|---|---|
| `connections.list` | `broker_list_connections` | ✅ |
| `connections.save` | `broker_upsert_connection` | ✅ |
| （连接删除） | `broker_delete_connection` | ✅ |
| `connections.testObserve` | `broker_test_connection` | ⚠️ **违规，§3.1** |
| `topics.list` | `broker_list_topics` | ✅ |
| `topics.snapshot` | `broker_get_topic_detail` | ✅ 缺预算控制 |
| （Overview 异常面板） | `broker_get_overview` | ✅ |
| （拓扑导航） | `broker_list_tenants` / `broker_list_namespaces` | ✅ |
| `topics.partitions` | — | ❌ |
| `schemas.read` | — | ❌ |
| `policies.read` | — | ❌ |
| `observe.pause` | — | ❌ |
| `send.validateLocal` | — | ❌ |
| `send.prepare` | — | ❌ |
| `send.execute` | — | ❌ |
| `history.list` | — | ❌ |
| `diagnostics.export` | — | ❌ |

**14 项中已有 5 项（1 项违规），另有 4 项本仓库特有且被上游导航结构涵盖。**

---

## 6. 实施阶段

沿用上游 §20 的阶段命名，但把**已完成的工作归位** —— 我们实际做的是它的阶段 B，且跳过了阶段 A。

### 阶段 0 — 收尾与合规（无外部依赖，可立即执行）

| # | 内容 | 依据 |
|---|---|---|
| 0.1 | Phase A 最终审核三条发现 | 旧计划 + §4.5 / §23 |
| 0.2 | **移除建删 topic 的写探测** | §3.1 |
| 0.3 | `/stats` 补安全参数 | §3.2 |
| 0.4 | 64-bit 计数器改字符串传输 | §3.3 |
| 0.5 | `SubscriptionType` 三态 | §3.4 |
| 0.6 | `internalStats` 补白名单 | §3.5 |
| 0.7 | `read_without_ack` 移出 lib | §4.1 |

**0.2 是硬前置**：未完成前，QAT 连接不得点「测试连接」。

### 阶段 A — 协议与安全验证（**阻塞于用户**）

上游 §13.3 的 SDK 验证表：TLS / 证书链 / 主机名校验、Token 与过期刷新、Proxy / Lookup / SASE 可达、Partitioned Topic、**Shared Producer 不 fencing**、Key / Properties 字节语义、Raw / Schema 编码、**Receipt / Timeout 三态可分**、Reconnect 内部重试、Close 回收、**运行路径无隐式 Reader / Consumer**。

**本仓库的未验证缺口**：`binary.rs` 的 `client()` 不带任何认证与 TLS 配置：

```rust
async fn client(broker_url: &str) -> Result<Pulsar<TokioExecutor>, BinaryError> {
    Pulsar::builder(broker_url, TokioExecutor).build().await
}
```

Phase 0 的 V-C3 只证明了 `pulsar` crate 对**本机无认证 broker** 可用。带 JWT 的 `pulsar+ssl://` 连接**从未验证**。

探针**只连接、不发消息、不建订阅**。

**需要用户提供**：换发后的受控 token（建议仅 produce 权限，非 super-admin）、QAT broker URL、SASE 通路要求。

### 阶段 B — Observe 补齐（无外部依赖）
§4.2 全部。

### 阶段 C — Send Message
§4.3 全部。依赖阶段 A 通过。

### 阶段 D — `Metric<T>` 改造（**需用户决策**）
§4.5。建议在阶段 B 之前决定，否则返工面积随 B、C 增长。

---

## 7. 待用户确认

| # | 问题 | 影响 |
|---|---|---|
| 1 | **阶段 D（`Metric<T>`）做不做？** | 唯一的结构性分歧；越晚决定越贵 |
| 2 | **QAT token（换发后）与 broker URL** | 阶段 A 完全阻塞 |
| 3 | 阶段顺序：0→A→B→C，还是 0→A→C→B（先出 Send） | 后者的发送界面要建在不完整的 Observe 上 |
| 4 | 获准发送的 Topic / Namespace 范围（§11.10） | Send 的 allowlist 需要它 |
| 5 | Observe 与 Produce 是否分开凭据（§16.1） | 影响连接模型 |

上游 §25 另列了 11 项需 SRE 确认的配置（版本、网关前缀、重定向主机、Schema 现状、自动创建策略等），未确认前一律标 Unknown，不猜测。

---

## 8. 凭据事故记录

用户曾在会话中粘贴一个**有效的 StreamNative QAT JWT**，scope 为 `["admin","access"]`。已建议吊销重发。**该 token 未写入任何文件、ledger 或 memory，且不得写入。**

上游 §16.3 对此有明确要求：「截图中出现过的认证令牌不应继续复制到示例或文档；建议按团队流程评估换发/吊销与传播范围。不要把 Token 粘贴到公开的 JWT 调试网站。」

---

## 附：本文档与既有文档的关系

| 文档 | 状态 |
|---|---|
| `2026-09-16-penguin-pulsar-panel-product-spec.md` | **上游权威**，用户提供，定义「要什么」 |
| 本文档 | **现行实施依据**，定义「在本仓库怎么做」 |
| `2026-09-16-penguin-broker-phaseA-design.md` | 历史记录。D-A1/D-A2/D-A3 三条裁决仍有效 |
| `2026-09-15-penguin-broker-phase0-design.md` | 历史记录。全阶段验证矩阵（V-A1…V-F4）仍是实测证据来源 |
| `.superpowers/sdd/2026-09-16-penguin-broker-phaseA/progress.md` | 33 条裁决的推理与代价记录，R18/R22/R29/R31 与本文档 §3 直接相关 |
