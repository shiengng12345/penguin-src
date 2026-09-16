# Penguin Pulsar Panel
## 产品需求、页面设计与技术开发规格

**定位：观察现有 Pulsar 状态 + 手动发送测试消息。不是 Consumer 应用。**

| 文档信息 | 内容 |
|---|---|
| 文档版本 | 1.0 |
| 整理日期 | 2026-09-16 |
| 文档语言 | 中文；保留必要的 API、字段与技术术语 |
| 产品名称 | Penguin Pulsar Panel，暂定显示名，不代表要求重命名其他 Penguin 项目 |
| 主要使用环境 | 经授权连接的 QAT / UAT Pulsar；其他环境使用独立连接配置 |
| 核心功能 | Topics、Subscriptions & Backlog、Consumers、Producers、Send Message |
| 硬性边界 | 不创建 Consumer / Reader / TableView，不创建 Subscription，不接收或 ACK 消息 |
| 技术状态 | 开发规格与建议架构；不是已经实现、连接或测试完成的产品 |
| 资料基线 | Apache Pulsar 4.0.x 官方文档；关键 REST 行为交叉核对 v4.0.0 源码。实际环境必须另行确认版本、权限、网关及 SDK 兼容性 |

> 本文所有 Topic、域名、数量、Message ID、Payload、性能数字均为示例或设计目标，不是你们 QAT/UAT 的实测结果。没有使用聊天截图中的 Token，也没有连接你们的 Pulsar。
>
> **本规格取代前面示意图片中的“完全不会影响现有系统”文案。准确说法是：不引入面板自己的消费订阅；查询有资源开销，发送消息会产生真实写入，并可能触发现有业务、增加已有订阅的积压。** [S01][S03][S04][S05]

---

## 目录

1. [需求定义与产品边界](#section-01)
2. [会影响什么，不会影响什么](#section-02)
3. [五个核心功能与信息架构](#section-03)
4. [示例界面与交互规则](#section-04)
5. [连接管理与 SASE 网络诊断](#section-05)
6. [Topics 与 Topic Detail](#section-06)
7. [Subscriptions & Backlog](#section-07)
8. [Consumers 与 Producers](#section-08)
9. [指标、分区与统计口径](#section-09)
10. [Schema 与只读 Policies](#section-10)
11. [Send Message 完整规格](#section-11)
12. [Admin API 对接与白名单](#section-12)
13. [推荐技术架构与 SDK 选型](#section-13)
14. [内部数据模型与接口契约](#section-14)
15. [刷新、缓存、历史与资源预算](#section-15)
16. [安全、权限与审计](#section-16)
17. [错误处理与可诊断性](#section-17)
18. [常用开发排查流程](#section-18)
19. [完整测试体系与测试用例](#section-19)
20. [交付阶段与质量门禁](#section-20)
21. [SRE 对接资料与沟通模板](#section-21)
22. [开发目录与工作包](#section-22)
23. [最终验收清单](#section-23)
24. [可交给开发者或 Coding Agent 的执行说明](#section-24)
25. [仍需现场确认的配置](#section-25)
26. [官方资料与源码索引](#section-26)

---

<a id="section-01"></a>

## 1. 需求定义与产品边界

### 1.1 用户真正要做的工具

> 我想做一个 Pulsar 面板，可以连接 QAT/UAT，查看 Topic、Producer、Consumer、Subscription、Backlog 等状态，也可以自己打一条测试消息。面板不消费消息，不需要创建 Subscription。

产品表达：

```text
Penguin Pulsar Panel
├── Observe：通过经过审核的 Admin REST 查询观察现有资源
└── Produce：用户明确确认后，通过 Producer 发送消息

没有 Consumer 模式
没有 Subscribe 模式
没有自动 ACK
没有为了验证发送结果而偷偷接收消息
```

Consumer 在本产品里是“被观察的对象”，不是“面板自身的角色”。

### 1.2 主要解决的问题

| 开发时的问题 | 面板提供的帮助 |
|---|---|
| 我应该往哪个 Topic 发消息？ | Topic 搜索、完整路径、环境与 Namespace 筛选 |
| 现在有没有 Producer 连着？ | 展示现有 Producer 实例及发布速率 |
| 有没有 Consumer 在线？ | 展示现有 Consumer、所属 Subscription、分区与连接信息 |
| 为什么消息好像没被处理？ | 查看积压、未 ACK、投递速率、重投递与阻塞信号 |
| 是整个 Topic 慢，还是某个 Partition 卡住？ | 逻辑 Topic 汇总与按 Partition 下钻 |
| Payload 应该是什么格式？ | 查看已有 Schema；本地校验编辑内容与编码方式 |
| 我要自己打一条测试消息 | 带环境确认、目标限制和明确结果状态的发送面板 |
| 发送成功后业务有没有执行成功？ | 明确区分 Broker 接收结果与业务结果，不伪造业务执行结论 |

### 1.3 必须满足的硬性约束

| 编号 | 约束 |
|---|---|
| B-01 | 应用运行时代码不调用创建 Consumer、Reader、TableView 的接口 |
| B-02 | 不创建、删除、修改 Subscription，不移动已有 Cursor |
| B-03 | 不接收消息，不 ACK / NACK，不订阅 Topic 来“监听状态” |
| B-04 | Observe 模式不初始化 Producer，也不发送测试消息 |
| B-05 | 只有明确的发送操作可以创建 Producer 并发送消息 |
| B-06 | 连接成功检查不得通过发送再接收消息完成 |
| B-07 | 不提供 Topic 创建/删除、清积压、跳过消息、Reset Cursor、改 Policies 等功能 |
| B-08 | 不把读取成功包装成“整个集群健康”或“业务运行正常” |
| B-09 | 所有远端访问遵守公司权限及网络要求，不绕过 SASE、访问控制或审计 |
| B-10 | 安全限制必须落实在可信执行层；不能只靠前端隐藏按钮 |

Pulsar Reader 的底层仍使用 Consumer 与非持久订阅，TableView 也使用 Reader。因此不能用这些接口绕过“我们没有 Consumer”这个产品约束。 [S04]

### 1.4 当前明确不纳入的功能

不做消息消费控制台、实时消息流、消息正文浏览器、消息回放、定时发送、批量灌消息、压测、Subscription 自动清理、Broker 运维管理、Functions/Sinks/Sources 管理。

这不是因为开发难度而降低标准，而是为了保持这次需求的角色边界。功能质量、性能优化、诊断能力和完整测试仍然按正式产品要求实施。

特别说明：Admin API 本身存在 Peek、按 Message ID 读取正文等接口；“查看消息正文一定要创建 Consumer”并不准确。但它们属于另一类数据访问能力，当前产品不调用这些接口，也不把它们混进普通状态查询。 [S01]

---

<a id="section-02"></a>

## 2. 会影响什么，不会影响什么

### 2.1 正确的连接关系

```text
你的电脑 / 被授权的执行节点
┌───────────────────────────────┐
│ Penguin Pulsar Panel          │
│                               │
│ Observe ─── Admin REST 查询 ───────────┐
│                               │       │
│ Send ───── Producer 发送 ──────────┐   │
└───────────────────────────────┘   │   │
                                   ▼   ▼
                             QAT / UAT Pulsar
                                   │
                             现有业务 Topic
                                   │
                         现有 Subscription / Consumer
                                   │
                             现有业务处理逻辑
```

面板没有连接到 Topic 的 Consumer 分支。

### 2.2 影响矩阵

| 行为 | 面板新建 Subscription？ | 消费现有消息？ | 其他可能影响 |
|---|---:|---:|---|
| 加载 Topics 列表 | 否 | 否 | HTTP、认证、元数据查询开销 |
| 查询 Topic Stats | 否 | 否 | Broker 计算、序列化、网络与可能的分区汇总开销 |
| 查看已有 Consumers / Producers | 否 | 否 | 读取统计快照；不是连接成 Consumer |
| 查看已有 Schema / Policy | 否 | 否 | 读取配置及元数据，需要相应权限 |
| 创建 Producer，尚未发送 | 否 | 否 | 连接、Producer 实例、Schema 协商及服务端相关资源 |
| 向现有 Topic 发消息 | 否 | 否 | 真正发布消息；可能增加存储、已有订阅的积压、业务执行与下游请求 |
| 关闭面板 | 不会留下由本面板创建的消费订阅 | 否 | 应关闭本面板连接；已发送消息不会被撤回 |

这是根据 Pulsar 的 Producer、Subscription、统计与积压机制对本产品所作的边界分析，不是“零负载”保证。 [S01][S03][S04][S05]

### 2.3 同事担心的问题是否适用

同事担心的是：本地 Consumer 建了持久 Subscription，电脑关掉后 Subscription 仍在，消息继续积压。

本产品不创建消费订阅，因此**不会引入这种“面板遗留 Subscription”问题**。

但是假设现有 Topic 已有一个暂停消费的 Subscription：

```text
existing-sub：原本有积压
       ↑
面板往它所属 Topic 再发送消息
       ↓
这个已有 Subscription 仍可能增加积压
```

因此必须区分：

**不新增消费订阅 ≠ 不会增加已有订阅的积压。** 持久消息保留、TTL、配额及订阅状态会共同影响实际结果。 [S03]

### 2.4 不能对用户作出的承诺

| 禁止使用的文案 | 应使用的文案 |
|---|---|
| 完全不会影响系统 | 不创建面板消费订阅；查询与发送仍有对应开销 |
| 只要不 Consume 就不会产生 Backlog | 不产生面板自己的消费积压；发送可能增加已有订阅的积压 |
| Send Success，业务成功 | Broker 已确认接收；业务处理结果未验证 |
| GET 都是绝对安全的 | 仅调用经过审核的操作与参数白名单 |
| Connected，所以集群 Healthy | Admin API 可访问；其他组件状态未验证 |
| 加上 test=true 就不会影响业务 | 测试标记只是元数据，是否隔离取决于实际业务和环境配置 |

### 2.5 GET 不一定只是被动检查

Pulsar v4.0.0 的 Broker Health Check 实现会创建 Producer 和 Reader，并发送、读取探测消息。它不适合本产品的“被动连接检查”。 [S05]

设计要求：不调用该主动 Health Check。使用获准的 Topic 列表或已知 Topic 的只读查询，展示“Admin API 可访问”，而不是声称进行了完整集群健康检查。

---

<a id="section-03"></a>

## 3. 五个核心功能与信息架构

### 3.1 主功能

| 模块 | 必须提供的能力 | 明确不做 |
|---|---|---|
| Topics | 搜索、筛选、完整路径、分区信息、Topic Detail、流量概览 | 创建/删除/卸载 Topic |
| Subscriptions & Backlog | 查看已有订阅、积压、未 ACK、投递状态、分区分布 | Subscribe、Unsubscribe、清积压、改 Cursor |
| Consumers | 查看已有实例、名称、地址、所属订阅、速率及阻塞信号 | 启动 Consumer、抢消息、断开其他 Consumer |
| Producers | 查看已有实例、发布速率、地址、Access Mode | 强制替换或驱逐其他 Producer |
| Send Message | 本地校验、明确确认、手动单条发送、Broker Receipt、发送记录 | 自动消费验证、批量灌入、自动无限重试 |

### 3.2 必要的配套功能

连接管理、环境标识、Schema 查看、只读 Policy 查看、分区下钻、刷新/暂停、状态快照、错误诊断、脱敏导出、键盘操作和本地 Payload 模板。

这些能力围绕五个主功能组织，不需要把首页做成几十个菜单。

### 3.3 建议导航

```text
Connections

QAT / UAT Connection
├── Overview
├── Topics
│   └── Topic Detail
│       ├── Overview
│       ├── Subscriptions
│       ├── Consumers
│       ├── Producers
│       ├── Partitions
│       ├── Schema
│       └── Policies（只读）
├── Subscriptions & Backlog（跨 Topic 索引）
├── Consumers（跨 Topic 索引）
├── Producers（跨 Topic 索引）
└── Send Message

Local
├── Templates
├── Send History
└── Settings
```

全局 Consumers、Producers、Subscriptions 页面复用 Topic 快照，不独立启动另一轮相同请求。

---

<a id="section-04"></a>

## 4. 示例界面与交互规则

### 4.1 视觉方向

界面以清楚、实用为先。企鹅元素只作为 Logo、小型空状态或轻量引导，不占据数据区域。不要把架构说明、几十个 KPI 和发送表单挤在同一张页面上。

采用清楚的表头、行分隔线、可调整列宽和等宽数字。JSON 编辑器支持缩进、语法配色、错误位置、复制与本地格式化。

环境名称始终显示在顶部；发送区域再次显示完整环境和完整 Topic，不能只依赖颜色区分 QAT/UAT。

### 4.2 Topics 页面示例

以下均为模拟数据。

```text
🐧 Penguin Pulsar                  [QAT ▾]   Observe   [刷新] [暂停]
Scope: demo-team/notifier          已加载 2/2 Topics   16:10:00

[搜索 Topic.....................] [Namespace ▾] [仅显示有积压]

Topic                Partitions   Producer实例   Consumer实例   最大订阅积压
player-event         4            2              2              128
notification-test    非分区       0              0              0

点选 Topic 查看详细状态。发送功能通过右上角「Send Message」单独打开。
```

“最大订阅积压”必须带 Tooltip，解释它不是 Topic 唯一消息数量。

### 4.3 Topic Detail 页面示例

```text
QAT · persistent://demo-team/notifier/player-event
[Overview] [Subscriptions] [Consumers] [Producers] [Partitions] [Schema]

[查看状态]                                     [Send Message]
更新时间：16:10:00    数据：完整    自动刷新：10 秒

Publish In     Dispatch Out     Producer实例    Consumer实例
12.0 msg/s     20.0 msg/s        2              2

Subscriptions
名称          类型      Consumer实例   Backlog   Unacked   Dispatch Out
notifier      Shared    2              0         4         20.0 msg/s
analytics     Shared    0              128       0          0.0 msg/s

提示：analytics 当前无在线 Consumer，且观察到积压。
      这是状态提示，不代表已判断根因。
```

Overview 的出站速率是投递指标，不命名为“业务处理成功速度”。 [S09]

### 4.4 发送抽屉示例

```text
Send Message

环境：QAT
Topic：persistent://demo-team/notifier/notification-test
模式：手动发送 1 条
编码：Raw UTF-8（内容为 JSON 文本）

Key（可选）：test-player-123
Properties（可选）：panel.request_id = <生成的请求ID>

Payload
{
  "playerId": "TEST-123",
  "eventType": "TEST_NOTIFICATION",
  "message": "Hello from Penguin Pulsar Panel"
}

[本地校验] [保存模板]                         [检查并确认发送]

注意：这是真实发送。下游服务可能执行实际业务逻辑。
```

默认不自动添加业务字段，不擅自把 `playerId` 从字符串改成数字。格式化、转换或加 Properties 必须可见且可预览。

### 4.5 状态与空页面

| 状态 | 页面行为 |
|---|---|
| Loading | 显示骨架，不先显示假的 0 |
| Empty | 请求成功且结果为空，才显示“暂无资源” |
| Forbidden | 显示无权限与受影响的功能，不显示“没有 Topic” |
| Partial | 标明成功/失败的 Topic 或分区数量 |
| Stale | 保留最后成功数据，显示时间及过期标识 |
| Unsupported | 显示目标版本或当前 SDK 不支持，不伪装成服务异常 |
| Paused | 清楚显示已暂停；数值不是实时更新 |
| Unknown | 无法确认的字段用“未知”，不当成 0 |

### 4.6 键盘与易用性

支持 `Cmd/Ctrl+K` 搜索命令、`/` 聚焦 Topic 搜索、`Esc` 关闭抽屉、复制完整 Topic、收藏 Topic、保存筛选条件。

发送快捷键最多打开确认流程，不能跳过确认直接发布。环境切换后，打开的发送确认必须作废。

---

<a id="section-05"></a>

## 5. 连接管理与 SASE 网络诊断

### 5.1 两种地址必须分别配置

| 字段 | 用途 | 示例 |
|---|---|---|
| Admin Service URL | HTTP(S) 管理查询入口 | `https://pulsar-admin.example.internal` |
| Broker Service URL | Producer 使用的 Pulsar 协议入口 | `pulsar+ssl://pulsar-broker.example.internal:6651` |

不能从 `pulsar+ssl://...:6651` 推断管理入口，也不能假设把端口改成 `8080` 就一定能用。Admin 与 Producer 入口、认证和可达性需要各自验证。Pulsar 管理接口与客户端协议是不同访问通道。 [S01][S04]

### 5.2 连接配置建议

```json
{
  "id": "qat-notifier",
  "name": "QAT Notifier",
  "environment": "QAT",
  "adminServiceUrl": "https://pulsar-admin.example.internal",
  "adminBasePath": "/admin/v2",
  "brokerServiceUrl": "pulsar+ssl://pulsar-broker.example.internal:6651",
  "adminCredentialRef": "secret://pulsar/qat/observe",
  "producerCredentialRef": "secret://pulsar/qat/produce",
  "allowedNamespaces": ["demo-team/notifier"],
  "allowedProduceTopics": [
    "persistent://demo-team/notifier/notification-test"
  ],
  "observeEnabled": true,
  "produceEnabled": false,
  "tlsVerifyPeer": true,
  "tlsVerifyHostname": true,
  "pollIntervalSeconds": 10,
  "requestTimeoutMs": 8000,
  "maxConcurrentAdminRequests": 4
}
```

这些是本产品拟定的配置项，不是 Pulsar 官方配置文件格式。`produceEnabled=false` 是首次导入配置的安全默认值；用户或管理员在确认权限与 Topic 范围后开启。

真实 Secret 存储在安全凭据存储中，配置文件只保存引用，不保存 Token 明文。

### 5.3 地址标准化

连接表单允许用户粘贴根地址或以 `/admin/v2` 结尾的地址。保存前统一拆分为 `adminServiceUrl` 与 `adminBasePath`，避免生成 `/admin/v2/admin/v2/...`。

网关存在自定义前缀时保留显式配置，不擅自去除。禁止 URL 中夹带用户名、密码或 Token 查询参数。

### 5.4 被动连接诊断

```text
1. 校验 URL、环境、证书配置与授权范围
2. 检查 DNS 与 TLS 握手
3. 查询一个已授权的 Namespace / 已知 Topic
4. 分别报告 Admin 可达性与读取权限
5. Producer 通道仅检查可执行的被动网络条件
6. 未实际发送前，不宣称“Producer 发送已验证”
```

无法列出所有 Tenants 不应阻断应用。允许预先配置已授权 Namespace 或完整 Topic，直接进入被授权范围。

### 5.5 SASE 相关要求

诊断必须从**真正执行请求的位置**发生：桌面运行时从桌面检查；部署在服务器的执行层从服务器检查。

分别显示 DNS、TLS、Admin HTTP、认证、资源权限、Producer 入口与后续 Broker 路由问题。Pulsar 客户端可能还需连接 Topic 所在 Broker；入口可达并不自动证明完整发布路径可用。 [S04]

不建议用户关闭 SASE 或关闭 TLS 验证。网络放行、代理路径、证书链和授权入口交由公司认可的方式处理。

---

<a id="section-06"></a>

## 6. Topics 与 Topic Detail

### 6.1 Topics 列表

| 字段 | 设计要求 |
|---|---|
| 环境与连接 | 每行归属于确定的 Connection，不混合缓存 |
| Topic 完整名称 | 支持复制；截断只影响显示，不能影响确认流程 |
| Tenant / Namespace | 可筛选；授权范围以完整资源匹配 |
| Domain | 区分 `persistent` / `non-persistent` |
| 分区状态 | 非分区 / 分区数 / 未知，不能只显示模糊数字 |
| Producer 实例数 | 统计 Producer 实例，不叫“服务数量” |
| Consumer 实例数 | 统计 Consumer 实例，不叫“业务服务数量” |
| Subscription 数 | 明确逻辑 Topic 层去重口径 |
| Backlog 指标 | 默认显示最大订阅积压；可切换订阅积压合计 |
| 流量 | 发布速率、投递速率和采集时间 |
| 数据状态 | Fresh / Stale / Partial / Forbidden |

### 6.2 列表加载策略

先取资源名称，再逐步加载当前可见范围的统计。不要为了显示第一页就扫描整个集群全部 Topic、全部分区、全部 Consumer。

服务端不提供所需分页时，由应用明确实现客户端分页；不能把客户端页码当成不存在的 Pulsar 分页参数。

### 6.3 分区 Topic 归一化

例如服务端同时返回：

```text
persistent://demo-team/notifier/player-event
persistent://demo-team/notifier/player-event-partition-0
persistent://demo-team/notifier/player-event-partition-1
```

默认列表只显示逻辑 Topic，分区在下钻页面显示。

必须结合分区元数据识别父子关系，不能仅靠字符串正则就把所有带 `-partition-` 的名称强行合并。

`partitions = 0` 不单独作为 Topic 存在的证据；存在性应由已授权列表、统计读取及明确错误共同确认。

### 6.4 Topic Detail 数据

以下字段来源于 Topic Stats 模型；不同版本、请求参数和 Topic 类型可能缺失。 [S09]

| UI 名称 | 原始字段 / 来源 | 单位或展示 |
|---|---|---|
| Publish In | `msgRateIn` | msg/s |
| Dispatch Out | `msgRateOut` | msg/s |
| Throughput In | `msgThroughputIn` | B/s，UI 可转换 KiB/s |
| Throughput Out | `msgThroughputOut` | B/s |
| Average Message Size | `averageMsgSize` | B |
| Storage Size | `storageSize` | B |
| Backlog Size | `backlogSize` | B；估算与范围标明 |
| Published Counter | `msgInCounter` | Broker 报告的累计值 |
| Dispatched Counter | `msgOutCounter` | Broker 报告的累计值 |
| Owner Broker | `ownerBroker` | 可用时显示 |
| Producers | `publishers` | 现有 Producer 实例集合 |
| Subscriptions | `subscriptions` | 现有订阅集合 |

不提供从 Topic Detail 直接删除、重置、跳过或修改的入口。

---

<a id="section-07"></a>

## 7. Subscriptions & Backlog

### 7.1 页面目标

回答“哪个订阅积压了、有没有 Consumer、数据是否正在投递、有无未 ACK 或重投递信号”，而不是代替业务日志判断代码根因。

### 7.2 显示字段

字段定义参考官方 SubscriptionStats 模型。 [S10]

| UI 字段 | 原始来源 | 展示要求 |
|---|---|---|
| Subscription 名称 | `subscriptions` 的 Key | 原样保留，视为不透明名称 |
| 类型 | `type` | 原始枚举与说明 |
| Durable | `durable` | Yes / No / Unknown |
| Consumer 实例数 | `consumers` | 未请求详情时不能把空数组当 0 |
| Backlog | `msgBacklog` | Broker 报告的积压计数；标注估算/版本口径 |
| Unacked | `unackedMessages` | 不自动加到 Backlog 上 |
| Dispatch Rate | `msgRateOut` | msg/s |
| Redelivery Rate | `msgRateRedeliver` | msg/s |
| Delayed | `msgDelayed` | 可用时显示 |
| Blocked | `blockedSubscriptionOnUnackedMsgs` | Yes / No / Unknown |
| Last ACK | `lastAckedTimestamp` | 时间与“多久前”；零值不显示为 1970 |
| Active Consumer | `activeConsumerName` | 仅在适用类型中解释 |
| Backlog Bytes | `backlogSize` | 按需查询，不放入默认高频刷新 |

### 7.3 统计解释

`Unacked` 指已经投递但尚未 ACK 的消息相关计数；它的意义受订阅类型和 ACK 跟踪方式影响。不可把它与 Backlog 无条件相加作为“总待处理消息”。 [S02][S10]

`msgBacklog` 应视为 Broker 报告的队列统计值，批量消息、估算选项和目标版本可能影响与业务事件条数的对应关系。需要精确业务事件计数时，不把默认统计值包装成绝对精确值。

### 7.4 诊断提示规则

以下阈值是产品默认建议，可按环境调整，不是 Pulsar 的官方健康标准。

| 观察组合 | 提示 | 不能直接得出的结论 |
|---|---|---|
| Backlog > 0，在线 Consumer = 0 | 存在积压，当前没有在线 Consumer | 不知道服务是否故意停用 |
| 连续多个采样积压增长 | 消费进度可能落后于进入速度 | 不一定是 Consumer 代码慢 |
| Unacked 持续较高 | 检查处理时长、ACK、连接或重投递 | 不能确认消息永久丢失 |
| `blocked... = true` | Broker 报告未 ACK 阈值阻塞 | 不等于查明应用根因 |
| 重投递速率持续非零 | 存在重复投递，应结合日志确认原因 | 不一定是面板重复发送 |
| 部分 Partition 数据失败 | 当前结论仅覆盖成功分区 | 不能说整个 Topic 正常 |

### 7.5 不做的“自动修复”

不得为了消除红色告警而自动清积压、删除订阅、重置 Cursor、ACK、跳过消息或创建新 Consumer。

允许复制诊断摘要或导出脱敏统计，让开发者与 SRE 在既有流程中处理。

---

<a id="section-08"></a>

## 8. Consumers 与 Producers

### 8.1 Consumers：看谁在消费，不是自己消费

Consumer 信息来自已有 Subscription 的统计数据，不需要面板创建 Consumer。字段依据官方 ConsumerStats 模型。 [S12]

| 字段 | 内容 |
|---|---|
| Topic / Partition | 实例归属 |
| Subscription | 实例所在订阅 |
| Consumer Name | `consumerName` |
| Address | `address`，可能是代理可见地址 |
| Connected Since | `connectedSince` |
| Client Version | `clientVersion` |
| Dispatch Rate | `msgRateOut` |
| Throughput Out | `msgThroughputOut` |
| Unacked | `unackedMessages` |
| Redelivery Rate | `msgRateRedeliver` |
| Available Permits | `availablePermits`，高级详情 |
| Blocked | `blockedConsumerOnUnackedMsgs` |
| Metadata | 有权限且返回时显示；默认脱敏敏感内容 |

不要仅根据 Consumer 名称或 IP 自动声称“这是 notification-service”。可以增加人工标签或应用主动提供的 Metadata 映射，并标注来源。

### 8.2 Producers：看谁在发送

Producer 字段依据官方 PublisherStats 模型。 [S11]

| 字段 | 内容 |
|---|---|
| Topic / Partition | 实例归属 |
| Producer Name | `producerName` |
| Producer ID | `producerId` |
| Address | `address` |
| Connected Since | `connectedSince` |
| Client Version | `clientVersion` |
| Access Mode | `accessMode` |
| Publish Rate | `msgRateIn` |
| Throughput In | `msgThroughputIn` |
| Average Message Size | `averageMsgSize` |
| Metadata | 显示经脱敏的键值信息 |

面板发送时创建的 Producer 可以被标记为“本面板会话”，便于识别，不隐藏它对 Producer 数量的影响。

### 8.3 实例、服务和网络连接不能混为一谈

一个业务服务可能创建多个 Producer/Consumer；分区 Topic 下也可能存在多个实例。UI 默认显示“实例数”。

不使用地址字段简单去重后称为“独立连接数”，也不把 Producer 实例数当作运行中的服务数。

实例标识要包含连接、完整物理 Topic、订阅（Consumer）、名称/ID 等上下文，不能只拿名称作为全局唯一 Key。

---

<a id="section-09"></a>

## 9. 指标、分区与统计口径

### 9.1 必须显示统计范围

每张卡片与表格都关联：Connection、Namespace 范围、逻辑/物理 Topic 层级、成功采集数量、最近采集时间、数据是否完整。

只加载 20 个 Topic 时，标题应为“当前已加载范围”，不能显示成“整个 Cluster 总计”。

### 9.2 Backlog 汇总规则

假设同一 Topic 中同一条消息被两个不同 Subscription 等待处理：两个 Subscription 的积压都可能包含它。

因此设计两个不同指标：

```text
最大订阅积压 = max(当前 Topic 各订阅的积压计数)
订阅积压合计 = sum(当前 Topic 各订阅的积压计数)
```

前者适合突出最落后的订阅，后者表示订阅维度的待处理量。**两者都不直接等于 Topic 中唯一消息的数量。** 这由独立订阅各自维护消费进度的机制推得。 [S01][S03]

跨分区汇总时，先按同名 Subscription 汇总物理分区，再计算逻辑 Topic 指标。父 Topic 聚合值与其子分区值不得重复相加。

### 9.3 Rate 不等于“瞬间实时值”

官方管理命令文档将常见 Stats Rate 描述为上一完整一分钟窗口的速率。具体展示应尊重目标版本与配置，不能因为页面每 10 秒刷新，就声称数值是最近 10 秒的即时速率。 [S13]

UI 同时显示：

```text
采集时间：16:10:00
速率口径：Broker 统计窗口
页面刷新：10 秒
```

不要根据“发送后一秒 msgRateIn 没变化”判定发送失败。

### 9.4 Out 大于 In 不一定异常

多个独立 Subscription、重投递、处理旧积压及复制等情况都可能影响出站指标。Topic 的投递与入站统计也存在复制流量等口径。 [S02]

产品规则：禁止以 `msgRateOut > msgRateIn` 单独触发故障结论；禁止把 `msgRateOut` 直接标成“成功处理数”。

### 9.5 分区汇总

| 数据 | 汇总要求 |
|---|---|
| Rate / Throughput | 同一采集周期、同一层级求和；标明非原子快照 |
| Producer / Consumer | 统计物理实例；展示逻辑聚合时说明口径 |
| Subscription 数 | 逻辑 Topic 内按名称去重，不把每个分区同名订阅重复计数 |
| Backlog | 按 Subscription 与分区分组计算，禁止父子重复累加 |
| Average Message Size | 没有可靠权重时不做简单平均，优先使用 Broker 汇总值 |
| Storage / Backlog Bytes | 不把逻辑存储直接当成包含所有复制副本的集群磁盘占用 |
| 部分分区失败 | 标为 Partial；成功分区之和不得当成完整总计 |

`perPartition=false` 主要减少返回细节，并不保证服务端不进行分区汇总；调用次数少也不等于 Broker 工作量为零。

### 9.6 时间序列规则

当前 Admin Stats 是快照来源，不把它伪装成自带完整历史查询的数据平台。长时间历史可由面板自己采样保存，或对接已授权的监控存储。Pulsar 另有 Prometheus 指标能力，但该数据源与 Admin 快照应分开标注。 [S17]

默认仅保留当前已打开/收藏 Topic 的短时曲线。采集中断应显示缺口，不补 0，也不插值伪造流量。

累计 Counter 下降时，应记录“计数基线重置/观察对象变化”，不绘制负吞吐量。Broker 重启或 Topic 卸载可能重置部分统计计数。 [S02]

---

<a id="section-10"></a>

## 10. Schema 与只读 Policies

### 10.1 Schema 页面

提供最新 Schema、明确可取得的指定版本、类型、原始定义、Properties、版本差异与复制功能。查看 Schema 不等于上传或修改 Schema。读取接口与 Schema 格式参考官方文档。 [S07]

历史版本列表只有在目标 API 已验证支持时显示；不能假设任何版本都能无成本枚举全部历史。

### 10.2 区分编辑器内容与发送编码

| 编辑器看到的内容 | 实际含义 |
|---|---|
| JSON 文本 | 可能只是 Raw UTF-8 字节，并不自动注册 Pulsar JSON Schema |
| String | 可能表示字符串内容，也可能表示注册的 STRING Schema；UI 必须明确 |
| Avro / Protobuf | 需要正确的序列化和已有 Schema/Descriptor，不能只发 JSON 字符串冒充 |
| Base64 | 只是二进制内容的输入表示，发送时要明确解码 |

Pulsar 的 JSON Schema 定义与通常的 JSON Schema 校验标准不是同一概念；官方管理文档中部分结构化 Schema 使用 Avro 定义表示。不能拿任意 JSON Schema Validator 就宣称完成 Pulsar 编码兼容验证。 [S07]

### 10.3 Schema 自动更新风险

Producer 携带 Schema 连接时，Broker 可能根据配置注册或更新 Schema。**不调用 Schema Admin 写接口，并不自动保证 Producer 不触发 Schema 元数据变化。** [S08]

本产品要求：

- 默认优先使用目标现有 Schema 的已验证编码路径，不自动生成新版本。
- Raw UTF-8 不擅自注册为 STRING / JSON Schema。
- 不支持的类型显示 Unsupported；不能静默降级成错误的字节格式。
- 当需求包含“严格不修改 Schema”时，必须结合 Broker 策略和授权配置验证，不只依靠客户端检查。
- Schema 被修改、删除或验证依据过期时，旧的发送确认失效。

### 10.4 Policies 页面

只读展示与开发排查直接相关的 Retention、Message TTL、Backlog Quota、可用的 Schema 约束及来源。

| 项目 | UI 必须区分 |
|---|---|
| 显式 Topic Policy | 当前 Topic 自己的设置 |
| Namespace Policy | Namespace 级设置，可能被覆盖 |
| Broker 默认值 | 仅在有可靠来源时展示 |
| Effective Policy | 只有已正确解析继承关系时才称为“最终生效值” |
| 未设置 / 无权限 / 未知 | 三者分开，不默认解释成无限制 |

Retention、TTL、Backlog Quota 处理的行为不同，配额触发还可能影响 Producer 或导致积压淘汰。面板只解释已读到的配置，不替用户修改。 [S03]

---

<a id="section-11"></a>

## 11. Send Message 完整规格

### 11.1 发送能力的目标

让开发者在明确的环境和目标 Topic 上，手动发布一条结构正确的测试消息，并获取可解释的发送结果。

不是消息压测器，不是业务结果探针，也不是消费工具。

### 11.2 表单字段

| 字段 | 必需 | 行为 |
|---|---:|---|
| Connection / Environment | 是 | 从当前连接继承，确认页再次显示 |
| Topic | 是 | 从获准且已存在的 Topic 中选择；允许完整路径搜索 |
| Payload | 是 | 允许空 Payload 的协议用例须显式开启，默认防止误发 |
| Payload Encoding | 是 | 明确 Raw UTF-8、Schema 编码或二进制解码方式 |
| Message Key | 否 | 区分未设置与空字符串，不自行转换类型 |
| Properties | 否 | 字符串键值、去重检查、允许预览 |
| Event Time | 否 | 能力验证后支持，显示时间单位与时区 |
| Request ID | 是 | 面板生成；用于本地审计，不声称是 Broker 去重保证 |
| 模板 | 否 | 本地保存；使用时重新校验环境、Topic 和 Schema |

延迟发送、事务、手动 Sequence ID、指定复制目标、分区固定路由等属于协议敏感高级能力。当前表单不默认暴露；确有需求时先完成 SDK 能力验证及独立规格，不通过自由透传配置绕过安全边界。

### 11.3 本地校验

本地校验不创建 Producer，不发送数据，也不调用 Consumer。

校验内容包括：UTF-8/JSON 语法、二进制解码、Payload 大小、Properties 重复键与长度、必填字段、已知 Schema 编码、允许的 Topic 范围。

JSON 格式化应保留用户确认后的内容；对于大整数、金额、签名字段，不能因通用 JSON 解析后重序列化而改变值或签名字节。提供“保持原始字节”路径，解析仅用于展示或校验。

“本地校验通过”不等于 Broker 必然接受，也不等于业务必然成功。

### 11.4 发送前检查

```text
编辑内容
   ↓
本地语法与编码校验
   ↓
检查当前 Connection、环境、Topic Allowlist 与发送权限
   ↓
读取/验证 Topic 存在性及必要的 Schema 信息
   ↓
显示不可变发送预览
   ↓
用户明确确认
   ↓
创建 Shared Producer → 发送 1 条 → 等待 Broker Receipt
   ↓
保存结果并关闭/按短期会话策略回收 Producer
```

确认必须绑定：Connection ID、配置版本、完整 Topic、Schema/编码信息、Key、Event Time、Payload 与 Properties，以及完整发送请求的内容指纹和有效期。

确认后再改环境、Topic、内容、编码、Key、Event Time、Properties 或安全策略，都要重新确认。

### 11.5 Broker 接收与业务成功分开

Producer 的发送确认来自 Broker，不是业务 Consumer 的处理回执；等待 Broker Receipt 也不是面板对消费消息发送 ACK。客户端发送与确认的机制见官方说明。 [S04]

结果状态建议：

| 状态 | 含义 | UI 文案 |
|---|---|---|
| Draft | 尚未发送 | 草稿 |
| Validated | 本地校验通过 | 已校验，尚未发送 |
| AwaitingConfirmation | 等待用户确认 | 请确认真实发送 |
| Sending | 操作已进入发送流程 | 正在发送，请勿重复点击 |
| Accepted | 得到对应 Broker Receipt | Broker 已确认接收；业务结果未知 |
| Rejected | 得到明确拒绝 | 发送被拒绝，显示原因 |
| CancelledBeforeSend | 确认尚未进入不可撤回的发送阶段 | 已取消，未发送 |
| UnknownOutcome | 超时/中断，无法确认是否已写入 | 结果未知；可能已发送，重新发送可能重复 |

进入 SDK 队列、网络发送或重试机制后，关闭弹窗或取消等待不保证撤回消息。只有能够证明尚未交给发送流程时，才允许标为“未发送”。

### 11.6 发送结果保存什么

保存 Request ID、Connection、完整 Topic、时间、编码、Payload 长度、脱敏摘要/指纹、Producer 名称、结果类型、可用的 Message ID、错误分类。

Message ID 作为不透明字符串/结构保留完整信息；不能假设只用 `ledger:entry` 就能覆盖分区与批量场景。

默认不保存完整 Payload。用户主动开启 Payload 历史时，必须显示敏感数据提示、保留期限与删除入口。

### 11.7 不自动重复发送

面板层不对超时的发送操作自动再次调用 `send()`。SDK 自己的重连、队列和重试行为也必须列入验证，不能把“面板只调用一次”包装成端到端 Exactly Once。

Request ID、业务幂等键与 Broker 去重是不同层面的机制。单纯在 Properties 添加随机 ID 不会自动让现有 Consumer 幂等。

重发必须由用户明确点击，展示上一次 UnknownOutcome 或 Accepted 状态，并提示可能重复执行。

### 11.8 Producer Access Mode

本产品仅允许 `Shared`，并验证实际 SDK 行为。禁止 Exclusive、WaitForExclusive 与 ExclusiveWithFencing，尤其不能用会驱逐已有 Producer 的模式。若现有 Topic 已被独占，不尝试夺取控制权，只报告冲突。 [S04]

Producer 名称应可识别且避免冲突，例如：

```text
penguin-panel-<安装随机ID>-<会话随机ID>
```

不要冒用现有业务服务的 Producer 名称。

### 11.9 Topic 自动创建风险

“不提供 Create Topic 按钮”不等于“发送绝不会创建 Topic”。必须核对目标集群的自动创建配置与 SDK Lookup/Producer 行为，避免名称拼错时意外生成资源。 [S22]

发送检查要求 Topic 已存在；但存在性预检与正式发送之间仍有竞态。严格禁止自动创建，需要服务端配置或受控网关共同保证，客户端检查不能单独提供该保证。

Unknown Topic、无权确认存在性、存在性证据过期时默认阻止发送，不偷偷创建或补建分区。

### 11.10 测试隔离

推荐由管理员提前准备独立的测试 Topic / Namespace，并审核其订阅、正则订阅、复制、Functions、Sinks 与下游环境。

Topic 名字带 `test` 或 Payload 带 `test=true` 不能证明隔离。即使 QAT/UAT，也要确认不会发真实通知、写真实账户或调用生产下游。

这是本产品的发送准入规则，不要求面板自己去消费或探测下游。

### 11.11 发送默认值

| 设置 | 建议默认值 | 说明 |
|---|---|---|
| 每次操作消息数 | 1 | 不提供批量发送 |
| 每 Topic 同时发送操作 | 1 | 防双击并降低重复发布风险 |
| 应用发送速率上限 | 1 次/秒/连接，突发 1 | 产品安全默认值，不是 Pulsar 吞吐上限 |
| Payload 上限 | 256 KiB | 产品默认；实际还受目标 Broker / SDK / Schema 限制 |
| 发送等待期限 | 15 秒 | 超时可能是 UnknownOutcome，不默认当作未发送 |
| Batching | 单条调试默认关闭，须验证 SDK 设置 | 避免无意义等待与不清楚的批量结果 |
| 压缩 / Chunking | 不自动开启 | 不通过隐式转换掩盖目标限制 |
| Producer 常驻 | 默认不常驻 | 仅发送期间或短期显式会话复用，空闲回收 |
| 关闭窗口 | 停止新操作，处理在途结果并释放资源 | 不撤回已发布消息 |

---

<a id="section-12"></a>

## 12. Admin API 对接与白名单

### 12.1 API 版本原则

以下是参考路径，不是对任何托管环境的可用性保证。实际实现应取得目标版本 OpenAPI/Swagger 或由管理员确认接口清单，建立兼容性测试。

本规格优先核对官方 4.0.x 文档与 v4.0.0 实现，不因为公开网站有更新版就自动把你们环境当成同一版本。 [S01][S06]

### 12.2 核心允许的读取操作

下表路径相对于 Admin Service 根地址；`{topic}` 表示单独编码后的 Topic 本地名称，不是直接拼接整个 `persistent://...` 字符串。

| 业务用途 | HTTP | 参考路径 | 使用规则 |
|---|---|---|---|
| Tenants 列表 | GET | `/admin/v2/tenants` | 可选，缺少全局权限时不阻断 |
| Tenant 下 Namespaces | GET | `/admin/v2/namespaces/{tenant}` | 仅授权 Tenant |
| Persistent Topics | GET | `/admin/v2/persistent/{tenant}/{namespace}` | 核心列表 |
| Partitioned Topics | GET | `/admin/v2/persistent/{tenant}/{namespace}/partitioned` | 用于逻辑 Topic 归一化 |
| 分区元数据 | GET | `/admin/v2/persistent/{tenant}/{namespace}/{topic}/partitions` | 已验证版本中显式禁用自动创建检查路径 |
| 普通 Topic Stats | GET | `/admin/v2/persistent/{tenant}/{namespace}/{topic}/stats` | 主要数据来源 |
| 分区 Topic Stats | GET | `/admin/v2/persistent/{tenant}/{namespace}/{topic}/partitioned-stats` | 总览/分区视图按需调用 |
| 已有订阅名称 | GET | `/admin/v2/persistent/{tenant}/{namespace}/{topic}/subscriptions` | 已有 Stats 包含时不重复请求 |
| 最新 Schema | GET | `/admin/v2/schemas/{tenant}/{namespace}/{topic}/schema` | 编码检查与 Schema 页面 |
| 指定 Schema 版本 | GET | `/admin/v2/schemas/{tenant}/{namespace}/{topic}/schema/{version}` | 版本明确时按需读取 |
| Namespace Retention | GET | `/admin/v2/namespaces/{tenant}/{namespace}/retention` | 只读；标注配置层级 |
| Namespace TTL | GET | `/admin/v2/namespaces/{tenant}/{namespace}/messageTTL` | 只读 |
| Namespace Backlog Quota | GET | `/admin/v2/namespaces/{tenant}/{namespace}/backlogQuotaMap` | 只读 |

Topic 路径与参数核对来源：[S01][S06]。Tenant / Namespace 路径：[S15][S16]。Schema：[S07]。Retention / TTL / Quota：[S03]。

Non-persistent Topic 单独通过 `non-persistent` 路由及目标版本能力映射支持；不能机械假设所有 Persistent 订阅/存储接口都适用。暂时未验证的能力显示 Unsupported，而不是调用任意路径试探。

### 12.3 Stats 的安全参数

v4.0.0 REST 实现中，`subscriptionBacklogSize` 可能涉及 Ledger 锁，源码特别提醒高流量时谨慎。其 REST 默认值与部分 CLI 默认值并不相同，因此不能只依赖默认配置。 [S06][S13]

参考普通查询：

```http
GET /admin/v2/persistent/{tenant}/{namespace}/{topic}/stats
    ?getPreciseBacklog=false
    &subscriptionBacklogSize=false
    &getEarliestTimeInBacklog=false
    &excludePublishers=false
    &excludeConsumers=false
```

以上换行只为展示；实际请求应通过结构化 Query Builder 构建。

| 参数 | 默认策略 |
|---|---|
| `getPreciseBacklog` | false；精确读取仅手动、低频、在已验证版本中启用 |
| `subscriptionBacklogSize` | false；订阅级字节估算不进入默认轮询 |
| `getEarliestTimeInBacklog` | false；需要时按需读取 |
| `excludePublishers` | 精简视图可 true；需要实例详情时 false |
| `excludeConsumers` | 精简视图可 true；需要实例详情时 false |
| `perPartition` | 总览明确 false；分区视图才 true，仍需预算限制 |
| `checkAllowAutoCreation` | 分区元数据查询固定 false（目标版本验证后使用） |

被排除的列表不是“列表为空”。若请求不含 Consumer 明细，DTO 必须标记 `notRequested`，不能推断 Consumer 数为 0。

未知版本可能忽略不认识的 Query 参数；不能仅凭返回 200 就认定危险选项已被关闭。无法证明安全行为时，降为手动低频读取或停用该操作，并请求版本契约。

### 12.4 明确不允许的操作

所有未列入业务白名单的 Admin 请求默认拒绝，包括：Topic/Namespace/Tenant 创建删除、Policy 修改、Subscription 变更、Cursor 重置、消息跳过/过期/清理、Compaction/Offload/Unload、权限修改。

以下即使可能是 GET 也不纳入普通 Observe：主动 Broker Health Check、消息正文 Peek/Get/Examine、未审核的 Internal Stats/配置转储、任意用户填写的 Admin URL 请求。

需要高级 Internal Stats 时，另建明确的只读操作、按需调用、独立负载预算与权限审核；不默认加入首页刷新。

### 12.5 白名单必须校验的维度

```text
Operation ID
+ HTTP Method
+ 精确路由模板
+ 已授权 Tenant / Namespace / Topic
+ 允许的 Query 名称与值
+ URL 编码与规范化
+ 超时、返回体大小与并发限制
+ 允许的目标主机与重定向策略
```

不允许使用 `adminRequest(method, arbitraryUrl, body)` 之类的万能前端接口。

### 12.6 重定向与 URL 安全

Pulsar 管理访问可能涉及 Broker 重定向，必须先验证目的地再决定是否继续。禁止不受限制地跟随 307/308 并转发 Authorization。 [S06]

允许的代理/Broker 主机由连接配置或管理员提供的清单控制；拒绝 HTTPS 降级、不明域名及循环跳转。最多 3 次受控重定向是本产品默认值。

Topic 和 Subscription 名称使用结构化解析、单次编码。对于合法特殊字符不能简单破坏；对于路径穿越、二次解码与查询注入必须拒绝。包括斜线在内的特殊字符可能出现在 Topic 本地名称中，因此需遵循实际命名和编码规则。 [S01]

---

<a id="section-13"></a>

## 13. 推荐技术架构与 SDK 选型

### 13.1 建议而非已确认的技术决定

本次对话确认的是产品能力，没有指定必须用哪个 UI 框架。以下为建议实现：

**React + TypeScript UI，Rust 核心，桌面入口采用 Tauri 2；核心通过窄接口接入独立应用或现有 Penguin 产品。**

Tauri 支持前端界面与 Rust 应用逻辑结合，并提供能力权限机制。但采用 Tauri/Rust 不等于自动实现低内存；实际表现必须测量。 [S20][S21]

不要求运行本地 Pulsar Broker，不要求新增 Redis/PostgreSQL 服务，也不要求常驻后台 Daemon。业务数据仍在获准连接的远端 Pulsar；本地只保存设置、模板及有限诊断数据。

### 13.2 分层结构

```text
React UI
   │ typed commands / events
   ▼
Trusted Application Core
├── Connection Manager
├── Observe Service
│   ├── Operation Allowlist
│   ├── Admin HTTP Client
│   └── Version / Capability Adapter
├── Stats Normalizer & Aggregator
├── Polling Scheduler & Bounded Cache
├── Send Service
│   ├── Policy & Confirmation Validator
│   ├── Schema / Payload Encoder
│   └── Producer-only Adapter
├── Credential Provider
├── Local Store
└── Audit & Diagnostics
```

Observe Service 无权使用 Producer Adapter；Send Service 也不能绕过 Admin Operation Allowlist。

### 13.3 Producer SDK 决策

Rust 生态中存在 `streamnative/pulsar-rs` 这种纯 Rust 客户端，但不能把它写成“与 Apache 官方客户端所有功能完全相同”。官方客户端目录与该项目自身说明应分别核对。 [S18][S19]

建议先对候选 SDK 做独立兼容性验证：

| 必须验证 | 通过要求 |
|---|---|
| TLS、证书链、主机名验证 | 适配公司授权入口，不关闭校验 |
| Token / 实际认证机制 | 支持现有方式，能正确处理过期与刷新 |
| Proxy / Lookup / Broker 路由 | 在 SASE 环境真实可达 |
| Partitioned Topic | 元数据、路由、分区增加等行为明确 |
| Shared Producer | 不产生独占或 Fencing 行为 |
| Key / Properties | 字节与路由语义保持正确 |
| Raw / Schema 编码 | 使用的格式逐个验证 |
| Receipt / Timeout | 能区分已确认、明确拒绝和未知结果 |
| Reconnect / Retry | 已了解内部重试，不隐式重复调用 Send |
| Close / Cancellation | 应用退出时正确回收；不伪称消息已撤回 |
| No Consumer | 运行路径没有 Reader/Consumer 等隐式行为 |

Rust SDK 缺少某个关键能力时，不用错误编码或消费接口凑功能。可替换 Producer-only Adapter，或增加按需启动的受控官方客户端 Helper。Helper 必须有相同的权限、审计、内存与生命周期门禁，不能成为默认常驻隐藏服务。

### 13.4 Web 部署适配

需要浏览器版时，可复用核心，使用受控服务端执行 Admin 与 Producer 请求，例如增加 Axum HTTP 适配层。浏览器 UI 不直接持有长期 Pulsar Token。

执行层的位置决定 SASE 网络可达性；把页面部署到服务器不能自动获得用户电脑的公司内网权限。

本地 HTTP 模式必须绑定受控接口，并有会话鉴权、Origin 检查与 CSRF 防护；不能开放一个任何网页都能调用的 localhost 消息发送入口。

### 13.5 不需要的默认组件

不默认引入 Kafka、Redis、向量数据库、消息正文索引、AI Agent、全量集群爬取服务或额外 Pulsar 实例。

这些都不是当前“看状态 + 手动发消息”需求的必要依赖。

---

<a id="section-14"></a>

## 14. 内部数据模型与接口契约

### 14.1 设计原则

Pulsar 原始响应先进入版本适配层，再转换成稳定的 UI DTO。原始响应不能在每个组件里各自解析、各自计算统计。

以下 TypeScript 是拟定的接口类型，不是 Pulsar SDK 的现成 API。

```ts
type Environment = "QAT" | "UAT" | "DEV" | "PROD" | "CUSTOM";
type TopicDomain = "persistent" | "non-persistent";

type MetricQuality =
  | "fresh"
  | "stale"
  | "partial"
  | "notRequested"
  | "unsupported"
  | "forbidden"
  | "unknown";

interface Metric<T> {
  value: T | null;
  quality: MetricQuality;
  observedAt: string | null; // ISO 8601；以 UTC 保存
  reason?: string;
}

interface TopicRef {
  connectionId: string;
  domain: TopicDomain;
  tenant: string;
  namespace: string;
  localName: string;
  canonicalName: string;
}

interface SnapshotCoverage {
  scope: "topic" | "namespace" | "loaded-topics";
  expectedPhysicalTopics: number | null;
  sampledPhysicalTopics: number;
  failedPhysicalTopics: number;
  complete: boolean;
}

interface TopicOverview {
  topic: TopicRef;
  partitionCount: Metric<number>; // 0 仅表示已确认的非分区元数据语义
  publishRate: Metric<number>;
  dispatchRate: Metric<number>;
  throughputInBytes: Metric<number>;
  throughputOutBytes: Metric<number>;
  producerInstances: Metric<number>;
  consumerInstances: Metric<number>;
  logicalSubscriptions: Metric<number>;
  maxSubscriptionBacklog: Metric<string>;
  sumSubscriptionBacklog: Metric<string>;
  storageBytes: Metric<string>;
  coverage: SnapshotCoverage;
}
```

64-bit Counter、Ledger ID、大尺寸字节量等通过十进制字符串或无损结构传给前端；在可信层解析原始整数，避免先转成 JavaScript Number 再“转回字符串”造成精度丢失。

对缺失值、被参数排除的值、权限拒绝和真实 0 明确区分。速率仅接受有限数值；NaN / Infinity 不进入图表。

### 14.2 发送契约

```ts
interface PrepareSendInput {
  topic: TopicRef;
  encodingId: string;
  payloadBase64: string; // 候选发送字节的 Base64；可信层仍须校验编码与内容
  key?: string;
  properties: Record<string, string>;
  eventTimeUnixMs?: string;
}

interface PreparedSend {
  requestId: string;
  confirmationToken: string; // 由可信层生成，绑定不可变操作与短有效期
  environment: Environment;
  canonicalTopic: string;
  payloadBytes: number;
  contentFingerprint: string;
  warnings: string[];
  expiresAt: string;
}

type SendOutcome =
  | { status: "accepted"; messageId: string; acceptedAt: string }
  | { status: "rejected"; code: string; message: string }
  | { status: "cancelledBeforeSend" }
  | { status: "unknownOutcome"; code: string; message: string };
```

最终线上字节必须在可信层确定并冻结；预览长度与内容指纹基于实际将发送的字节和完整元数据，不能在用户确认后再悄悄格式化或更换序列化方式。

`confirmationToken` 不是客户端随便写一个 `confirmed: true`。可信层检查令牌属于当前用户/会话、内容未变、权限未变、未过期且没有重复使用。

### 14.3 窄接口清单

| 方法 | 类型 | 契约 |
|---|---|---|
| `connections.list` | 本地读 | 不返回 Secret |
| `connections.save` | 本地配置写 | 校验地址、范围与安全策略 |
| `connections.testObserve` | 远端被动读 | 不创建 Producer / Consumer |
| `topics.list` | 远端读 | 限定 Namespace |
| `topics.snapshot` | 远端读 | 受预算控制的 Stats |
| `topics.partitions` | 远端读 | 元数据/分区快照，区分两者 |
| `schemas.read` | 远端读 | 不上传、不注册 |
| `policies.read` | 远端读 | 明确层级与完整性 |
| `observe.pause` | 本地控制 | 取消刷新任务 |
| `send.validateLocal` | 本地计算 | 零 Broker 写入 |
| `send.prepare` | 本地 + 允许的读 | 生成不可变发送预览，不创建 Producer |
| `send.execute` | Producer 写 | 唯一发布入口 |
| `history.list` | 本地读 | 默认无 Payload 正文 |
| `diagnostics.export` | 本地写文件 | 必须脱敏 |

### 14.4 本地存储

可使用 SQLite 保存非敏感元数据，表结构建议如下：

| 表 | 关键内容 |
|---|---|
| `connections` | 地址、环境、授权范围、Secret 引用、配置版本 |
| `favorites` | Connection + 完整 Topic、排序、用户标签 |
| `payload_templates` | 模板内容与编码；保存前提示敏感数据 |
| `send_history` | Request ID、目标、长度、结果、Message ID、可选指纹 |
| `metric_samples` | 有上限的短期数值快照；默认不存 Consumer 正文 |
| `audit_events` | 授权判断、操作类型、时间、错误分类、脱敏诊断 |

所有关联都包含 Connection ID，避免把 QAT 的数据、Schema 或模板自动当成 UAT 的同名资源使用。

---

<a id="section-15"></a>

## 15. 刷新、缓存、历史与资源预算

### 15.1 目标

让面板保持快速、清楚和低开销，同时避免为了“看状态”持续给共享 Pulsar 施加不必要负载。

下列数字全部是**建议默认值与待验证的质量目标，不是实测承诺，也不是 Pulsar 官方限制**。

### 15.2 请求调度

| 场景 | 建议默认行为 |
|---|---|
| 当前打开的 Topic Detail | 每 10 秒刷新一次 |
| Topics 名称列表 | 每 60 秒刷新，或用户手动刷新 |
| 当前列表行的摘要 | 当前页按需加载；相同请求合并 |
| 未打开且未收藏的 Topic | 不持续采样 |
| Schema / Policies | 打开页面时加载，5 分钟缓存，可手动刷新 |
| 窗口隐藏 / 应用进入后台 | 默认暂停非必要轮询 |
| 设备睡眠 / 网络离线 | 取消在途读请求并暂停；唤醒后重新验证会话 |
| 分区明细 | 仅打开 Partitions 页时按需拉取 |
| 精确 Backlog / 订阅 Backlog Bytes | 默认手动读取，不进入常规轮询 |
| 401 / 403 | 停止对应无效请求链，不反复重试 |
| 429 / 503 | 指数退避、抖动与熔断提示 |

每连接默认最多 4 个并行 Admin 请求；多个窗口共用同一调度器，不为每个窗口创建一套重复轮询。

一轮请求尚未完成时，不无限叠加下一轮。优先处理用户正在看的页面，淘汰过时的排队请求。

### 15.3 读重试与写重试分开

获准的幂等查询，可对短暂网络错误做有限重试，默认最多 2 次，且计入整体 Deadline。

发送消息不套用这套读请求重试中间件。`send.execute` 超时后的状态由发送结果模型处理，不能被通用 HTTP/IPC 重试逻辑再次执行。

### 15.4 缓存设计

缓存 Key 至少包含：Connection ID、凭据/权限版本、完整 Topic、Operation ID、查询参数与聚合范围。

| 缓存 | 建议上限 |
|---|---|
| 正规化 Stats 数据 | 32 MiB，LRU 淘汰 |
| 原始响应调试缓存 | 16 MiB，总量封顶，不长久保留 |
| 短期图表采样 | 16 MiB，总量封顶 |
| 单次 Admin 解压后响应 | 默认 8 MiB，超限显示明确错误 |
| 本地 Metrics 数据 | 默认 250 MiB，自动按保留规则清理 |
| 本地诊断日志 | 默认 50 MiB，轮转 |

响应大小限制必须同时考虑压缩前后，防止超大 JSON 或解压膨胀耗尽内存。触及上限时不能悄悄截断后显示“完整”。

### 15.5 历史采样

默认图表保留最近 15 分钟。在 10 秒采样周期下，每条曲线约 90 个点；用户启用更长历史时，采用分层采样与有上限的磁盘保存。

只保存业务上需要的指标，不无限保存完整 Producer/Consumer 快照，也不索引消息正文。

重启应用后，历史数据明确标为 Historical；不能与新采样拼接成看似连续、实际上缺失的实时数据。

### 15.6 UI 性能

Topic 列表使用虚拟滚动；仅在打开详情时渲染大 JSON；编辑器、图表与高级模块按需加载。

避免同一份 Stats 在 React 状态、表格状态、图表状态、日志状态中复制多份大型对象。可见组件只订阅需要的数据切片。

搜索输入防抖；保留完整 Topic 搜索能力。长列表排序在工作线程或可信层完成，不能阻塞输入。

### 15.7 可验证的性能目标

参考测试条件：Apple Silicon、24 GB RAM、Release 构建、一个连接、1,000 个模拟 Topic 名称、最多 50 个当前缓存的详细 Topic 快照。网络性能另以受控延迟测试。

| 项目 | 初始验收目标 |
|---|---|
| 冷启动至可交互 | p95 ≤ 2 秒，不包括远端登录/查询等待 |
| 已缓存页面切换 | p95 ≤ 150 ms |
| 已缓存 Topic 搜索 | p95 ≤ 100 ms |
| 无网络等待的主线程长任务 | 常规交互不持续出现 > 50 ms 长任务 |
| 空闲内存 | 整个应用进程组目标 ≤ 250 MiB |
| 上述参考负载活跃内存 | 整个应用进程组目标 ≤ 450 MiB |
| 空闲 CPU | 平均接近 0，参考目标低于单核 1% |
| 8 小时连续运行 | 不存在持续无界增长；记录堆、缓存、连接及任务数量 |
| 应用退出 | 网络任务与 Helper 在受控时间内退出，无常驻遗留进程 |

测量包含 Native 主进程、WebView 相关进程和实际启动的 Helper；报告测量方式，注意共享内存统计的重复计算。达不到目标时提交剖析结果与改进方案，不用“Tauri 本来就省 RAM”替代测试证据。

---

<a id="section-16"></a>

## 16. 安全、权限与审计

### 16.1 权限分离

建议分别配置 Observe 凭据与 Produce 凭据。前者只能调用批准的读取能力，后者仅获准向指定 Topic 发布。

Pulsar 的认证身份、租户管理与资源授权需要结合实际部署配置；不能假设一定存在一个标准角色名叫 `read-only-admin`，也不能假设原有 Producer Token 必然可读全部 Admin API。 [S14]

客户端白名单限制的是本应用行为，不会让一个本来拥有超级权限的 Token 变成真正的低权限 Token。部署侧应使用最小权限、网关约束或经过审核的授权提供器。

### 16.2 环境隔离

QAT、UAT 和其他环境分别保存地址、凭据、发送范围、Schema 缓存与模板绑定。

默认不自动从 QAT 切换到 UAT 后直接发同一份草稿。切换环境要使 Prepared Send 失效，并重新校验。

如添加生产连接，建议默认只读、独立醒目标识，且本规格不为其默认开启发送权限。

### 16.3 Secret 保护

Token 不放 URL、不写前端 Local Storage、不进入通用日志、不进入错误截图、不放导出文件、不提交到 Git。

桌面版通过系统安全凭据机制保存；Web 版由服务器侧 Secret 管理机制保存。只把凭据引用和脱敏状态提供给 UI。

截图中出现过的认证令牌不应继续复制到示例或文档；建议按团队流程评估换发/吊销与传播范围。不要把 Token 粘贴到公开的 JWT 调试网站。

### 16.4 可信执行层的权限

仅注册明确的 IPC/HTTP Command。窗口能力采用最小授权，不把文件系统、Shell、网络通配访问全部交给 UI。Tauri 的 Capability 机制可用于控制暴露给前端的能力范围。 [S21]

所有来自服务端的名称、Schema、Metadata 和错误文本按不可信文本渲染，防止 HTML/Markdown 注入。模板只作为数据，不执行内嵌脚本。

### 16.5 审计事件

| 字段 | 要求 |
|---|---|
| 操作 ID / Request ID | 能关联用户操作、远端请求和发送结果 |
| 操作类型 | Observe / Prepare / Produce / LocalConfig 等 |
| 用户/会话标识 | 根据部署模式记录，避免不必要的个人信息 |
| Connection / Environment | 必须明确 |
| 资源 | 完整 Topic 或 Namespace，支持脱敏导出 |
| 开始/结束时间 | 使用统一时间格式 |
| 权限判定 | Allowed / Denied 与规则编号 |
| 结果 | Accepted / Rejected / UnknownOutcome 等 |
| 性能 | 耗时、响应大小、重试次数、分区覆盖率 |
| 敏感数据 | 默认不含 Token 和 Payload 正文 |

### 16.6 导出与分享

支持导出一个 Topic 的脱敏诊断 Markdown/JSON，内容包括统计范围、时间、积压、实例数量、错误与版本信息。

导出前提供预览，默认遮蔽内部地址、敏感 Metadata 和 Payload。原始诊断导出须有额外确认，不因为“给同事看”就默认包含 Token。

CSV 导出还要处理公式注入；任何以公式符号开头的远端名称都应按安全文本导出。

---

<a id="section-17"></a>

## 17. 错误处理与可诊断性

### 17.1 统一错误模型

```ts
interface PanelError {
  code: string;
  category:
    | "network"
    | "tls"
    | "authentication"
    | "authorization"
    | "notFound"
    | "unsupported"
    | "rateLimited"
    | "payload"
    | "schema"
    | "producerConflict"
    | "unknownSendOutcome"
    | "internal";
  operationId: string;
  requestId: string;
  message: string;
  retryableRead: boolean;
  mayHavePublished: boolean;
  detailsRedacted?: Record<string, string>;
}
```

错误码必须来自可信层分类，不能让 UI 仅凭文案里出现 `timeout` 就决定自动重发。

### 17.2 常见情况

| 情况 | 展示与处理 |
|---|---|
| DNS 失败 | 指明失败的是 Admin 域名还是 Broker 域名 |
| TLS 失败 | 提示证书链、主机名或授权 CA，不建议关闭验证 |
| 401 | 凭据无效/过期等认证问题；停止风暴式重试 |
| 403 | 对该操作/资源无权访问；其他已授权功能继续可用 |
| 404 | 区分资源不存在、入口路径错误、版本/代理差异，不能一律解释为 Topic 不存在 |
| 307/308 | 由受控路由策略处理，拒绝不受信任目标 |
| 429 | 降速、退避、展示限流状态 |
| 5xx | 保留可用旧快照并标 Stale；有限重试读操作 |
| 部分分区失败 | 显示具体失败分区和覆盖范围 |
| Schema 不兼容 | 阻止发送，显示预期编码与原因；不自动注册新 Schema |
| Producer 独占冲突 | 报告冲突，不 Fencing、不强制替换 |
| Send 超时/中断 | 可能是 UnknownOutcome；不自动重发 |
| 大响应/大 Payload | 显示明确的应用或远端限制，不静默截断 |
| 应用退出中仍有在途发送 | 显示结果未确定；下次启动保留未决记录，不自动恢复发送 |

### 17.3 不夸大“自动诊断”

可以给出“观察到积压增长且当前无在线 Consumer”这样的证据摘要。

不能仅凭状态指标给出“就是数据库慢”“一定是 SASE”“已经确认代码 Bug”“业务都成功了”等结论。

---

<a id="section-18"></a>

## 18. 常用开发排查流程

### 18.1 我想知道谁在消费这个 Topic

搜索完整 Topic → 打开 Subscriptions → 查看现有 Consumer 实例、分区和名称 → 需要时展开地址与 Metadata。

此流程只读取状态，不进入 Send Service，更不会建立 Consumer。

### 18.2 我发了一条消息，但应用看起来没反应

先看面板发送结果：Accepted、Rejected 还是 UnknownOutcome。

Accepted 时确认环境和完整 Topic；再看正确的 Subscription 是否存在、Consumer 是否在线、积压与未 ACK 信号。最后用 Request ID 或业务标识对照现有应用日志。

不能为了证明业务成功而自动订阅 Topic，也不能因为指标暂未变化就自动重复发送。

### 18.3 我想排查某个 Topic 积压

查看采集时间与完整性 → 按 Subscription 找积压 → 展开 Partition 分布 → 查看 Consumer 在线状态、阻塞及重投递 → 导出脱敏摘要。

整个流程没有修改 Cursor 或清除积压。

### 18.4 我想验证 Payload 格式

读取已有 Schema → 选择实际发送编码 → 本地校验 → 使用经批准的测试 Topic 手动发送 → 查看 Broker Receipt。

Schema 不支持或下游测试边界不清楚时，不自动换成另一种编码“试试看”。

### 18.5 我只有原本 Backend 使用的 Broker URL 和 Token

先申请 Admin Service URL、允许查询的资源范围，以及读取接口权限。Broker URL 与 Token 不足以证明 Admin 入口可访问或有权使用。

面板连接页可以先保存不完整配置，标明“Admin 入口待补充”，不需要因此引入本地 Consumer。

---

<a id="section-19"></a>

## 19. 完整测试体系与测试用例

### 19.1 测试层次

| 层次 | 验证内容 |
|---|---|
| 单元测试 | 名称解析、路径编码、字段标准化、聚合、状态机、权限规则 |
| 属性/模糊测试 | 特殊字符、整数边界、超大/畸形 JSON、无效 Payload、参数注入 |
| 契约测试 | 目标版本 API 响应、参数、状态码、字段缺失、权限限制 |
| 集成测试 | 真实隔离 Pulsar 的 Admin 查询与 Producer 发送 |
| 安全测试 | 无 Consumer、副作用白名单、凭据保护、重定向、模板/导出注入 |
| UI/E2E | 核心排查与发送流程、键盘、环境切换、确认失效 |
| 故障测试 | 断网、重连、Token 过期、Broker 重启、响应丢失、进程崩溃 |
| 性能测试 | 内存、CPU、请求量、分区扩展、长时间运行与资源回收 |
| 发布回归 | 每个声明支持的 Broker/SDK/系统组合，保留报告 |

所有写入、故障注入和压测只在专门授权的隔离测试环境进行，不默认对共享 QAT/UAT 跑破坏性测试。

### 19.2 测试夹具与面板角色分离

测试 Harness 可以预先创建 Topic、Subscription 和一个模拟的“现有业务 Consumer”，用来验证面板发送的消息确实被原有消费路径处理。

这些 Consumer 属于**独立测试夹具**，不属于产品运行时代码；不能打包进应用，也不能在普通连接检查时启动。夹具清理只操作本次测试创建的隔离资源。

生产构建依赖边界、调用路径测试和协议级观察共同验证 No Consumer；仅搜索代码里有没有 `Consumer` 字样不足以证明安全，因为展示 ConsumerStats 本来就是正常功能。

### 19.3 核心无消费安全测试

| ID | 场景 | 验收结果 |
|---|---|---|
| SAFE-01 | 只打开面板并连接 Observe | 无 Producer、Consumer、Reader、Subscription 创建操作 |
| SAFE-02 | 查看所有核心页面 | 只有获准的 Admin 操作；无 Subscribe / Receive / ACK |
| SAFE-03 | 持续刷新 30 分钟后退出 | 不新增面板 Subscription，不遗留消费实例 |
| SAFE-04 | 调用本地校验 / Prepare | 无 Producer 创建，无消息发布 |
| SAFE-05 | 进行一次获准 Send | 只建立必要 Producer 并发布；不创建消费订阅 |
| SAFE-06 | 发送完成后关闭面板 | Producer/网络任务回收；已发消息不撤回 |
| SAFE-07 | 检查 Consumer/Reader/TableView 隐式依赖 | 产品执行路径没有构造这些对象 |
| SAFE-08 | 前端尝试调用 Reset/Delete/Skip | 在可信层阻止，网络上没有对应请求 |
| SAFE-09 | 尝试调用 Broker 主动 Health Check | 白名单拒绝 |
| SAFE-10 | 未知 Admin GET / 未授权 Query | 默认拒绝；不能因为是 GET 而放行 |
| SAFE-11 | 已有业务 Subscription 暂停后发送 | 已有积压可增加，但订阅集合不因面板创建而变化 |
| SAFE-12 | Source/Bundle 代码检查 | 测试夹具 Consumer 不进入发布产物 |

验证订阅集合与状态时使用受控隔离夹具，避免其他测试、TTL 或外部进程并发改变资源导致错误归因。必要时记录 Broker 审计/协议事件，证明应用没有发出禁用操作。

### 19.4 数据正确性测试

| ID | 场景 | 验收结果 |
|---|---|---|
| DATA-01 | 非分区与分区 Topic 混合 | 列表归一化正确，父子不重复统计 |
| DATA-02 | 名称含 `-partition-` 但非预期父子关系 | 不仅凭正则误合并 |
| DATA-03 | 2 个 Subscription 等待同一消息 | 不将积压合计标为唯一消息数 |
| DATA-04 | Unacked 与 Backlog 同时存在 | 不无条件相加 |
| DATA-05 | 多分区同名 Subscription | 逻辑订阅数去重正确 |
| DATA-06 | `excludeConsumers=true` | 显示未请求，不显示 0 Consumer |
| DATA-07 | 单个分区请求失败 | 总览标记 Partial，给出覆盖范围 |
| DATA-08 | Counter 超过 JS 安全整数范围 | 保持原始精度 |
| DATA-09 | Counter 重置 | 不生成负速率或错误巨大跳变 |
| DATA-10 | 零值时间戳/缺失时间 | 显示未知/未发生，不显示 1970 |
| DATA-11 | 同名 Topic 存在于 QAT 与 UAT | 缓存与 Schema 不串环境 |
| DATA-12 | 只采集部分 Topic | 不标为全 Cluster 总计 |
| DATA-13 | Topic Stats Out > In | 不单独判定异常 |
| DATA-14 | Consumer 名称相同但资源不同 | 实例不错误去重 |
| DATA-15 | 指标采集中断 | 曲线显示缺口，不补 0 |
| DATA-16 | API 字段新增/缺失/类型变化 | 兼容或明确 Unsupported，不崩溃、不伪造默认值 |

### 19.5 Producer 与发送测试

| ID | 场景 | 验收结果 |
|---|---|---|
| SEND-01 | 普通 Raw UTF-8 单条发送 | Receipt 与消息字节正确 |
| SEND-02 | JSON 大整数、金额与签名内容 | 不因解析/格式化静默修改 |
| SEND-03 | Message Key / 空 Key / 未设置 Key | 按实际选择保留语义 |
| SEND-04 | Properties 含重复键或非法内容 | 预检拒绝，不发送 |
| SEND-05 | 目标不在 Allowlist | 可信层阻止 |
| SEND-06 | Topic 不存在或无法确认 | 阻止；不自动创建 |
| SEND-07 | 发送前环境/内容变更 | 旧确认令牌失效 |
| SEND-08 | 重复点击/重复提交确认令牌 | 不产生第二次面板 Send 调用 |
| SEND-09 | Broker 已写入但 Receipt 丢失 | 显示 UnknownOutcome，不自动重发 |
| SEND-10 | Payload 明确被拒绝 | 显示 Rejected 与原因 |
| SEND-11 | 进入 SDK 队列后取消 | 不错误显示“确认未发送” |
| SEND-12 | Existing Exclusive Producer | 面板不 Fencing，不夺取独占权 |
| SEND-13 | Raw Topic / 有 Schema Topic | 不发生未获准 Schema 注册/更新 |
| SEND-14 | SDK 不支持目标编码 | Unsupported，不静默换编码 |
| SEND-15 | 发送中进程崩溃再启动 | 保留未决记录；不自动继续发送 |
| SEND-16 | 发送完成 | 不为验证结果创建 Consumer 或 Reader |
| SEND-17 | 策略变化/权限收回 | 失效的 Prepared Send 被拒绝 |
| SEND-18 | 含正则订阅的测试环境 | 记录实际隔离边界，避免误判测试 Topic 安全 |

### 19.6 网络与安全测试

| ID | 场景 | 验收结果 |
|---|---|---|
| SEC-01 | 重定向到未知域名 | 不转发 Token，不跟随 |
| SEC-02 | HTTPS 降级至 HTTP | 阻止 |
| SEC-03 | 证书链/主机名不匹配 | 拒绝连接并给出可诊断错误 |
| SEC-04 | 401/403 连续出现 | 不形成重试风暴 |
| SEC-05 | JSON/Metadata 中有 HTML/脚本 | 按文本处理，不执行 |
| SEC-06 | 恶意 Topic 编码、`..`、双重编码 | 不越过白名单范围 |
| SEC-07 | Schema / Stats 超大响应 | 大小限制生效，不拖垮应用 |
| SEC-08 | 导出含 Token/内部敏感字段 | 默认脱敏；Secret 不进入导出 |
| SEC-09 | 恶意网页调用本地执行层 | 会话、Origin 与 CSRF 检查阻止 |
| SEC-10 | CSV 公式注入 | 导出为安全文本 |
| SEC-11 | 凭据轮换 | 旧缓存/发送确认按策略失效，不混用权限 |
| SEC-12 | 入口可达但 Broker 路由不可达 | 明确区分，不误报“发送通道正常” |

### 19.7 性能与耐久测试

测试 100 / 1,000 / 10,000 个 Topic 名称，4 / 32 / 256 个分区的受控快照，以及大规模 Producer/Consumer 明细。

记录首次查询、重复打开、快速切换环境、多个窗口、网络抖动、长时间后台、设备睡眠唤醒、8 小时运行后的内存、CPU、请求数量、连接数、任务数和 UI 延迟。

真实 Broker 负载对比采用可重复的基线与面板开启后的同负载实验；记录 p95/p99 延迟及资源差异。没有测试结果就不在产品宣传中声称“完全无影响”或固定百分比的性能优势。

### 19.8 测试通过的定义

安全边界与发送状态机的关键分支必须全覆盖；建议普通业务代码行覆盖率至少 90%，并结合分支覆盖、属性测试和人工审查，而不是只追求一个覆盖率数字。

任何 No Consumer、凭据泄露、误发、自动重发、错误环境发送、Fencing、危险 Admin 请求或错误显示 Accepted 的缺陷，均为阻断发布的问题。

---

<a id="section-20"></a>

## 20. 交付阶段与质量门禁

阶段用于组织工作，不降低最终能力与测试标准。每阶段均包含错误路径、取消、超时、日志、资源清理、测试和文档。

| 阶段 | 交付内容 | 必须通过的门禁 |
|---|---|---|
| A：协议与安全验证 | 确认真实版本、入口、权限、SDK；建立能力矩阵与隔离夹具 | Observe 无隐式写入；Producer 编码、Receipt、Shared、关闭行为已验证 |
| B：Observe 核心 | 连接、Topics、Topic Detail、订阅、Consumer、Producer、分区 | 核心数据和无消费安全测试通过 |
| C：发送闭环 | 校验、Prepare/Confirm/Execute、发送历史、未知结果处理 | 发送状态机、安全范围与不自动重发测试通过 |
| D：开发体验 | Schema、只读 Policies、模板、快捷键、诊断导出、短期曲线 | 字段解释、脱敏、环境隔离与 E2E 通过 |
| E：性能与发布 | 缓存/预算、长跑、兼容性矩阵、打包与升级 | 性能报告、故障演练、安全回归、发布检查完整 |

### 20.1 不可跳过的发布条件

必须有目标环境版本清单、SDK 版本锁定、API 白名单清单、支持/不支持能力列表、测试报告、资源预算报告、凭据保护说明、已知限制及回滚方式。

仅有漂亮 UI、能够列 Topic 或成功发送一条消息，不代表该产品已经达到正式发布标准。

### 20.2 新版本兼容性策略

新增 Broker/SDK 版本时，先增加脱敏 Fixture 与隔离集成测试，再更新兼容矩阵。不要把“协议通常兼容”当成所有 Admin 字段、Schema 与代理行为都已验证。

不支持的功能应明确显示，不通过随机探测接口或降级为 Consumer 来实现。

---

<a id="section-21"></a>

## 21. SRE 对接资料与沟通模板

### 21.1 开发接入前需要的资料

| 资料 | 原因 |
|---|---|
| QAT / UAT 的实际 Pulsar 版本 | 决定 API 参数、字段和 SDK 兼容性 |
| Admin Service URL 与路径前缀 | 状态查询所需，不能由 Broker URL 猜测 |
| Broker / Proxy Service URL | Producer 发送所需 |
| 公司认可的网络访问路径 | 确认 SASE、DNS、TLS、代理和 Broker 路由 |
| 已授权 Tenant / Namespace / Topic | 避免依赖全局管理员枚举权限 |
| Observe 读取权限 | 按具体操作和资源授权，不申请不必要管理权限 |
| Produce 目标范围与凭据 | 只向批准的测试资源发送 |
| Topic/Schema 自动创建与更新策略 | 验证发送不会触发未授权元数据变化 |
| 测试 Topic 的下游与订阅清单 | 确认真实隔离，不只看名字 |
| 查询频率与响应规模限制 | 避免观察负载影响共享环境 |
| 大消息、Schema、Key 约定 | 与现有 Producer/Consumer 编码保持一致 |
| 审计与凭据轮换流程 | 确保长期维护安全 |

Broker 的 Topic 自动创建、Schema 更新等配置有独立开关及相关策略，应由部署负责人确认，面板只读取允许查看的部分，不擅自修改。 [S22]

### 21.2 可以直接发给同事的说明

> 我这个不是要起 local consumer 去 subscribe QAT/UAT 的 topic。
>
> 我要做的是一个 Pulsar developer panel，主要用 Admin REST API 看已有 topics、subscriptions、backlog、producers 和 consumers。需要测试时，我才手动用 producer 发一条 message。
>
> Panel 不会 create consumer / reader / subscription，也不会 receive、ACK、reset cursor 或 clear backlog，所以不会留下一个属于 panel 的 local debug subscription。
>
> 不过查询本身有请求开销，而发送的 message 会真的进入 topic，可能让已有 subscription 的 backlog 增加或触发现有业务。我会限制刷新频率、用 API 白名单，并把发送限制到批准的 test topic。
>
> 所以我需要 Admin REST URL、查询权限、批准的 namespace/topic 范围，以及现有 broker/proxy 的访问方式；不需要因为这个 panel 特地建立消费订阅。

### 21.3 对“是否影响”的推荐说明

> **这个面板不消费消息，也不新增消费订阅。普通使用是受控的状态查询；主动发送是明确的真实写入。它避免的是 local consumer 遗留订阅的问题，不是承诺任何操作都没有资源或业务影响。**

---

<a id="section-22"></a>

## 22. 开发目录与工作包

### 22.1 建议目录

这是建议布局，不表示当前仓库已经存在这些文件；集成已有产品时按其架构适配。

```text
penguin-pulsar-panel/
├── apps/
│   └── desktop/
│       ├── src/                    # UI 入口
│       └── src-tauri/               # 桌面启动与最小 IPC 能力
├── packages/
│   ├── ui/                         # 页面与共享组件
│   ├── contracts/                  # 生成/校验的前后端 DTO
│   └── fixtures/                   # 脱敏的 API 响应样本
├── crates/
│   ├── panel-domain/               # Topic、Metric、Snapshot、SendOutcome
│   ├── panel-policy/               # 操作白名单、Topic 范围、确认令牌
│   ├── pulsar-observe/             # Admin 查询与版本适配
│   ├── pulsar-produce/             # Producer-only 接口与 SDK 适配
│   ├── panel-runtime/              # 连接、任务、轮询与缓存
│   ├── panel-secrets/              # 凭据引用与安全存储
│   ├── panel-storage/              # 本地设置、模板、审计
│   └── panel-diagnostics/          # 脱敏与诊断导出
├── tests/
│   ├── unit/
│   ├── contract/
│   ├── integration/
│   ├── integration-fixtures/      # 独立夹具，可模拟已有业务消费者
│   ├── security/
│   ├── e2e/
│   └── performance/
└── docs/
    ├── product-spec.md
    ├── api-allowlist.md
    ├── compatibility-matrix.md
    ├── threat-model.md
    └── test-reports/
```

### 22.2 可拆分的工作包

| 工作包 | 实现内容 | 完成证据 |
|---|---|---|
| WP-01 协议调查 | 实际版本、认证、API/SDK 能力 | 兼容矩阵、脱敏 Fixture、差异记录 |
| WP-02 安全基础 | 白名单、资源范围、Secret、审计、确认模型 | 禁用操作与凭据泄露测试 |
| WP-03 Observe Adapter | 列表、Stats、分区、Schema、只读 Policies | 契约与集成测试 |
| WP-04 数据语义 | 正规化、聚合、精度、缺失值、采样 | 数据正确性测试与计算样例 |
| WP-05 核心 UI | Topics、详情、Subscriptions、Consumers、Producers | 核心流程 E2E 与交互评审 |
| WP-06 Send Service | 编码、预检、Shared、Receipt、未知结果 | 独立 Producer 兼容性与故障测试 |
| WP-07 Developer UX | 模板、快捷键、诊断、有限历史 | 脱敏与无副作用测试 |
| WP-08 发布质量 | 性能、资源回收、打包、兼容升级 | 基准报告、回归报告、发布清单 |

### 22.3 模块的完成定义

每个模块必须同时具备正常路径、错误路径、取消与超时处理、结构化日志、Request ID、资源回收、单元/集成测试、性能观察和使用说明。

UI 能点开但错误时崩溃，或成功能发但超时会自动重发，都不算完成。

---

<a id="section-23"></a>

## 23. 最终验收清单

### 产品与交互

- [ ] 核心五个功能完整：Topics、Subscriptions & Backlog、Consumers、Producers、Send Message。
- [ ] Topic Detail 能集中展示关键状态，页面不过度拥挤。
- [ ] QAT/UAT 与完整 Topic 始终明确，发送确认不依赖颜色。
- [ ] 支持搜索、复制、收藏、刷新、暂停与键盘操作。
- [ ] Loading、Empty、Forbidden、Stale、Partial、Unsupported、Unknown 表现明确。

### 无消费边界

- [ ] 产品运行时不创建 Consumer、Reader、TableView 或 Subscription。
- [ ] 不 Receive、不 ACK/NACK、不移动 Cursor、不清积压。
- [ ] Observe 和 Prepare 不创建 Producer，不发探测消息。
- [ ] 不使用主动 Broker Health Check 冒充被动连接检查。
- [ ] SDK 隐式行为和测试夹具与发布代码边界已有证据。

### 数据正确性

- [ ] 不重复统计父 Topic 和子 Partition。
- [ ] 不把订阅积压合计称为唯一消息数。
- [ ] 不无条件累加 Backlog 与 Unacked。
- [ ] 不把出站速率称为业务处理成功速度。
- [ ] 缺失、未请求、无权限与 0 分开表示。
- [ ] 分区覆盖率、采集时间、统计范围与历史缺口可见。
- [ ] 大整数与 Message ID 保持精度和完整性。

### 发送安全

- [ ] 只允许明确、手动、单条发送。
- [ ] 权限、Allowlist、确认令牌都由可信层校验。
- [ ] 使用 Shared，不驱逐或接管其他 Producer。
- [ ] Accepted / Rejected / UnknownOutcome 等状态语义正确。
- [ ] 不自动重发；SDK 重试行为经过验证。
- [ ] Topic/Schema 自动创建与更新风险经过部署侧审核。
- [ ] 测试资源的真实下游边界经过确认。
- [ ] 发送结果不冒充业务成功。

### 运维与质量

- [ ] 刷新频率、并发、响应体、缓存、历史均有上限。
- [ ] 窗口关闭、设备休眠、断网、退出后任务和连接正确回收。
- [ ] Secret 不进入 UI 存储、日志、Git、截图导出或分享文件。
- [ ] 所有声明支持的环境/SDK 组合有测试记录。
- [ ] 单元、契约、集成、安全、E2E、故障与性能测试完整。
- [ ] 资源开销有实测报告，未用推测冒充性能结果。

---

<a id="section-24"></a>

## 24. 可交给开发者或 Coding Agent 的执行说明

```text
请根据本规格实现 Penguin Pulsar Panel。

产品的核心是：
1. 用经过审核的 Admin REST 查询观察现有 Pulsar 状态。
2. 仅在用户明确确认后，用 Producer 手动发送一条测试消息。

必须实现五个核心区域：
Topics / Subscriptions & Backlog / Consumers / Producers / Send Message。

注意：Consumers 页面展示的是其他现有 Consumer 的统计，
不是在面板内部创建 Consumer。

严格禁止：
- 创建 Consumer、Reader、TableView、Subscription。
- Receive、ACK、NACK、Reset Cursor、Skip、Clear Backlog。
- 自动消费验证发送结果。
- 为连接检测发送/读取消息，或调用主动 Broker Health Check。
- 任意 Admin 请求透传、危险管理 API、默认高频全量扫描。
- 超时自动再次发送消息。
- 使用 Exclusive/Fencing Producer 干扰现有 Producer。
- 把 Request ID 当作 Exactly Once 保证。
- 把“没有面板订阅”包装成“绝对没有系统影响”。

可信层必须落实 API 白名单、Topic 范围、凭据隔离、
发送确认、资源预算、审计、重定向控制和错误分类。

Stats 必须正确处理分区、聚合范围、缺失值、大整数、
重复计数、采样窗口和历史缺口。

发送结果必须区分 Broker Accepted、明确拒绝和 UnknownOutcome；
Broker Accepted 不代表业务处理成功。

不要假设当前部署一定是文档基线版本。
先建立实际版本的 API/SDK 兼容性矩阵与隔离测试夹具。

测试夹具可以模拟已有业务 Consumer，但不能放进产品运行路径。
每个功能必须同时交付正常/错误路径、取消、超时、
日志、Request ID、资源回收、测试和文档。

实现完成后提交：
- 可运行应用和必要配置说明；
- 版本与能力矩阵；
- 无消费/无危险管理操作的测试证据；
- 发送结果与重复风险测试；
- 数据正确性、安全、E2E 和性能报告；
- 已知限制及未验证项，不能伪装为已支持。
```

---

<a id="section-25"></a>

## 25. 仍需现场确认的配置

这些信息不影响本规格对产品方向的定义，但影响实际对接。没有答案时标记 Unknown，不猜测。

| 未确认信息 | 暂定处理 |
|---|---|
| QAT/UAT 的 Broker 与代理版本 | API 基线仅供实现参考，不要求你们升级 |
| 实际 Admin URL、网关前缀和重定向主机 | 保留显式配置，由 SRE 提供 |
| 当前 Token 的真实读取权限 | 不尝试用截图凭据验证；申请受控凭据 |
| SASE 的访问路径与证书要求 | 遵守公司网络配置，不自行绕过 |
| 当前消息编码与 Schema | 先读已有定义，不注册新 Schema |
| 获准测试 Topic 与业务下游范围 | 默认不发送到未经批准资源 |
| Topic/Schema 自动创建与更新策略 | 由部署侧确认；客户端不作绝对保证 |
| 现有 Topic 是否存在 Exclusive Producer | 仅 Shared；冲突就报告 |
| Rust SDK 对上述环境的支持度 | 先验证，再锁定具体版本 |
| 独立桌面还是现有 Penguin 模块 | 核心边界保持一致，UI/Transport 可适配 |
| 可接受查询负载和性能预算 | 以默认保守值开始，用隔离测试校准 |

---

<a id="section-26"></a>

## 26. 官方资料与源码索引

### 26.1 如何使用这些资料

文档中的 `[Sxx]` 为来源链接。官方文档提供概念与接口说明，固定标签源码用于核对某一版本的精确行为；两者不能代替对你们实际环境的兼容测试。

以下全部为 Apache 官方资料、官方项目源码，或所建议组件的维护者资料。没有把未发布的 `next` 文档当成你们环境的能力保证。

| 引用 | 来源 | 主要用途 |
|---|---|---|
| [S01] | Apache Pulsar 4.0.x — Manage topics | Topic、Stats、Subscription、消息读取与管理接口区分 |
| [S02] | Apache Pulsar 4.0.x — Pulsar stats | 指标口径、缺失/类型意义、计数重置与复制流量 |
| [S03] | Apache Pulsar 4.0.x — Message retention and expiry | Backlog、TTL、Retention、配额及其后果 |
| [S04] | Apache Pulsar 4.0.x — Pulsar Clients | Producer、Reader、TableView、发送确认、Access Mode |
| [S05] | Apache Pulsar v4.0.0 — BrokersBase.java | 主动 Health Check 会创建 Producer/Reader 并收发探测消息 |
| [S06] | Apache Pulsar v4.0.0 — PersistentTopics.java | REST 路径、参数、默认值、Backlog Size 查询开销 |
| [S07] | Apache Pulsar 4.0.x — Manage Schemas | Schema 读取路径、Schema 定义表示 |
| [S08] | Apache Pulsar 4.0.x — Understand schema | Producer Schema 校验与自动更新行为 |
| [S09] | Apache Pulsar v4.0.0 — TopicStats.java | Topic 字段与单位 |
| [S10] | Apache Pulsar v4.0.0 — SubscriptionStats.java | Subscription、Backlog、Unacked 等字段 |
| [S11] | Apache Pulsar v4.0.0 — PublisherStats.java | Producer 统计字段 |
| [S12] | Apache Pulsar v4.0.0 — ConsumerStats.java | Consumer 统计字段 |
| [S13] | Apache Pulsar 4.0.x — Admin CLI reference | Stats 速率窗口与 CLI 参数 |
| [S14] | Apache Pulsar 4.0.x — Authentication and authorization | 认证、角色与授权边界 |
| [S15] | Apache Pulsar 4.0.x — Managing Namespaces | Namespace 查询 |
| [S16] | Apache Pulsar 4.0.x — Managing Tenants | Tenant 查询 |
| [S17] | Apache Pulsar 4.0.x — Pulsar metrics | Prometheus 指标来源与 Admin 快照的区别 |
| [S18] | Apache Pulsar — Client libraries | 客户端来源和兼容性注意事项 |
| [S19] | StreamNative — pulsar-rs | Rust 客户端候选，能力需逐项验证 |
| [S20] | Tauri — What is Tauri? | 建议桌面架构 |
| [S21] | Tauri — Capabilities | 桌面前端权限边界 |
| [S22] | Apache Pulsar v4.0.0 — broker.conf | 自动创建 Topic、Schema 更新及相关部署设置 |

[S01]: https://pulsar.apache.org/docs/4.0.x/admin-api-topics/
[S02]: https://pulsar.apache.org/docs/4.0.x/administration-stats/
[S03]: https://pulsar.apache.org/docs/4.0.x/cookbooks-retention-expiry/
[S04]: https://pulsar.apache.org/docs/4.0.x/concepts-clients/
[S05]: https://raw.githubusercontent.com/apache/pulsar/v4.0.0/pulsar-broker/src/main/java/org/apache/pulsar/broker/admin/impl/BrokersBase.java
[S06]: https://raw.githubusercontent.com/apache/pulsar/v4.0.0/pulsar-broker/src/main/java/org/apache/pulsar/broker/admin/v2/PersistentTopics.java
[S07]: https://pulsar.apache.org/docs/4.0.x/admin-api-schemas/
[S08]: https://pulsar.apache.org/docs/4.0.x/schema-understand/
[S09]: https://raw.githubusercontent.com/apache/pulsar/v4.0.0/pulsar-client-admin-api/src/main/java/org/apache/pulsar/common/policies/data/TopicStats.java
[S10]: https://raw.githubusercontent.com/apache/pulsar/v4.0.0/pulsar-client-admin-api/src/main/java/org/apache/pulsar/common/policies/data/SubscriptionStats.java
[S11]: https://raw.githubusercontent.com/apache/pulsar/v4.0.0/pulsar-client-admin-api/src/main/java/org/apache/pulsar/common/policies/data/PublisherStats.java
[S12]: https://raw.githubusercontent.com/apache/pulsar/v4.0.0/pulsar-client-admin-api/src/main/java/org/apache/pulsar/common/policies/data/ConsumerStats.java
[S13]: https://pulsar.apache.org/docs/4.0.x/reference-pulsar-admin/
[S14]: https://pulsar.apache.org/docs/4.0.x/security-authorization/
[S15]: https://pulsar.apache.org/docs/4.0.x/admin-api-namespaces/
[S16]: https://pulsar.apache.org/docs/4.0.x/admin-api-tenants/
[S17]: https://pulsar.apache.org/docs/4.0.x/reference-metrics/
[S18]: https://pulsar.apache.org/docs/client-libraries/
[S19]: https://github.com/streamnative/pulsar-rs
[S20]: https://v2.tauri.app/start/
[S21]: https://v2.tauri.app/security/capabilities/
[S22]: https://raw.githubusercontent.com/apache/pulsar/v4.0.0/conf/broker.conf

---

## 最终定义

**Penguin Pulsar Panel 是一个以受控观察和手动发布为核心的开发工具。它不创建自己的消费订阅，不接收业务消息，不操作消费进度；通过准确的统计、明确的发送边界和完整测试，让开发者看清现有 Pulsar、谨慎发送测试消息。**
