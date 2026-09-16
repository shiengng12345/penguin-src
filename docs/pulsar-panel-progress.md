# Penguin Pulsar Panel —— 进度

> **这是什么**：一份活文档，回答三个问题 —— 现在到哪了、下一步做什么、需要你做什么。
> 最后更新：2026-09-16 · 分支 `feat/broker-module` · `main` 未动

**产品定位**：观察现有 Pulsar 状态 + 手动发送测试消息。**不消费消息，不创建订阅。**

| 文档 | 作用 |
|---|---|
| [`specs/…product-spec.md`](superpowers/specs/2026-09-16-penguin-pulsar-panel-product-spec.md) | 上游权威，定义「要什么」（用户提供，1861 行） |
| [`specs/…conformance.md`](superpowers/specs/2026-09-16-penguin-pulsar-panel-conformance.md) | 实施依据，定义「在本仓库怎么做」 |
| [`api-allowlist.md`](api-allowlist.md) | 调用了哪些 Admin 端点、为什么、以及**刻意不调用什么** |
| 本文档 | 进度与待办 |

---

## 一、总体

| 阶段 | 内容 | 完成度 |
|---|---|---:|
| Phase 0 | 验证地基（实测六个后续阶段的假设） | **100%** ✅ |
| Phase A | Console 控制塔（看状态） | **95%** 🟡 |
| Stage 0 | 合规修复 + 本机 QAT 模拟 | **100%** ✅ |
| Stage A | 协议与安全验证（JWT + TLS） | **0%** ⬜ |
| Stage B | Observe 补齐 | **0%** ⬜ |
| Stage C | **Send Message（打消息）** | **0%** ⬜ |
| **总体** | | **约 45%** |

### 当前基线（每次都实跑，不凭记忆）

```
cargo test        323 passed, 4 ignored     # 4 个是 TLS 测试，需 secure broker
pnpm test:ui      178 passed
pnpm typecheck    exit 0
pnpm build        exit 0
pnpm broker:gate  PASSED
业务 topic         10 个完好，零残留
分支提交           104（自 main）
```

> ⚠️ `pnpm test` 的失败集**恰好是 6 个已知既存文件 —— 前提是 `broker-pulsar-secure` 在运行**。
> 容器停着时会多出第 7 个（`local-secure profile produces real 401/403 shapes`），那是容器状态，不是回归。

---

## 二、需要你做的（按紧急程度）

### 🔴 只有你能做

**1. GUI 走查** —— Phase A gate 的最后一项，也是那 5% 的全部。
清单：`.superpowers/sdd/2026-09-16-penguin-broker-phaseA/task-14-report.md`，11 步，约十分钟。
我无法启动桌面应用点击，所以**在你走完之前 Phase A 不算完成**。
走查用本机 `pulsar` 连接即可。

### 🟡 需要你决定

| # | 问题 | 为什么现在问 |
|---|---|---|
| 2 | **获准发送的 topic 范围** | 你说了「列出全部、不能手输」，但规格 §11.10 建议管理员**预先准备隔离的测试 namespace**，并确认它的订阅、复制、下游环境。「broker 上的全部 topic」和「一个审核过的隔离资源」是两回事 —— 后者才是规格要的。Stage C 的 allowlist 依赖它 |
| 3 | **Observe 与 Produce 分开凭据？**（§16.1） | 影响连接模型（一个连接要不要存两套凭据引用）。Stage C 之前必须定，之后再拆更贵 |
| 4 | **`BacklogOlderThanThreshold` 现在永远「无法判定」** | 因为安全参数 `earliestTimeInBacklog` 恒为 false。现在的行为是**诚实的**（不再假称已检查），但这项能力等于不存在。规格 §12.3 写的是「需要时按需读取」—— 要不要在 Stage B 加一个按需动作？ |

### ⚪ 需要问 SRE（规格 §25 列了 11 项，这是影响最大的 5 项）

QAT/UAT 的 Pulsar 版本 · 真实 Admin URL 与网关前缀 · SASE 通路与证书要求 · Topic/Schema 自动创建策略 · 现有 topic 上有没有 Exclusive Producer

---

## 三、已完成

### Phase 0 — 验证地基 ✅

不写功能，只回答「后面每个阶段会不会撞墙」。两个发现直接改了架构：

- **V-E5**：Admin REST 的 `POST` 发消息 → **405**，根本没有 produce 能力 → 发送必须走 binary 协议
- **V-C1**：WebSocket Reader 本机可用，但**真实 broker 默认关闭** → 「本地能跑、生产打脸」

这两条共同逼出**双传输层**（Admin REST 看状态 + binary 协议发消息）。

### Phase A — Console 控制塔 🟡 95%

14 个任务全部完成并审核。能看：租户 → namespace → topic → 订阅 → 消费者 → 异常面板。

**真正的产出不是界面，是「未知 ≠ 0」这条诚实链** —— 五个后端任务把 Pulsar 用 in-band 哨兵编码的「未知」从真实数值里分出来：

| 字段 | Pulsar 的哨兵 | 本仓库类型 |
|---|---|---|
| `oldestBacklogMessageAgeSeconds` | `-1` = 从未有过积压 | `BacklogAge { Seconds, NoBacklog, Unknown }` |
| `lastAckedTimestamp` | `0` = 从未 ack | `ConsumerTimestamp { Millis, Never, Unknown }` |
| `subscriptions[].type` | `"None"` = 未设置 | `SubscriptionType { Named, Unset, Unknown }` |

三者线格式都由测试钉死，TS 侧是判别联合，消费端是穷尽 `switch` —— 新增状态会**编译失败**而非静默落空。

差的 5%：**GUI 走查**。

### Stage 0 — 合规修复 + 本机 QAT 模拟 ✅

| # | 任务 | 提交 |
|---|---|---|
| 2 | 移除建删 topic 的写探测 | `9292b9bd` |
| 1 | `/stats` 五个安全参数 + `StatsRequestScope` | `4d5b189c` `ad5eabfc` |
| 3 | 64-bit 计数器改十进制字符串传输 | `4e01c231` |
| 3.1 | 拆分超出 400 行上限的 `stats.rs` | `dfa55d5f` |
| 4 | `read_without_ack` 移出 lib | `f1efef09` |
| 5 | `docs/api-allowlist.md` | `5e010a0f` |
| — | 删除死代码 `list_subscriptions` | `992fe87b` |
| 6 | 本机 TLS（JWT + `pulsar+ssl://`） | `3fe07edc` |
| — | 全量审核四项修复 | `a0efb8ed` `e2412739` `249a2290` `40906dea` |

**修掉的五条规格违反，其中三条在本机永远不会变红：**

| 违反 | 本机能否测出 |
|---|---|
| 「测试连接」在目标集群**建 topic 再删** | ❌ 本机无认证，一直「跑得通」 |
| `/stats` 缺安全参数（可能拿 Ledger 锁） | ❌ 10 个空 topic 没有压力 |
| 64-bit 计数器**静默丢精度** | ❌ 要到 2⁵³ 才显现 |
| `subType` 把确定事实压成「未知」 | ✅ 你的 `fpms_topup` 上当时就是 |
| `internalStats` 不在白名单 | —（文档问题） |

**本机现在能模拟你的 QAT**：`pulsar+ssl://` + JWT，四个测试，**其中三个是负向的**（错误 CA 必失败、不带 CA 必失败、无效 token 必失败）。有这三条才分得出「TLS 生效」和「TLS 压根没开」。

---

## 四、接下来

### Stage A — 协议与安全验证（可立即开始，不需要你的凭据）

验证规格 §13.3 那张 SDK 表：TLS 证书链与主机名校验、token 与过期刷新、Proxy/Lookup/SASE 可达、Partitioned Topic、**Shared Producer 不驱逐现有 producer**、Key/Properties 字节语义、**Receipt/Timeout 三态可分**、Reconnect 内部重试、Close 回收、**运行路径无隐式 Consumer**。

**未验证缺口**：`binary.rs` 的建连不带任何认证与 TLS 配置 —— Phase 0 的 V-C3 只证明了 crate 对**本机无认证 broker** 可用。

探针**只连接，不发消息，不建订阅**。

### Stage B — Observe 补齐

Producers 视图 · Schema 查看 · 只读 Policies · 分区下钻 · non-persistent topic · 暂停刷新 · 脱敏诊断导出 · **按 broker 版本的能力矩阵**（带 fixture，让「不支持」成为测量结果而非猜测）

⚠️ **Producers 视图要注意**：它会第一次读 Pulsar 的 `publishers` 字段，届时**必须同时接上 `excludePublishers` 开关** —— 否则会重演 Stage 0 修掉的伪造故障（被排除的空列表被当成「确实没有」）。

### Stage C — Send Message

八态状态机：`Draft → Validated → AwaitingConfirmation → Sending → Accepted / Rejected / CancelledBeforeSend / UnknownOutcome`

**最难的不是发消息，是 `UnknownOutcome`**：超时**不等于**没发出去。所以不能自动重发，重发必须用户手动点，且要提示可能重复（§11.7）。

其他硬约束：只用 Shared Producer（不驱逐现有的）· topic 必须已存在 · 确认令牌由 Rust 侧生成并绑定内容指纹 · 用户确认后字节不得再变。

**地基已在**：`produce_one` 已建并测试、`WriteGuard`/`WritePermit` 安全闸门已建、连接模型已存 `broker_url` + JWT、本机 JWT+TLS 环境已就绪。缺的是中间那条链 —— **让 binary 客户端带上认证**（Stage A）。

---

## 五、已知限制（诚实清单）

- **`BacklogOlderThanThreshold` 在线上永远「无法判定」** —— 见待决问题 4。
- **`useTopicDetail` / `useBrokerOverview` 没有请求取消保护** —— 较早的在途响应理论上可能在更新请求之后返回。既存问题，已记录。
- **TLS 的三个负向测试接受任何 `Err(_)`** —— 换个错误原因（坏 token、URL 格式错）它们同样通过。Stage A 应把断言收紧到「错误确实来自证书校验」。
- **`exclude_publishers` 目前无消费者** —— 见 Stage B 的注意事项。
- **`internal_stats.rs` 390 行**，逼近 400 上限。
