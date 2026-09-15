# Penguin Broker 模块 — Phase 0：全阶段前置验证 + 地基

> Status: Draft for review · Date: 2026-09-15 · Module: `broker`
> 验证环境：本机 Colima Docker · Apache Pulsar **4.2.4** standalone

## Phase 0 的定位

**Phase 0 不只验证自己，它要把 Phase A–F 每一个阶段的关键假设全部提前实测。**

原则：**任何一个后续 phase 依赖的能力，必须在 Phase 0 被证实或被证伪。**
不允许做到 Phase C 才发现消息读不出来。Phase 0 gate 不过，后面一个 phase 都不开工。

验证有三种结局，都算 Phase 0 通过：

| 结局 | 含义 | 处理 |
|---|---|---|
| ✅ **Confirmed** | 能力可用，形状已知 | 写进契约，后续 phase 直接用 |
| ⚠️ **Constrained** | 能用，但有非显而易见的限制 | 限制写进对应 phase 的设计约束 |
| ⛔ **Blocked** | 此路不通 | **在开工前**改该 phase 的设计，不是开工后 |

不允许的第四种：`Not validated` —— 带着未验证的假设进入任何 phase。

---

## 1. 已锁定的决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 模块名 **Broker**，不叫 Pulsar | 未来会接其他队列。`broker` 是 Pulsar / Kafka / RabbitMQ / RocketMQ 四家唯一字面都成立的词。`stream` 偏 Pulsar/Kafka，`queue` 偏 RabbitMQ。 |
| D2 | 挂在 `MainSidebar` 第 6 个 rail，gating `super-admin` | 与 Docs / Wiki 同级。完整模块，不是 Extras 小挂件。 |
| D3 | **一次只 active 一个连接** | 切换时重跑 capability discovery。写操作误点错集群的风险实在。 |
| D4 | SQLite 表和 Tauri command **从第一天带 `connection_id`** | 日后开多连接不用改接口。 |
| D5 | 拆成 Phase 0 + A–F，各自完整 spec + 完整测试 | 不降标准，只是不把 7 份 spec 塞成 1 份。 |
| D6 | 凭证沿用 **DEC #195** | `rest` 模块已验证：明文永不过 IPC，FE 只持 `handleId`。 |
| D7 | Adapter 边界从第一天就有，但只实现 Pulsar | 守 YAGNI。 |
| **D8** | **双传输层：Admin REST + 原生二进制协议（`pulsar` crate 6.9.0）** | **由 V-C1 / V-E5 强制得出**，见第 3 节。这是本次验证最重大的架构后果。 |

---

## 2. 全阶段验证矩阵

全部结论取自本机 Pulsar 4.2.4 实测，附原始响应。

### 2.1 Phase A — Console 控制塔

| ID | 假设 | 结果 | 证据 |
|---|---|---|---|
| V-A1 | topic stats 字段够用 | ✅ | `msgRateIn/Out`、`backlogSize`、`storageSize`、`msgInCounter`、`backlogQuotaLimitSize` 等齐全 |
| V-A2 | internalStats 可见 cursor / ledger | ✅ | `cursors.{sub}.markDeletePosition/readPosition`、`ledgers[]`、`lastConfirmedEntry` |
| V-A3 | partitioned-stats 可用 | ✅ | `200` |
| V-A4 | consumer 详情够做诊断 | ✅ | `consumerName`、`address`、`clientVersion`、`availablePermits`、`unackedMessages`、`lastAckedTimestamp`、`lastConsumedTimestamp`、`msgRateOut`、`blockedConsumerOnUnackedMsgs` |
| V-A5 | Admin REST 支持分页 | ⛔ | `?page=0&size=2` → `200` 但返回全量数组，参数被静默忽略 |
| V-A6 | topic 列表是逻辑 topic | ⛔ | 返回展开分区：`t1, t2-partition-0…3`；逻辑 topic 只在 `/partitioned` |
| V-A7 | namespace policy / permission 可读 | ✅ | `permissions` → `{}`，`backlogQuotaMap` → `{}`，均 `200` |

**对 Phase A 的设计约束**
- V-A5 → 分页/排序/过滤全部在 Rust 层：`fetch-all → SQLite 快照 → Rust 分页`。附带满足 10k topics 性能与离线缓存。
- V-A6 → 必须对两端点 diff 后折叠，一个 4 分区 topic 是**一行**可展开，不是 4 行。

### 2.2 Phase B — Message Forensics

| ID | 假设 | 结果 | 证据 |
|---|---|---|---|
| V-B1 | peek 能拿到 payload | ✅ | `200`，body=payload，`X-Pulsar-Message-ID`、`X-Pulsar-publish-time`、`X-Pulsar-producer-name` |
| V-B2 | **peek 不会消费消息** | ✅ **安全** | peek 3 条前后 `markDeletePosition` / `readPosition` 均为 `53:-1` 不变；`msgBacklog` 保持 `5`，`unackedMessages` 保持 `0` |
| V-B3 | peek 无需订阅 | ⚠️ | **必须已存在 subscription**。无订阅的 topic 要 peek 就得先建订阅＝写操作 |
| V-B4 | 分区 topic 能直接 peek | ⛔ | `405 {"reason":"Peek messages on a partitioned topic is not allowed"}`；必须逐分区 peek（`t-partition-0` → `200`） |
| V-B5 | **peek 返回单条可读消息** | ⛔ **重大** | 批量写入下 2053 条消息 → **8 个 entry**。peek 返回 `X-Pulsar-num-batch-message: 248`、`X-Pulsar-batch-size: 17986`，body 是 **17976 字节的原始批帧**（`0000 0004 1840 4000` + 拼接 payload），不是单条消息 |
| V-B6 | 关联键随消息回传 | ✅ | `X-Pulsar-PROPERTY: {"traceId":"tr-abc","correlationId":"corr-123"}` 完整往返 |
| V-B7 | retry/DLQ properties 可验证 | ⛔ | 随容器的 `pulsar-client consume` **没有 nack / DLQ 参数**，无法触发；property 名（`RECONSUMETIMES` / `REAL_TOPIC` / `ORIGIN_MESSAGE_ID` 等）**未经实测** |

**对 Phase B 的设计约束**
- V-B2 是本轮最重要的安全结论：**观察者不会偷走业务消息**。这条必须有回归测试守住。
- V-B4 → Message Inspector 对分区 topic 要扇出到 N 个分区再归并，UI 和查询预算都要按 N 倍算。
- V-B5 → **必须自己实现 Pulsar 批帧解析**（`X-Pulsar-num-batch-message > 1` 时按 Pulsar 线格式拆包）。原计划完全没提这件事。不做的话，任何开了 batching 的生产 topic（几乎全部）在 Inspector 里都是乱码。
- V-B7 → Phase 0 必须**自己写一个真实 consumer 模拟器**触发 retry/DLQ，把真实 property 名抓下来。不许照文档写死。

### 2.3 Phase C — Lifecycle Timeline

| ID | 假设 | 结果 | 证据 |
|---|---|---|---|
| V-C1 | 能持续读 topic 而不 ack | ⚠️ **陷阱** | 本机 WebSocket Reader 可用：`101 Switching Protocols`，`standalone.conf: webSocketServiceEnabled=true`；**但 `broker.conf: webSocketServiceEnabled=false`** —— 真实 broker 部署默认关闭 |
| V-C2 | Admin REST 足够做 timeline | ⛔ | peek 是轮询且需订阅（V-B3），无法作为持续事件流 |
| V-C3 | 原生二进制协议客户端可用 | ✅ | `pulsar` crate **6.9.0**，streamnative 官方，2026-08-24 更新，240 万下载，不依赖 `webSocketServiceEnabled` |
| V-C4 | 关联键可用 | ✅ | 同 V-B6 |

**对 Phase C 的设计约束**
- **V-C1 是典型的"本地能跑、生产打脸"**：WebSocket 在 standalone 开着，在真实 broker 关着。若按本地结果设计，Phase F 接 SRE 时才会炸。
- → **Phase C 的传输层定为原生二进制协议（`pulsar` crate），WebSocket 只作本地开发的可选便利，不进主路径。**

### 2.4 Phase D — Schema Center

| ID | 假设 | 结果 | 证据 |
|---|---|---|---|
| V-D1 | 能取 schema | ✅ | `200` `{"version":0,"type":"JSON","timestamp":…,"data":"…","properties":{}}` |
| V-D2 | 能取版本列表 | ✅ | `200` `{"getSchemaResponses":[…]}` |
| V-D3 | 兼容性检查返回干净结果 | ⛔ **陷阱** | 兼容 → **`202`** `{"schemaCompatibilityStrategy":"FULL","compatibility":true}`；**不兼容 → `500`**，Avro 异常堆栈塞在 `reason` 里 |
| V-D4 | namespace 策略是对象 | ⚠️ | 返回裸 JSON 字符串 `"UNDEFINED"`，不是对象 |
| V-D5 | 无 schema 的 topic | ✅ | `404 {"reason":"Schema not found"}` —— 正常情况，非错误 |

**对 Phase D 的设计约束**
- V-D3 → **`500` 在这里不等于"服务器故障"**。错误映射必须特判 schema 兼容性端点：`500` + `reason` 含 `SchemaValidationException` → 映射为 `SCHEMA_INCOMPATIBLE`（业务结果），而不是 `SOURCE_UNAVAILABLE`（重试类错误）。否则 UI 会对用户说"服务器错误"，而真相是"你的 schema 不兼容"。
- 成功码是 `202` 不是 `200`，`2xx` 判断不能写死 `== 200`。

### 2.5 Phase E — Guarded Actions + Replay

| ID | 假设 | 结果 | 证据 |
|---|---|---|---|
| V-E1 | 管理类写操作可用 | ✅ | tenant / namespace / topic / 分区扩容 / subscription 均 `204` |
| V-E2 | cursor 操作可用 | ✅ | `resetcursor` 按时间 `204`、按 messageId `204`；`skip/1` `204`；`skip_all` `204` |
| V-E3 | unload 可用 | ✅ | topic unload `204`、namespace unload `204` |
| V-E4 | terminate 行为已知 | ⚠️ | `200` 并返回 `{"ledgerId":75,"entryId":-1,…}`。**不可逆**，topic 从此不再接受写入 |
| V-E5 | **Admin REST 能 produce（沙盒 replay 需要）** | ⛔ | `POST /admin/v2/persistent/{ns}/{topic}` → **`405`**。Admin REST 根本没有 produce 能力 |
| V-E6 | 删除有依赖顺序 | ⚠️ | 删 tenant 时 namespace 还在 → `409`；先删 namespace 再删 tenant → `204` |
| V-E7 | `force` 参数语义一致 | ⛔ | `DELETE namespace?force=true` → **`405`**，不带 force → `204`；**topic 反而必须带** `?force=true` |
| V-E8 | `read_only` 有外部保障 | ⛔ | 本地无认证，上述写操作**全部放行**。带假 Bearer token 查询仍 `200` |

**对 Phase E 的设计约束**
- V-E5 → **沙盒 replay 必须走原生二进制协议**（与 V-C3 同一条依赖）。这是 D8 双传输层的第二个强制理由。
- V-E6 → 删除必须做**级联预检**，先查依赖数量给出影响范围，不能把 `409` 甩给用户。
- V-E7 → capability matrix 必须**逐参数组合实测**，禁止从文档推断。
- V-E8 → `read_only` 只能是**我们 Rust 层的硬闸门**，必须有先红后绿的失败测试。

### 2.6 Phase F — SRE 非生产 + 发布

| ID | 假设 | 结果 | 处理 |
|---|---|---|---|
| V-F1 | 401 / 403 的真实形状 | ⛔ **本地无法验证** | 假 Bearer token → `200`（本地无认证）。**Phase 0 必须起一个 `local-secure`（JWT+TLS）Pulsar** 来抓真实形状 |
| V-F2 | 429 限流形状 | ⛔ 未验证 | 同上，随 `local-secure` 一起抓 |
| V-F3 | SRE 的 Pulsar 版本 | 未知 | capability discovery 就是为此而建；无凭证前无法验证，**接受为已知未知** |
| V-F4 | 镜像版本可锁定 | ⚠️ | 当前 `apachepulsar/pulsar:latest`，违反禁用 `latest` 规则。digest 已取得：`sha256:cd5d4a64a32c0770d5d2dbb526169a70081605bbec4b59b73471b68d0a451fb4` |

**对 Phase F 的设计约束**
- V-F1/F2 → `local-secure` profile 从「Phase E 的任务」提前到 **Phase 0 的任务**。认证失败路径是全模块的错误契约基础，不能等到最后才见到第一个真实的 `401`。
- V-F3 是本模块唯一接受的「已知未知」，因为它在物理上依赖 SRE 凭证。

---

## 3. 验证带来的架构后果

### D8 — 双传输层（由 V-C1 / V-C3 / V-E5 强制得出）

原计划默认 Admin REST 能撑起全部功能。实测证伪：

| 能力 | Admin REST | 结论 |
|---|---|---|
| 拓扑 / stats / 运维动作 | ✅ | Admin REST 负责 |
| peek 单条消息 | ⚠️ 需订阅、禁分区、批帧未解 | Admin REST 勉强可用，需大量补丁 |
| **持续读取事件流（Phase C）** | ⛔ | **原生二进制协议** |
| **produce（Phase E 沙盒 replay）** | ⛔ `405` | **原生二进制协议** |

```
src-tauri/src/broker/adapters/pulsar/
  ├── admin_rest.rs    reqwest → Admin REST     拓扑、stats、schema、运维动作
  ├── binary.rs        pulsar crate 6.9.0 → :6650   Reader（Phase C）、Producer（Phase E）
  └── batch_frame.rs   Pulsar 批帧解析（V-B5）
```

WebSocket **不进主路径**——V-C1 证明它在真实 broker 上默认关闭。

**Phase 0 必须完成的 spike**：用 `pulsar` crate 对本机 `pulsar://localhost:6650`
跑通「建 Reader → 不 ack 读完 → 关闭」和「produce 一条到隔离 topic」。
只验证可行性，不写产品代码。

---

## 4. Phase 0 交付物

### 4.1 验证类（本 spec 第 2 节的自动化固化）

| # | 交付物 | 说明 |
|---|---|---|
| V1 | **Probe harness** `scripts/broker-capability-probe.mjs` | 第 2 节全部断言的可执行版本。日后变成 app 内 Test Connection + CI fixture 生成器 + 接 SRE 时的第一道验证 |
| V2 | **`local-secure` Pulsar** | JWT + TLS 的第二个 compose profile，用于抓 V-F1/F2 的真实 `401`/`403`/`429` 形状 |
| V3 | **Consumer 模拟器** | 真实 consumer 应用（非 CLI），触发 retry + DLQ，抓 V-B7 的真实 property 名 |
| V4 | **原生客户端 spike** | `pulsar` crate 的 Reader / Producer 可行性验证（第 3 节） |
| V5 | **批帧解析 spike** | 证明能把 V-B5 的 17976 字节批帧拆成 248 条消息 |
| V6 | **`COMPATIBILITY.md`** | 锁定镜像 digest，CI 禁用 `latest` |

### 4.2 地基类

| # | 交付物 | 说明 |
|---|---|---|
| F1 | **冻结契约** | `ResultEnvelope`、错误映射表（含 V-D3 特判）、`BrokerConnection`、`CapabilitySnapshot` |
| F2 | **连接 CRUD** | SQLite 表 + Rust commands + Keychain（DEC #195）+ 表单 + Test Connection |
| F3 | **`DataTable` 原语** | 通用、虚拟滚动、可展开行、五态 |
| F4 | **端到端穿刺** | 只读 topic 列表页，实地跑通 V-A5（Rust 侧分页）与 V-A6（分区折叠） |

F4 刻意只做列表。它的存在是**验证链路**，不是交付功能。

---

## 5. 数据模型

### 5.1 `BrokerConnection`

```ts
type BrokerKind = "pulsar";              // 今天只有一种；schema 已留位

interface BrokerConnection {
  id: string;
  kind: BrokerKind;
  name: string;
  color: string;                         // 复用 ENV_COLORS
  adminUrl: string;                      // http://localhost:8080
  brokerUrl: string;                     // pulsar://localhost:6650  ← D8 后不再是可选项
  authType: "none" | "jwt" | "oauth2" | "tls";
  secretHandleId: string | null;         // → Keychain。Token 绝不进 SQLite
  defaultTenant: string;
  defaultNamespace: string;
  readOnly: boolean;                     // 默认 true
  tlsVerify: boolean;
  timeoutMs: number;
  lastStatus: ConnectionStatus;
  lastCheckedAt: number | null;
  brokerVersion: string | null;
  capabilities: CapabilitySnapshot | null;
  createdAt: number;
  updatedAt: number;
}

type ConnectionStatus =
  | "unknown" | "ok" | "unreachable" | "unauthorized" | "forbidden" | "tls_error";
```

### 5.2 `CapabilitySnapshot` — 实测，不是配置

```ts
interface CapabilitySnapshot {
  probedAt: number;
  brokerVersion: string | null;
  clusters: string[];
  endpoints: Record<string, EndpointProbe>;
  // 由第 2 节的验证项直接映射而来
  canPeek: boolean;                 // V-B1
  peekRequiresSubscription: boolean;// V-B3
  peekOnPartitionedAllowed: boolean;// V-B4 —— 本地实测为 false
  batchFrameSeen: boolean;          // V-B5
  binaryProtocolReachable: boolean; // V-C3 —— :6650 可达
  webSocketEnabled: boolean;        // V-C1 —— 仅供参考，不进主路径
  canProduce: boolean;              // V-E5 —— 必然经由 binary，非 REST
  canWrite: boolean;                // V-E8 —— 实测能否写
  hasMetrics: boolean;
  warnings: string[];               // 例："镜像使用 :latest tag"
}
```

**关键设计**：`canWrite`（探测到的事实）与 `readOnly`（用户设的策略）是两个字段。
V-E8 证明本地对所有写操作放行，所以拦截只能在我们这边——两者合并成一个，安全闸门就没了。

### 5.3 `ResultEnvelope` 与错误映射

```ts
type ResultEnvelope<T> = {
  data?: T;
  source: string;                 // "pulsar-admin-rest" | "pulsar-binary"
  observedAt: string;
  freshnessMs: number;
  warnings: string[];
  error?: { code: BrokerErrorCode; message: string; retryable: boolean };
};
```

| HTTP | `reason` 示例 | code | retryable |
|---|---|---|---|
| 401 | — | `AUTHENTICATION_FAILED` | false |
| 403 | — | `FORBIDDEN` | false |
| 404 | `Namespace does not exist` / `Schema not found` / `Message not found` | `NOT_FOUND` | false |
| 405 | `Peek messages on a partitioned topic is not allowed` | `NOT_SUPPORTED_HERE` | false |
| 409 | `... is not the partitioned topic` | `CONFLICT` | false |
| 429 | — | `RATE_LIMITED` | true |
| **500** | **含 `SchemaValidationException`** | **`SCHEMA_INCOMPATIBLE`** | **false** |
| 5xx | 其他 | `SOURCE_UNAVAILABLE` | true |
| — | 连接失败 / 超时 / TLS / 非 JSON | `SOURCE_UNAVAILABLE` / `TIMEOUT` / `TLS_ERROR` / `MALFORMED_RESPONSE` | — |

`2xx` 判定必须接受 `200` / `202` / `204`（V-D3 的成功码是 `202`，写操作是 `204`）。

### 5.4 SQLite schema

沿用 `db.rs` 约定（`CREATE TABLE IF NOT EXISTS`、snake_case、`_json` 后缀、epoch 整数）：

```sql
CREATE TABLE IF NOT EXISTS broker_connections (
    id                TEXT PRIMARY KEY,
    kind              TEXT NOT NULL,
    name              TEXT NOT NULL,
    color             TEXT NOT NULL,
    admin_url         TEXT NOT NULL,
    broker_url        TEXT NOT NULL,
    auth_type         TEXT NOT NULL,
    secret_handle_id  TEXT,                    -- → Keychain，绝不存明文
    default_tenant    TEXT NOT NULL,
    default_namespace TEXT NOT NULL,
    read_only         INTEGER NOT NULL DEFAULT 1,
    tls_verify        INTEGER NOT NULL DEFAULT 1,
    timeout_ms        INTEGER NOT NULL DEFAULT 10000,
    last_status       TEXT NOT NULL DEFAULT 'unknown',
    last_checked_at   INTEGER,
    broker_version    TEXT,
    capabilities_json TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_broker_connections_updated
    ON broker_connections(updated_at DESC);

-- 因 V-A5（Admin REST 无分页），分页在 Rust 侧基于快照做
CREATE TABLE IF NOT EXISTS broker_topology_snapshots (
    id            TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    scope         TEXT NOT NULL,        -- 'tenants' | 'namespaces' | 'topics'
    scope_key     TEXT NOT NULL,        -- 'public/default'
    payload_json  TEXT NOT NULL,
    observed_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_broker_snapshot_key
    ON broker_topology_snapshots(connection_id, scope, scope_key);
```

**约束**：`broker_connections` 不得出现任何明文凭证列，由测试强制（第 7 节）。

### 5.5 当前 active 连接

依据 D3 同时只有一个 active。沿用现有 `activeEnvId` 做法存进 `app_kv`
（key `broker.activeConnectionId`），不单独开表：

- 切换时**重跑 capability discovery**，回写该连接的 `capabilities`
- 删除 active 连接时清空该键，UI 回空态
- 所有 Tauri command 仍显式接收 `connectionId`（D4）—— active 是 UI 概念，不是 adapter 概念

---

## 6. 凭证边界（沿用 DEC #195）

```
FE 表单输入 Token
  → broker_store_secret(connectionId, plaintext) 调用一次
  → Rust 写 Keychain，返回 handleId
  → SQLite 只存 secret_handle_id
  → FE 立即丢弃明文，此后只持 handleId

每次请求
  → FE 传 connectionId（不传 Token）
  → Rust 发请求前从 Keychain 解析注入
```

明文**永不**出现在：FE state、IPC payload、SQLite、日志、`error_log`、截图、Git。

---

## 7. 测试矩阵（Phase 0 交付条件）

| 层 | 必须测试 | 证据 |
|---|---|---|
| 验证固化 | 第 2 节 **全部 V-* 断言**，回归时会失败 | `broker-capability-probe` 报告 |
| `broker-core` | Rust 侧分页/排序/过滤、V-A6 分区折叠、错误分类（含 V-D3 特判）、capability 归并 | `pnpm test`（headless） |
| Rust adapter | 全部错误码映射、`2xx` 含 200/202/204、URL 构造、超时、取消 | `cargo test --workspace` + HTTP contract fixtures |
| **安全（关键）** | ① 明文不进 SQLite ② 不进 IPC ③ 不进日志/`error_log` ④ `read_only=true` 时 Rust **根本不发写请求** ⑤ endpoint allowlist 生效 | 每条一个**先红后绿**的失败测试 |
| SQLite | migration 幂等、并发读写、快照唯一键冲突、崩溃恢复、过期清理 | 隔离 SQLite 集成测试 |
| Tauri commands | allowlist、错误 envelope 形状、取消、超时、连接不存在 | Tauri 集成测试 |
| React | DataTable 五态、虚拟滚动、可展开行、表单校验、Test Connection 流程 | Vitest + Testing Library |
| 可访问性 | 键盘、focus、label、对比度、状态不依赖颜色 | axe |
| 真实集成 | 对本机 Pulsar 4.2.4 跑通全部 V-* | Docker 集成报告 |
| 故障注入 | 停容器、断网、错端口、错 URL、超时、非 JSON 响应 | fault-injection 报告 |

测试状态分四类独立记录：`Implemented` / `Verified` / `Not run` / `Blocked`。
**单元测试全绿不能替代真实 Pulsar 集成测试。**

---

## 8. Phase 0 Gate

全部满足才允许开 Phase A：

**验证类**
- [ ] 第 2 节所有 V-* 项均已固化为自动化断言，回归时会失败
- [ ] `local-secure` Pulsar 起得来，真实 `401`/`403`/`429` 形状已抓取并写入错误映射表
- [ ] Consumer 模拟器能触发 retry + DLQ，真实 property 名已记录（V-B7 解除）
- [ ] `pulsar` crate spike 通过：Reader 不 ack 读完 + Producer 写隔离 topic（V-C3/V-E5 解除）
- [ ] 批帧解析 spike 通过：17976 字节批帧能拆成 248 条消息（V-B5 解除）
- [ ] `COMPATIBILITY.md` 锁定镜像 digest，CI 禁用 `latest`

**地基类**
- [ ] 契约冻结：`ResultEnvelope`、错误映射表（含 `SCHEMA_INCOMPATIBLE` 特判）、`BrokerConnection`、`CapabilitySnapshot`
- [ ] 连接 CRUD 端到端可用：加连接 → Test → 看到 `4.2.4 / peek ✅ / binary ✅ / write ✅`
- [ ] 端到端穿刺：Topics 页列出本机 10 个真实 topic，分区折叠正确，Rust 侧分页可翻页
- [ ] 5 条安全测试先红后绿
- [ ] `DataTable` 原语五态 + 可展开行 + 虚拟滚动测试通过

**全局**
- [ ] 测试矩阵每行都有结果，**没有 `Not run` 或 `Blocked`**
- [ ] `cargo test --workspace`、`pnpm test`、`pnpm typecheck` 全绿
- [ ] 唯一允许遗留的未知是 **V-F3（SRE Pulsar 版本）**，因其物理上依赖 SRE 凭证

---

## 9. 若 Phase 0 验证失败怎么办

Phase 0 的价值在于**失败得早**。出现 ⛔ 时的处理顺序：

1. 记入风险登记，标注受影响的 phase
2. **在该 phase 开工前**改其设计（例：V-E5 证伪 REST produce → Phase E 改用二进制协议）
3. 若无替代方案，**缩减该 phase 的范围**并明确记录取舍，而不是带着已知缺陷开工
4. 绝不允许：把 ⛔ 记下来然后照原计划开工

本轮已触发第 2 条两次：V-C1/V-E5 共同导出 D8 双传输层。
这两个坑若不在 Phase 0 发现，会分别在 Phase C 和 Phase E 的中途爆炸。

---

## 10. 阶段依赖

```
Phase 0  ──→  Phase A  ──┬──→  B  Message Forensics
全阶段前置验证   Console     │      peek 扇出 / 批帧解析 / 脱敏
契约 / 安全边界   拓扑树      ├──→  C  Lifecycle Timeline
双传输层 D8      topic 详情   │      二进制 Reader / 关联引擎 / 双轨状态
DataTable       subscription ├──→  D  Schema Center
连接 CRUD        lag / stats  │      版本 / diff / 兼容性（202 与 500 特判）
端到端穿刺                    ├──→  E  Guarded Actions + Replay
                             │      预检 / RBAC / dry-run / 审计 / 二进制 produce
                             └──→  F  SRE Nonprod + Release
                                    真实接入 / 性能 / 故障注入 / 桌面 E2E
```

每个 phase 各自走完整的 spec → plan → TDD → 测试矩阵 → gate。标准不降。
