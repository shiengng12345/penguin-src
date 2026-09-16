# Stage 0 — 合规修复与本机 QAT 模拟

> **执行方式**：REQUIRED SUB-SKILL — superpowers:subagent-driven-development
>
> **Spec**：[`2026-09-16-penguin-pulsar-panel-conformance.md`](../specs/2026-09-16-penguin-pulsar-panel-conformance.md)
> **上游**：[`2026-09-16-penguin-pulsar-panel-product-spec.md`](../specs/2026-09-16-penguin-pulsar-panel-product-spec.md)

**目标**：关闭符合性审计发现的全部违反项，并让本机环境能模拟用户 QAT 的连接形态（JWT + TLS），使后续的协议验证不必碰用户的真实集群。

**基线**：`cargo test` 306 · `pnpm test:ui` 147 · `pnpm typecheck` 0 · 业务 topic 10 个

---

## Global Constraints

- **本阶段仍然全部只读。** 除任务 2 明确移除的写探测外，不新增任何写路径。
- 用户的 `pulsar` 容器（localhost:8080）装着**真实业务 topic**。只读；只能创建/删除 `broker-probe-` 前缀的 topic；**禁止 `docker exec -d`**；结束时必须确认 10 个 topic 完好。
- **不得同时运行两个 broker 后再跑 cargo 构建** —— 这台 6.2 GB 的 VM 已经因此 OOM 杀过 `pulsar` 容器一次。需要 secure broker 时，用完即停。
- 磁盘紧张：**禁止 `cargo clean`、禁止 release 构建**。
- Rust 与 TypeScript 逐字段一致，线上 camelCase。
- 新建源文件 ≤ 400 行。
- 所有验证命令在**前台**执行。`pnpm typecheck` 的退出码要**直接检查**（Vitest 转译时不做类型检查，UI 全绿证明不了类型对）。
- 不跑 `pnpm test`（node:test，需要一个故意停着的容器）。
- **每一条行为变更都要先红后绿，失败输出要贴进报告。**

---

## 任务 1 — `/stats` 安全参数 + `StatsRequestScope`（裁决 R34）

**依据**：上游 §12.3、§14.1、§23；符合性 §3.2

**问题**：`admin_rest.rs` 调 `/stats` 不带任何查询参数。v4.0.0 的 REST 实现中 `subscriptionBacklogSize` 可能涉及 Ledger 锁，且 **REST 默认值与 CLI 默认值不同**。本机 10 个空 topic 测不出来，QAT 有真实流量时会。

**同时解决的第二个问题**：一旦传 `subscriptionBacklogSize=false`，对应字段就**永远是 null**。界面会显示「未知」，而真相是**我们自己故意没问**。这是本阶段一直在防的同一类谎话，换了个形式。

**要做的**：

1. `PulsarAdminRest::get_topic_stats` 显式带
   `?getPreciseBacklog=false&subscriptionBacklogSize=false&getEarliestTimeInBacklog=false`
2. 新增 `StatsRequestScope { precise_backlog: bool, subscription_backlog_size: bool, earliest_time_in_backlog: bool }`，随 `TopicStats` 一起返回，镜像到 TS。
3. 界面对**受这些开关影响的字段**显示「未查询」而非「未知」，靠编译期已知的字段↔开关映射。
   - **不要**在响应里塞字符串列表让界面去匹配 —— 那是 Finding 1 刚修掉的毛病（面板只能显示、不能推理）。

**测试**（先红后绿）：
- 参数确实出现在请求 URL 上（对 `EndpointGuard` 放行的 URL 断言）
- `StatsRequestScope` 的线格式由测试钉死，照 `BacklogAge` 的先例
- 界面：某字段在 `subscription_backlog_size: false` 时显示「未查询」，在 `true` 且值确实缺失时显示「未知」——**两者必须渲染成不同的字符串**
- 变异验证：把「未查询」折回「未知」，上一条测试必须变红

---

## 任务 2 — 移除建删 topic 的写探测

**依据**：上游 B-07、§11.9、§14.3；符合性 §3.1 —— **本阶段优先级最高**

**问题**：`capability.rs` 的 `probe_write` 会 PUT 建一个 `broker-probe-write-<pid>-<ts>` 再 DELETE。用户 QAT 的 token 是 super-admin scope，所以**在那边它会真的执行** —— 在别人的集群上建一个 topic 再删掉。

`read_only` 能挡，但那不是默认值，而且规格 §14.3 对 `connections.testObserve` 的要求是明确的：**不创建 Producer / Consumer**，更不用说 topic。

**要做的**：

1. 删除 `probe_write` 及其 PUT/DELETE 调用。
2. 写能力改为从**已有的只读响应**推断：
   - Admin 端点返回 401/403 → 该凭据连读都不行，写更不行
   - 读成功 → **不足以推断能写**，`can_write` 保持 `false`、`can_write_probed: false`，并带一条说明「未测量」的警告
3. `WriteGuard`/`WritePermit` 保留 —— Stage C 的发送要用。但本阶段**不应再有任何 `authorize()` 调用点**。

**测试**（先红后绿）：
- 全仓库 grep：`capability.rs` 里不再有 `.put(` / `.delete(`
- 探测在 `read_only: true` 与 `false` 下**都不发起任何写请求**
- `can_write_probed` 为 `false` 时，UI 文案读作「未测量」，不读作「不可写」
- 对着**本机真实 broker** 跑一次 `broker_test_connection`，前后 topic 列表逐字相同

---

## 任务 3 — 64-bit 计数器改无损传输

**依据**：上游 §14.1、§23；符合性 §3.3

**问题**：五个 `u64` 字段以 JSON number 过 IPC，JS 安全整数上限 2⁵³−1 ≈ 9.007×10¹⁵，`u64` 上限 1.8×10¹⁹。长期运行的高流量 topic 的累计计数器会越线，然后**数字静默变错，没有报错**。

| Rust | 位置 |
|---|---|
| `msg_in_counter` `storage_size` `backlog_size` | `stats.rs` |
| `entries_added_counter` `messages_consumed_counter` | `internal_stats.rs` |

**要做的**：serde 以十进制字符串序列化，TS 侧类型改 `string`，UI 格式化用字符串分组或 `BigInt`。

**测试**（先红后绿）：
- 一个大于 2⁵³ 的值往返后**逐位相同**（这条在改之前必须是红的 —— 证明问题真实存在）
- 线格式由测试钉死
- UI 渲染大数不出现科学计数法、不截断

---

## 任务 4 — `read_without_ack` 移出 lib

**依据**：上游 B-01/B-03、§1.3；符合性 §4.1

**问题**：它现在编译进 lib（`adapters/pulsar/mod.rs` 的 `pub mod binary`），只是没有命令可达。上游 §1.3 特别警告 Reader 底层仍是 Consumer + 非持久订阅。

**要做的**：让「面板不消费」这条保证从**「没人调用」升级为「编译期不可能」**。`produce_one` 保留（Stage C 要用），`read_without_ack` 仅测试可见（`#[cfg(test)]` 或移入 `tests/`）。

**测试**：`cargo build` 后的 lib 里不存在该符号；`broker_sim` 与现有 binary 测试仍能编译运行。

---

## 任务 5 — `internalStats` 补入白名单文档

**依据**：上游 §12.2；符合性 §3.5

不算违规 —— 它是合法只读接口，且是区分「消费慢」与「完全没消费」的**唯一**手段（上游 §7 自己也要这个能力）。但 §12.2 要求未验证能力显示 Unsupported，不得试探任意路径。

**要做的**：在 `docs/` 下建立 `api-allowlist.md`（上游 §22.1 的目录结构里本来就有这个文件），列出本产品调用的每一个 Admin 端点、用途、以及 `internalStats` 为何在列的理由。

---

## 任务 6 — 本机 QAT 模拟：给 secure broker 加 TLS

**依据**：用户明确要求「local need to 模拟 qat」；上游 §13.3 的 SDK 验证表

**现状**：`broker-pulsar-secure` 有 JWT（`AuthenticationProviderToken`），但**没有 TLS** —— 6651 映射的是容器内的明文 6650。用户 QAT 用 `pulsar+ssl://`。

**要做的**：

1. 生成自签 CA + broker 证书（放 `infra/broker/secure/`，**加进 `.gitignore`**）
2. compose 增加 TLS 配置，暴露 TLS 端口
3. 记录客户端连接所需的参数（CA 路径、hostname 校验开关）

**注意**：`docker-compose.secure.yml` 里那条 `bin/apply-config-from-env.py` 是**承重的** —— 该镜像没有 ENTRYPOINT 会自动应用 `PULSAR_PREFIX_*`，少了它所有配置会被静默忽略、认证根本没开，而探测**看起来全部通过**。加 TLS 时同一个陷阱适用。

**测试**：
- `pulsar+ssl://localhost:<port>` 能握手成功（**只连接，不建 producer、不建订阅**）
- 用错误的 CA 连接**必须失败**（否则等于没验证 TLS）
- 带无效 token 连接返回可识别的认证错误，不是超时

**完成后必须停掉 secure 容器** —— 两个 broker 同时跑会 OOM。

---

## Stage 0 Gate

- [ ] `cargo test` 不低于 306，`pnpm test:ui` 不低于 147，`pnpm typecheck` 退出码 0
- [ ] `capability.rs` 无任何 `.put(` / `.delete(`
- [ ] `/stats` 请求 URL 带三个安全参数
- [ ] 大于 2⁵³ 的计数器往返逐位相同
- [ ] lib 中不存在 `read_without_ack`
- [ ] `docs/api-allowlist.md` 存在且覆盖全部调用端点
- [ ] `pulsar+ssl://` 本机握手成功，错误 CA 必失败
- [ ] 业务 topic 仍为 10 个，无 `broker-probe-` 残留
- [ ] secure 容器已停止
- [ ] 无 `Not run` / `Blocked` 行
