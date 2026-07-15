# Penguin Wiki / Knowledge 优化审查

审查日期：2026-07-13  
范围：Pengvi 当前工作树、`/Users/shieng/Desktop/Projects` 21 repo、Penguin CLI/installed MCP，以及 codebase-memory-mcp、CodeGraph、Understand-Anything、Graphify  
状态：实现与验证后复核

## 当前判断

Penguin 已经可以取代 CodeGraph 与 Graphify，成为本机默认的代码理解入口。依据不是“功能看起来更多”，而是 fresh 证据：21/21 repo v4 索引、29,838 files error=0、1,044/1,044 unique invokes、Flyover 1,185/1,185、415/415 CLI/MCP shadow parity、5/5 人工 truth、11/11 test mappings 与 4/4 真实 debug golden 全部通过。

但 Penguin 仍不是运行时真相系统。“100%”只覆盖已定义的静态合同；reflection、动态生成、日志/数据库/部署 image 与源码 commit 的关联仍需要额外证据。

## 与四个项目相比，还缺什么

| 项目 | 值得吸收 | Penguin 当前状态 / 缺口 |
|---|---|---|
| codebase-memory-mcp | coverage/degradation diagnostics、共享压缩 artifact、runtime trace | 静态图和 trust 已较完整；仍缺可解释空结果、团队 artifact、runtime validation |
| CodeGraph | 一个 hero explore 返回 source + call paths；call-site provenance | `knowledge_explore` 已具备主体能力；仍需把它设为 agent 首选，并补 line/column provenance |
| Understand-Anything | architecture/domain/onboarding/guided tour | Penguin 查询内核更强；业务域、persona onboarding 与 guided tour 仍薄弱 |
| Graphify | edge evidence、community、confirm/reject feedback | Penguin 有 provenance/confidence 与 suggestions；community 可用，但稳定标签和长期 feedback/decay 仍可加强 |

## 现在最该优化的能力

### P0：信任与诊断

1. 已完成：空结果区分 `no_match`、`not_indexed`、`stale_target`、assembly error 与 `no_static_edge`，并返回 edge evidence/coverage gaps。
2. 已完成：compact status、stale identity 过滤、canonical alias 迁移/duplicate doctor、`knowledge_explore` hero guidance。
3. 已完成本批次分发：Claude Code opt-in hooks；Codex canonical MCP + `AGENTS.md`；其他 agent 使用同一 MCP/CLI fallback。
4. 仍需解决重复 watcher：由 app 维护单实例 ownership，并在 status/doctor 显示 PID 与重复检测。

### P1：日志驱动 debugging

建立 `log_site` 索引：

- 捕获 `AppLogger/logger/console` 的 level 与静态字符串或模板静态前缀；
- 记录 file、line、column、enclosing symbol；
- `log_site → emits_log → symbol`；
- 支持粘贴 SLS 日志串反查代码；
- 动态插值只作为 pattern，不把运行时值写入知识库。

这是 Penguin 相对 grep/CodeGraph 最有差异化的下一项能力。

### P1：字段读写与数据流

当前 field index 只能返回声明/键名 file:line。下一步增加：

- `reads_field`、`writes_field`；
- assignment、update object、ORM update、Mongo `$set` 等可静态确认的写点；
- 查询 `field-sites accountStatus --writes-only`；
- property 名高度泛化时必须结合 receiver/type/file import scope，拒绝全仓裸名称猜测。

### P1：Hero agent surface

将 `knowledge_explore` 设为 MCP/AGENTS 首选：一次返回 source、callers、callees、cross-service flow、tests、routes、blast radius、provenance、confidence、freshness、diagnostics。其余 search/get_node/explore_graph 保持为窄查询与排错工具。

### P2：检索体验

- AND 无结果时显式 fallback：OR → prefix → fuzzy，并返回 `degraded=true`、`matchMode`。
- symbol search 已返回 signature snippet；下一步支持 bounded source excerpt。
- field hit 改成显式 identifier result，不再以 `nodeId:null` 冒充 graph node。
- BM25 归一化或改成可解释 relevance bucket。
- get_node 支持批量 ids/identity keys。

### P2：运行时与部署真相

从 CI 可验证 metadata 起步：artifact/image digest、git commit、service、environment、deployedAt。之后才能回答“线上 image 是否包含这个 symbol/commit”。SLS 与 DB 连接器只挂 evidence，不把运行时观察反写成静态事实。

### P2：Pengvi 桌面产品桥

- `grpc::<service>.<method>` 直接生成 `describe_method + resolve_environment + call_method` 模板；只生成，不默认执行。
- 解析 Mongoose `@Schema({ collection })`，把 collection、schema、repository/index 连接成可查询数据边界。
- debug 结束时建议（而非自动）创建 typed postmortem note；写入必须 materialize、可搜索、可审计、可撤销。
- 增加 `compare_branches_bulk(path_filter?)`、`repoName::symbol` 与 compact `index_status`，降低 agent token 成本。

## 已完成且不应重复建设

- vendored Node/native ABI 与真实 configured MCP doctor。
- CLI/MCP 共享 query semantics 与 `knowledge_explore`。
- branch/worktree/parser/schema trust envelope。
- TS/TSX callback factory、dynamic import、test mapping、Rust associated call。
- Connect RPC cast receiver、frontend→gRPC endpoint invokes。
- balanced-brace proto parser 与 Flyover endpoint handles。
- second-pass resolution、generic hub suppression、community diagnostics。
- stale search/resolution filtering与 signature snippet。
- 21 repo boundary oracle 与 415-query real shadow corpus。
- Auth `RiskControlClientGrpc.closeAccount → ResponsibleGamingInternalService.CloseAccount → risk handler` 已有 `invokes + handles`，跨仓 flow 可达。

## CodeGraph / Graphify 决策

可以将 Penguin 放在第一位，并移除 CodeGraph/Graphify 的强制前置规则；暂时保留两者作为对照 fallback，而非日常必跑：

- CodeGraph：当需要独立 source/call-path 交叉验证时使用。
- Graphify：当需要独立 community/visualization 交叉验证时使用。
- Penguin：默认用于 search、explore、flow、affected、architecture、services、tests 与跨 repo gRPC 关系。

物理删除前的最后门槛不是再增加静态 relation 数量，而是完成并实测：日志字面量索引、field reads/writes、watcher 单实例。

## 产品分发判断

对 agent 工具而言，被动可用接近于不存在。本批次已完成 canonical MCP、managed AGENTS/CLAUDE guidance、Claude Code 可选 SessionStart compact status 与 bounded prompt-context hook。Codex 不伪装 Claude settings hook，而是使用 canonical MCP + `AGENTS.md`；其他客户端沿用同一 MCP/CLI contract。后续分发指标应是“真实 session 首次定位是否主动选 Penguin”，而不是 tool 数量。

## 验证边界与风险

- dirty repo 的结果对应当前磁盘源码，不等于 HEAD 可复现。
- 0/0 repo 表示当前合同无 candidate，不表示它具有实际跨服务覆盖。
- storage edge multiplicity 是多证据或多 call-site；在 provenance 有 line/column 前不能盲目去重。
- 不读取 `.env*`，不以日志/数据库中的敏感值建立默认索引。
