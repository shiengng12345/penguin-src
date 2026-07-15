# Penguin 替代 CodeGraph / Graphify：验证与修复报告

日期：2026-07-13  
状态：canonical / trust / 跨-agent 分发扩展验证完成  
范围：`/Users/shieng/Desktop/Projects` 21 个 repo、Penguin CLI、installed MCP、索引器、查询层

## 结论

Penguin 现在可以作为本机代码理解的默认入口；CodeGraph 与 Graphify 不再是日常查询的必需依赖，可降级为 optional fallback。这里的“100%”只指本报告定义并由独立 oracle 可验证的静态关系合同，不代表 reflection、运行时动态派发、部署版本或所有自然语言问题都达到宇宙级 100%。

## Fresh 验证门

| Gate | Fresh 结果 |
|---|---:|
| Projects repo 覆盖 | 21/21 |
| live branch parser | 21/21 `tree-sitter-wasm-v4-callback-factory-symbols` |
| live file rows | 29,838；error=0 |
| 前端/后端/后端间 unique invokes | 1,044/1,044；FP=0；FN=0 |
| Flyover proto handles | 1,185/1,185；FP=0；FN=0 |
| 人工 truth cases | 5/5；CLI/MCP precision=1、recall=1、parity=true |
| real shadow corpus | 415/415；21/21 repo；parity failure=0；material miss=0 |
| Auth test mappings | 11/11；recall=1；parity failure=0 |
| Claude/Codex 共享 debug golden | 4/4；CLI/MCP parity failure=0 |
| synthetic benchmark | calls/tests/routes+gRPC precision=1、recall=1 |
| runtime doctor | bundle + configured Codex MCP healthy；Node 22.23.1 / ABI 127 |
| canonical MCP duplicate | `pengvi` classification=`none`；installed tools=30 |
| bounded agent hook | CLI 真实 SessionStart/UserPromptSubmit 通过；默认关闭；64 KiB stdin / 900–1,800 chars / 800–1,200 ms |
| knowledge test suite | fail=0 |

## 独立 boundary oracle（逐 repo）

| Repo | Expected | Actual | FP | FN |
|---|---:|---:|---:|---:|
| FPMS-CCMS | 96 | 96 | 0 | 0 |
| FPMS-NT-Auth-Player | 42 | 42 | 0 | 0 |
| casino-plus | 247 | 247 | 0 | 0 |
| casino-plus-app | 244 | 244 | 0 | 0 |
| FPMS-NT-CCMS | 32 | 32 | 0 | 0 |
| FPMS | 51 | 51 | 0 | 0 |
| FPMS-NT | 125 | 125 | 0 | 0 |
| FPMS-NT-Shared | 45 | 45 | 0 | 0 |
| FPMS-NT-Payment | 76 | 76 | 0 | 0 |
| FPMS-NT-Proposal | 1 | 1 | 0 | 0 |
| FPMS-NT-Provider | 2 | 2 | 0 | 0 |
| FPMS-NT-Recommend | 2 | 2 | 0 | 0 |
| FPMS-NT-Risk-Control | 2 | 2 | 0 | 0 |
| FPMS-NT-User-Engagement | 79 | 79 | 0 | 0 |

下列 repo 在当前受支持 invokes 合同中是 0/0，通过表示“没有 unsupported/extra/missing candidate”，不表示存在实际跨服务调用覆盖：FPMS-NT-CCMS-Rust、claude_code、flyover、fpmsXcpms、FPMS-Proposal-SDK、snsoft-nestjs-temporal、grpc-web-debugger。

## 本轮真实修复

1. boundary audit 大 SQL 输出增加 64 MiB buffer，并透传 spawn error，避免 `ENOBUFS` 假诊断。
2. audit 改成 expected/actual set 对账；unsupported candidates、missing、extra 任一非空即失败。
3. TS/TSX callback factory symbol：支持 `createAsyncThunk(...)`、`forwardRef(...)` 中的 callback，同时不把普通 call-valued const 错升为 function。
4. Connect RPC receiver：支持 parenthesized、`as` cast、type assertion、non-null expression。
5. proto service parser：balanced-brace scanner 修复 nested option/body 导致的 7 个 RPC 漏报。
6. audit SQLite URI 移除 `immutable=1`，只读但能看到 committed WAL，避免读取旧快照。
7. friendly symbol resolution 排除 rebuild 遗留 stale identity；无 version 的合法 symbol 保持可查询；resolution SQL 失败返回 `assemblyError`。
8. search 排除 stale duplicate，并直接返回 signature snippet，修复 Claude Code 真实反馈中的重复结果与 1+N round-trip。
9. real benchmark 更新为当前 fresh file-scoped identity；Flyover 13 consumers 与 AppController 17 callees均经 DB provenance + source 独立复核后更新 oracle。
10. query 空结果增加 `queryDiagnostics`，区分 `no_match`、`no_static_edge`、`stale_target`、`not_indexed`、assembly error，并明确 unresolved-reference count 尚未持久化。
11. CLI `status --compact` 与 MCP `index_status({mode:"compact"})` 同源；`knowledge_explore` 成为 MCP/AGENTS 首选入口。
12. canonical installer/doctor 安全迁移 proven `pengvi` alias、保留 ambiguous collision；Claude Code 与 Codex 不再重复暴露同一 MCP。
13. agent 分发按 capability 分层：Claude Code 可 opt-in 原生 hooks；Codex 使用 canonical MCP + managed `AGENTS.md`；其他 agent 使用同一 MCP/CLI fallback，不复制知识库。

所有行为修复均有最小 RED fixture，之后 GREEN；没有新增 package。

## Claude Code 真实 session 反馈复核

- `BpAccountClosureService.closeAccount → updateAccountStatus` 当前 fresh 图可正确返回 caller。反馈中的 `node_84de…` 是 stale 短 identity；根因是 search 暴露 stale 节点，不是 DI receiver 完全失效。
- `knowledge_search closeAccount` 修复前 12 个 symbol 结果是 6 组 stale/fresh 重复；修复后只返回 6 个 fresh symbol，且 snippet 非 null。
- `grpc::FrontendRgAccountService.closeaccount` 当前有 Flyover service 与 Auth controller 两条 `handles`；`penguin flow` 可一跳到 controller method 并继续 service/repository 链。旧“endpoint 死胡同”应保留为回归场景，但当前索引已通过。
- field hit 的 `nodeId:null` 是 file:line identifier，不是 graph node；当前 contract 仍应改成显式 `resultKind: identifier`，避免误解。

## 数据与信任边界

本轮 rebuild/index 时以下 repo 不是 clean：

- FPMS-NT-Auth-Player：dirty（8 个当前磁盘文件；包括 6 个 login processor/test 文件及 2 个 repository 文件）
- FPMS-NT-CCMS：dirty（`CLAUDE.md`）
- FPMS-NT-Proposal：dirty（`CLAUDE.md`）
- grpc-web-debugger：dirty（`package.json`、`pnpm-lock.yaml`）
- snsoft-nestjs-temporal：Git 状态不可用

这些 repo 的 parser error 仍为 0，oracle 对的是当前磁盘源码；但结果不能被描述为“可由 HEAD 完全复现”。

## 存储 multiplicity

- `invokes`：1,047 storage edges / 1,044 unique relation keys。
- `handles`：3,223 storage edges / 3,217 unique relation keys。

handles 的重复多为不同 proto 文件对同 endpoint 的独立证据，应保留。invokes 的 3 个额外 edge 很可能是同一 source symbol 内多个真实 call site；当前 provenance 只有 file，没有 line/column。下一步应加入 call-site line/column，并以 `(src,dst,source_type,file,line,column)` 区分，不能盲目去重。

## 下一阶段优化优先级

1. 日志字面量索引：`log_site` + `emits_log`，支持从 SLS 文本跳到 enclosing method。
2. 字段读写点：`reads_field` / `writes_field`，区分声明、读取、写入。
3. 多词空结果显式降级到 OR/prefix/fuzzy，并返回 `degraded`、`matchMode`。
4. field/identifier result 使用明确 discriminated union；BM25 转为可解释 score。
5. 给 invokes/handles 增加 call-site line/column provenance。
6. 解析 CI artifact/image→commit 元数据，建立静态图与实际部署版本的可验证关联。

## 三轮真实 session 反馈：结构化 issue backlog

### 已修复 / 保留回归

| 类型 | Issue | 当前结论 | 回归验收 |
|---|---|---|---|
| Bug | stale/fresh 重复 identity | 已修：默认 search/resolution 排除 stale | `closeAccount` 不返回旧短 identity；fresh node 可继续 callers/flow |
| Bug | DI caller `closeAccount → updateAccountStatus` | 当前 fresh 图已命中；旧失败来自选择 stale node | `who_calls updateAccountStatus` 包含 `BpAccountClosureService.closeAccount` |
| Bug | endpoint 无 handler | 当前已有 `handles` | `FrontendRgAccountService.closeaccount` 一跳到 Auth controller |
| Bug | Auth client→Risk server 无跨仓边 | 当前已有 `invokes + handles` | `RiskControlClientGrpc.closeAccount → ResponsibleGamingInternalService.CloseAccount → risk handler` |

### P0：信任与 agent UX

| Issue | 验收标准 |
|---|---|
| 空结果诊断 | 已完成；未持久化的 unresolved count 明确列为 coverage gap，不虚构覆盖率 |
| watcher 单实例 | 同 repo/branch 只允许一个 owner PID；doctor/status 报告重复 watcher 与持锁时间 |
| `knowledge_explore` 主入口 | 已完成；MCP description 与 managed CLAUDE/AGENTS guidance 均明确首选 |
| compact index status | 已完成；CLI/MCP 同源且 detailed 默认 shape 不变 |
| 官方 agent hook / distribution | 已完成本批次：Claude opt-in 原生 hook；Codex canonical MCP + AGENTS；通用 MCP/CLI fallback |
| MCP canonical name 收敛 | 已完成；只注册 `penguin`，doctor duplicate=`none` |

### P1：差异化功能

| Issue | 验收标准 |
|---|---|
| SLS 日志反查 | 静态日志字符串/模板前缀形成 `log_site`，携带 level、file:line、enclosing symbol |
| field reads/writes | `reads_field`/`writes_field` 区分声明、读、写；支持 `writes-only`，receiver 不明时拒绝猜测 |
| Mongo collection 一等节点 | 解析 `@Schema({collection})`、model/repository、indexes；回答 collection 真名及读写方 |
| debug→note 出口 | 经用户授权创建 postmortem note、materialize、search 可见、get_node 自动显示 backlink |
| symbol→request bridge | endpoint node 生成 schema-aware `call_method` 模板与环境候选；required placeholder 明示，绝不默认发送 |
| deploy evidence | CI artifact/image digest 可验证地关联 commit、service、environment、deployedAt |

### P2：效率与可用性

| Issue | 验收标准 |
|---|---|
| search degraded fallback | AND 空时 OR→prefix→fuzzy，并明确 `degraded` / `matchMode` |
| identifier result contract | field hit 使用 discriminated result，不以 `nodeId:null` 冒充 graph node |
| batch get/diff | `get_node` 支持批量 id；`compare_branches_bulk` 支持 path filter 与 changed symbols |
| repo-name identity | 支持 `auth::BpAccountClosureService.closeAccount`，歧义时返回 repo candidates |
| 可解释 rank | 裸 BM25 改为 score bucket 或 0–1 relevance，并保留原始 rank 仅供 debug |

### 生态层已确认事实

- Claude 全局配置已完成迁移：删除 `mcpServers.pengvi`，仅保留 canonical `mcpServers.penguin`。
- canonical server 继续使用 `/Users/shieng/.penguin/mcp/node` + installed bundle；定向解析确认 command/args 未改变。
- fresh `knowledge:doctor` 返回 healthy，installed server 使用 Node 22.23.1 / ABI 127，并暴露 30 个 tools。
- 产品侧仍需让 installer/doctor 自动识别并迁移历史 `pengvi` alias，防止其他机器继续承担重复 tool definitions 与 runtime 漂移。

### Golden eval：本次 debug 固定案例

| Query | Expected | 当前状态 |
|---|---|---|
| 谁调用 `updateAccountStatus` | `BpAccountClosureService.closeAccount` | GREEN，已进入 4/4 debug gate |
| 谁写 `accountStatus` | 至少 `closeAccount` 与 `upsertCpf` 的 `$setOnInsert`，并区分写点 | RED，等待 field writes |
| CloseAccount 从 Auth client 到 Risk 落库链 | client `invokes` endpoint，endpoint `handles` risk handler，再到 repository/write | GREEN 到 risk business chain，已进入 gate；collection/write node 待补 |
| `playerAdditionalDetail` collection 真名和读写方 | 显式 collection 节点、schema、repositories、indexes、readers/writers | RED，等待 Mongoose adapter |

这些案例应进入 real benchmark，而不是只留在文档；GREEN 案例防回退，RED 案例作为 feature acceptance，不允许用空 expected 制造假 100%。

## 是否删除 CodeGraph / Graphify

当前建议是移除它们在 `AGENTS.md` 中的强制前置顺序，但暂不物理删除索引与 hook：

- Penguin 已覆盖本轮 21 repo，CLI/MCP 同源且达到本报告的 100% 静态合同。
- CodeGraph 仍可作为 source/call-path 的对照工具。
- Graphify 仍可作为可视化/community 的对照工具。
- 待日志索引、field read/write 与 watcher ownership 再经过真实 session 验证后，再决定删除 artifacts。
