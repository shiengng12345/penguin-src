# Penguin Agent 信任与分发设计

## 状态

- 日期：2026-07-13
- 方案：A（信任与分发优先）
- 用户批准：2026-07-13
- 依据：`.codex/penguin-wiki-optimization-review.md` 与四轮 Claude Code 真实 session 反馈
- 实施方式：测试驱动；不新增 package；不读取 `.env*`；不自动执行网络请求

## 目标

让 Claude Code、Codex 和其他 MCP/CLI agent 只使用 canonical `penguin` 知识引擎，并让 agent 在首次代码定位时主动选择 Penguin、能判断空结果是否可信、能用紧凑状态判断索引是否新鲜。各客户端按自身能力接入，不伪造相同 hook 能力。

本设计完成后，以下问题必须有机器可验证的答案：

1. 当前客户端是否仍注册历史 `pengvi` alias 或等价重复 server？
2. 空查询结果是“确实没有静态关系”，还是 target、索引、freshness 或 resolver 有问题？
3. agent 如何用一次首选调用获得 source、关系、tests、routes、trust 和诊断？
4. 多 repo 状态如何在有限 token 内表达？
5. Claude 真实 debug 案例是否进入长期回归，而不是只留在报告中？

## 非目标

本批次不实现：

- `log_site`、SLS 日志字面量反查；
- `reads_field` / `writes_field`；
- Mongo collection 节点；
- deploy image / artifact 到 commit 的关联；
- watcher 单实例 ownership；
- symbol 到 `call_method` 的请求模板桥；
- 自动写 postmortem note；
- 自动运行任何 endpoint、shell mutation 或外部请求。

这些能力进入后续 B tranche，避免把 parser/schema 大改与 agent 分发改动混在同一批。

## 已有能力与复用边界

### 保留

- `src-tauri/src/mcp.rs` 已将 installed MCP 同步到 `~/.penguin/mcp`，优先 vendored Node/native ABI。
- `write_claude_desktop_mcp_config_at` 与 `write_codex_mcp_config_at` 已以 `penguin` 为 canonical name。
- `knowledge_explore`、CLI 和 MCP 已共享 query semantics。
- search 已过滤 stale duplicate 并返回 signature snippet。
- frontend client、Connect RPC、proto endpoint、跨 repo gRPC flow 已有回归覆盖。
- `scripts/knowledge-real-repo-benchmark.mjs` 已验证 installed MCP 与 CLI parity。

### 需要补齐

- installer 写入 `penguin` 时没有迁移旧 `pengvi` alias。
- doctor 只验证 canonical runtime，没有报告 alias/重复 tool surface。
- guidance block 没有明确把 `knowledge_explore` 定为 MCP 首选。
- 没有官方、可关闭、bounded 的 Claude Code hook。
- graph 空结果没有统一 diagnostic envelope。
- `index_status` 缺少面向 agent 的 compact mode。
- 本次 Claude debug 的 golden cases 未进入 real benchmark。

## 架构决定

### AD-1：canonical migration 只删除可证明属于 Penguin 的 legacy alias

配置迁移复用现有 JSON/TOML merge，不整体重写用户配置语义。

Claude JSON 中仅在以下任一条件成立时删除 `mcpServers.pengvi`：

1. command/args 指向 `~/.pengvi`、`~/.penguin` 或当前 Pengvi/Penguin MCP bundle；
2. 运行只读 `initialize + tools/list` 后 server name 为 `penguin-mcp`，且 tool-name set 与 canonical server 相同。

无法证明的同名 server 不删除，返回 `legacyAlias.status = "ambiguous"` 和人工处理提示。其他 MCP server、OAuth、project state 与未知字段必须原样保留。

Codex TOML 同样只处理 `[mcp_servers.pengvi]`，且使用相同 ownership 判定。若解析失败，拒绝写入并报告结构化错误。

迁移结果：

~~~ts
interface CanonicalMigrationResult {
  canonical: "penguin";
  written: boolean;
  removedAliases: Array<"pengvi">;
  ambiguousAliases: Array<{ name: string; reason: string }>;
  preservedServers: number;
}
~~~

### AD-2：duplicate detection 按配置目标和 tool surface 分层

doctor 输出新增：

~~~ts
interface McpDuplicateDiagnostic {
  name: string;
  classification:
    | "legacy_alias_same_target"
    | "legacy_alias_same_surface"
    | "name_collision"
    | "none";
  canonicalTarget: { command: string; server: string } | null;
  duplicateTarget: { command: string; server: string } | null;
  safeToMigrate: boolean;
  reason: string;
}
~~~

路径相同可直接归类 `legacy_alias_same_target`；路径不同必须通过只读 MCP smoke 比较 server name 和 tool-name set。doctor 不输出其他 server 的 env、headers、tokens 或完整配置内容。

desktop `mcp_status` 与 CLI doctor 共享同一分类语义；UI 只显示计数、分类和修复动作，不展示敏感配置。

### AD-3：空结果使用统一 diagnostic envelope，不伪造覆盖率

`knowledge_explore` 与 `explore_graph` 的 JSON 返回扩展为：

~~~ts
interface QueryDiagnostics {
  resolutionStatus:
    | "resolved"
    | "no_match"
    | "ambiguous"
    | "stale_target"
    | "not_indexed"
    | "assembly_error";
  resultStatus:
    | "has_results"
    | "no_static_edge"
    | "unresolved_edges"
    | "query_error";
  target: {
    requested: string;
    resolvedNodeId: string | null;
    repo: string | null;
    branch: string | null;
  };
  freshness: {
    status: "fresh" | "dirty" | "stale" | "unknown";
    indexedCommit: string | null;
    headCommit: string | null;
    dirtyFileCount: number | null;
  } | null;
  evidence: {
    incomingByType: Record<string, number>;
    outgoingByType: Record<string, number>;
    unresolvedReferenceCount: number;
  };
  coverageGaps: string[];
}
~~~

规则：

- target 未解析时不返回伪装成成功的空 `nodes`。
- target 已解析且对应 edge type 为零时返回 `no_static_edge`。
- 存在 resolver 未决证据时返回 `unresolved_edges`。
- `coverageGaps` 只列当前 parser/query 明确不支持的模式，不生成百分比。
- 现有 `nodes`、`edges`、source 和 trust 字段保持兼容；diagnostics 是新增字段。

### AD-4：compact status 是显式模式，不削减详细状态

CLI：

~~~text
penguin status --compact --json
~~~

MCP：

~~~json
{ "mode": "compact" }
~~~

每个 repo 只返回：

~~~ts
interface CompactRepoStatus {
  repo: string;
  liveBranch: string | null;
  freshness: "fresh" | "dirty" | "stale" | "unknown";
  dirtyFileCount: number | null;
  indexedCommit: string | null;
  headCommit: string | null;
  parserVersion: string | null;
  indexErrorCount: number;
}
~~~

顶层附带 repo 总数及 fresh/dirty/stale/unknown/error 计数。默认详细模式保持不变，避免破坏 Wiki UI 和现有消费者。

### AD-5：`knowledge_explore` 成为 agent hero entry

更新 MCP tool description、global guidance 与 repo guidance：

1. 代码理解默认先调用 `knowledge_explore`；
2. 精确找名字才使用 `knowledge_search`；
3. 单节点源码使用 `get_node`；
4. 关系排错使用 `explore_graph`；
5. 空结果必须读取 `diagnostics` 后才能断言“没有 caller”。

`knowledge_explore` 一次返回 bounded：

- resolved target 与 source excerpt；
- callers/callees；
- routes/endpoints；
- tests；
- cross-service flow；
- blast radius；
- provenance/confidence；
- freshness 与 diagnostics。

每类结果有独立上限，返回 `truncated` 和 `nextQueryHint`，不无限扩大 MCP response。

### AD-6：共享引擎按 agent capability 分层接入

所有客户端共享同一个 knowledge DB、CLI query layer 和 canonical MCP，不为 Claude Code、Codex 分叉实现或复制索引：

- Claude Code：canonical MCP + `CLAUDE.md` guidance；可额外 opt-in 原生 `SessionStart` / `UserPromptSubmit` hooks。
- Codex：canonical MCP + `AGENTS.md` guidance；当前没有在本设计中假设与 Claude settings 等价的事件 hook。
- 其他 MCP agent：连接 canonical `penguin` MCP；不支持 MCP 时使用同一 `penguin context/flow/status` CLI contract。

UI 必须明确显示这种 capability 差异。“兼顾所有 agent”表示同源语义和安全 fallback，不表示每个客户端都拥有 Claude Code 的事件 API。

Claude Code hook 为显式 opt-in，默认只注入 compact status。

安装入口增加“Enable Claude Code context hook”，默认关闭。启用后写入 auto-managed hook，支持完整卸载。

SessionStart：

- 执行 `penguin status --compact --json`；
- 注入一段不超过 900 字符的摘要；
- 超时 800ms 时静默降级为一行 unavailable；
- 不读取源码、不读取 `.env*`、不触发索引。

UserPromptSubmit：

- 默认关闭，用户可独立开启；
- 只从 prompt 提取显式 symbol、route、endpoint 或 file token；
- 最多执行一次 bounded `penguin context`；
- 输出上限 1,800 字符，超时 1,200ms；
- prompt 没有代码定位信号时不调用；
- hook 输出明确标注为 Penguin index context，不作为运行时事实；
- 不持久化 prompt，不写 note，不发送网络请求。

hook 配置必须使用 managed marker/独立 command，保留用户已有 hooks。卸载只删除 Penguin 管理的条目。

### AD-7：golden eval 分为 GREEN 防回退与 RED future acceptance

本批次进入自动化 GREEN corpus：

1. `who_calls updateAccountStatus` 包含 `BpAccountClosureService.closeAccount`；
2. `RiskControlClientGrpc.closeAccount`
   → `grpc::ResponsibleGamingInternalService.CloseAccount`
   → risk handler；
3. `grpc::FrontendRgAccountService.closeaccount` 可达 Auth controller handler；
4. `closeAccount` search 不返回 stale/fresh duplicate，且 snippet 非空；
5. 空结果 fixture 能区分 `no_match`、`no_static_edge` 与 `unresolved_edges`；
6. CLI 与 installed MCP 的 diagnostics/compact status 语义一致。

以下继续作为显式 RED backlog，不计入当前 precision/recall：

- 谁写 `accountStatus`；
- `playerAdditionalDetail` collection 真名与读写方；
- 从 SLS 日志文本定位 enclosing method。

benchmark 不能用空 expected 或排除 candidate 的方式制造 100%。报告继续使用限定措辞：“在已定义、由独立 source/DB oracle 验证的静态关系合同内达到 100%。”

## 数据流

~~~text
installer
  -> inspect client config
  -> classify canonical/legacy ownership
  -> write canonical penguin
  -> remove only proven legacy alias
  -> return migration diagnostic

agent prompt
  -> optional bounded hook
  -> compact status / context
  -> knowledge_explore
  -> shared query assembly
  -> result + trust + diagnostics

CI / local verification
  -> synthetic fixtures
  -> real golden cases
  -> CLI result
  -> installed MCP result
  -> parity + precision/recall
~~~

## 错误处理

- 配置 JSON/TOML 无效：不写文件，返回 parse error。
- alias ownership 不确定：保留 alias，返回 ambiguous。
- canonical runtime 不健康：不删除可工作的旧 alias，先报告 runtime failure。
- hook CLI 不存在、超时或 DB unavailable：不阻断 Claude session。
- query assembly SQL 失败：`resolutionStatus = "assembly_error"`，MCP 同时标记 error envelope。
- compact status 中单 repo Git 检查失败：该 repo 为 `unknown`，不让整个 status 失败。
- benchmark MCP error：计为 parity failure，不能当空图处理。

## 测试策略

所有行为先写失败测试，再实现。

### Rust 配置与状态

- JSON/TOML 保留未知字段和其他 MCP servers；
- proven `pengvi` alias 被删除；
- ambiguous alias 被保留；
- canonical runtime unhealthy 时不迁移；
- idempotent rerun 不产生额外 diff；
- status 不泄露其他 server 配置。

### Query 与 MCP

- resolved node + zero edge 返回 `no_static_edge`；
- unknown target 返回 `no_match`；
- stale-only target 返回 `stale_target`；
- unresolved refs 返回 `unresolved_edges`；
- detailed status 向后兼容；
- compact CLI/MCP shape 和计数一致；
- `knowledge_explore` description 明确首选和诊断语义。

### Hook

- managed install/update/uninstall 幂等；
- 保留用户已有 hooks；
- 无代码 token 的 prompt 不调用 context；
- 字符与时间预算触发可预测截断/降级；
- 不读取 `.env*`；
- 不把 prompt 写入文件。

### Golden eval

- 三条真实调用链进入固定 oracle；
- stale duplicate/snippet 进入 search regression；
- diagnostics fixtures 同时验证 CLI/MCP；
- 现有 21 repo shadow corpus、Flyover 与 Auth mappings 不回退。

## 验收门

实施完成必须 fresh 通过：

1. targeted RED→GREEN tests；
2. knowledge test suite；
3. Connect RPC tests；
4. typecheck；
5. knowledge bundle；
6. installed MCP sync 与 doctor；
7. synthetic benchmark；
8. real benchmark；
9. Projects boundary audit；
10. `git diff --check`；
11. `graphify update .`。

配置层验收还包括：

- Claude 配置仅有 canonical `penguin`；
- doctor 报 duplicate classification 为 `none`；
- canonical command/args 保持 installed Node 22 runtime；
- 不输出其他 MCP server 的敏感字段。

## 实施顺序

1. 配置 alias ownership 分类与安全迁移。
2. doctor/desktop status duplicate diagnostics。
3. query diagnostic envelope。
4. compact status。
5. hero tool descriptions 与 guidance。
6. 共享 bounded hook CLI、Claude Code opt-in installer/uninstaller，以及 Codex/通用 agent capability guidance。
7. real golden eval 固化。
8. installed runtime 更新与全套验证。

该顺序先建立迁移安全和查询语义，再接入 agent 自动分发，避免 hook 放大未诊断的错误结果。
