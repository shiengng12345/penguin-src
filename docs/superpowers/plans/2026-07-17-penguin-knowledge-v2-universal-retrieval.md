# Penguin Knowledge V2 Universal Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (<code>- [ ]</code>) syntax for tracking.

**Goal:** 把 Penguin Knowledge 升级为一个可独立运行、可审计、可发布的本地代码知识系统；对覆盖清单内的每一个文本文件，保证路径和源码中的确定性内容都能通过 CLI 与 MCP 找到，并在结构图、Wiki、语义召回、运行时证据和团队知识层上超过当前计划替换的工具组合。

**Architecture:** 系统采用“一个核心、六条检索通道、三个适配面”的结构。唯一的核心查询引擎负责作用域、版本、权限、排序、诊断和游标；确定性源码、结构图、Markdown 知识、语义召回、运行时证据和记忆反馈是可组合通道；CLI、MCP、Wiki 只做参数适配和展示，不能各自实现检索逻辑。源码存储按内容哈希去重，并接入现有 snapshot/COW 模型，避免每个分支复制全文。

**Tech Stack:** TypeScript、Node.js 22、better-sqlite3、SQLite FTS5、Tree-sitter WASM、Rust/Tauri、React、Vitest/Node test runner、pnpm、JSON-RPC/MCP、Markdown/YAML、可选本地 embedding provider。

---

## 执行总览（单一计划入口）

本文件是唯一 canonical implementation plan，不再维护第二份摘要计划。阶段状态必须以本文件中的 checkbox、阶段验收命令和最新执行证据为准；下表只提供导航，不能替代验收。

| 阶段 | 目标 | 依赖 | 当前状态 | 完成出口 |
|---|---|---|---|---|
| M0 | 冻结缺口、fixture、hash 与发布漂移基线 | 无 | 核心已实现，验收未完全签收 | baseline、graph benchmark、real benchmark、diff check 全部有证据 |
| M1 | 共享 Search/Coverage contract 与 97 capability manifest | M0 | 核心已实现，剩余 adapter validator/parity gate | CLI/MCP registration、schema output、manifest hash 全部同源 |
| M2 | Git-truth 文件发现、encoding、secret/binary 与 coverage manifest | M1 | 核心已实现，pipeline 边界仍需收尾 | 主 pipeline 接入、流式大文件、完整边界测试全部通过 |
| M3 | Schema v10、source blob、line index、snapshot COW 与 backfill | M2 | **进行中**：schema/store/COW/backfill/GC 已有实现和测试，需完成 orphan/历史全量验收 | revision-aware source corpus 可迁移、可校验、可回收 |
| M4 | exact/path/phrase/substring/regex 确定性检索 | M3 | **进行中**：core、CLI/MCP source lane、path、RE2 regex 已接入 | admitted source/path 固定语料达到 100% recall |
| M5 | Unified Query Planner、排序、诊断与游标 | M4 | **进行中**：planner/ranker/v2 response/HMAC cursor 已接入 | 所有 lane 统一 scope/revision/ranking/cursor contract |
| M6 | CLI 全 capability 与稳定机器接口 | M5 | 进行中：v2 search、coverage、onboarding/domain/why、query server 已接入，仍有 capability gaps | canonical CLI command、JSON、compact、错误码完整 |
| M7 | MCP 全 capability、hydration 与安全 mutation | M5 | 进行中：manifest discovery、v2 search、generated tool discovery 已接入，guard/parity 未签收 | MCP 不少于 CLI，mutation 有确认与审计 |
| M8 | 常驻 Query Runtime 与 Tauri manager | M6、M7 | **进行中**：Node JSONL protocol/query-server 与 Rust resident worker/handshake/restart 已接入，取消与完整 runtime E2E 未签收 | 低延迟、可恢复、可取消、version/hash handshake |
| M9 | Wiki 全局搜索、预览与知识导航 | M8 | 进行中：Search tab、debounce、mode、coverage/zero-result UI 已接入 | 任意源码/知识可从一个入口追到上下文、WHY、证据 |
| M10 | 身份、数据流、动态派发、协议与跨服务结构图 | M5 | 进行中：bounded typed graph DSL 已接入，其余 extractor/flow 未完成 | 结构能力通过可信度与真实问题 benchmark |
| M11 | Markdown-first Knowledge Vault 与 Obsidian 兼容 | M5 | 进行中：properties、wikilink/anchor/embed 索引已接入，Canvas/external sources 未完成 | properties、wikilink、backlink、Canvas round-trip |
| M12 | WHY Cards、Memory、Domain Flow 与 Onboarding | M10、M11 | 进行中：WHY/memory/ontology/onboarding core 已接入，审计/CLI lifecycle 仍需补齐 | 重要结论均可追到代码、revision、证据和验证状态 |
| M13 | 可选本地 Semantic、反馈与反思 | M5、M11 | **进行中**：provider contract、cosine search、async semantic blend、feedback/reflection 已接入，真实本地模型/vector store 未完成 | semantic 可关闭且永不覆盖 deterministic truth |
| M14 | Validated Findings、安全、权限与审计 | M12、M13 | **进行中**：Evidence、ValidatedFinding 生命周期、content safety、MCP audit chain 已接入，完整 scope hardening 未完成 | 事实/观察/推测分离，无 secret 与跨 scope 泄漏 |
| M15 | 可移植、可校验、可增量 Knowledge Artifact | M14 | **进行中**：portable ZIP、checksum、HMAC signature、AES-GCM envelope、CLI/MCP validation 已接入，delta/real restore 未完成 | export/import、签名、CI、离线恢复与损坏检测 |
| M16 | 10,000 needles、100+ 盲测与发布 Gate | M9、M10、M15 | **进行中**：benchmark/parity/package-smoke/SBOM/release-gate 脚本已接入，真实 10k corpus、100+ gold 与 frozen differential 未签收 | recall、parity、latency、security、artifact drift 全绿 |
| M17 | 21+ repo backfill、shadow、双 RC、回滚与竞品下线 | M16 | **进行中**：rollout/shadow/rollback runbook 与审计脚本已接入，真实 workspace、双 RC、operator approval 未完成 | RC1/RC2 与 rollback 成功后才允许移除外部工具 |
| M18 | 最终文档、运维、升级、发布与 AI 交接 | M17 | **进行中**：Knowledge V2 文档、package README、canonical guidance 已接入，生成式文档漂移 gate 与最终发布仍未完成 | 新人或 AI 可独立安装、查询、诊断、发布和回滚 |

当前安全执行顺序：`M2 收尾 → M3 → M4 → M5 → M6/M7 → M8 → M9/M10/M11 → M12 → M13 → M14 → M15 → M16 → M17 → M18`。

当前禁止事项：M16/M17 gate 未完成前，不得宣称超越竞品，不得合并发布，不得删除 CodeGraph/Graphify，也不得让 Penguin correctness 依赖外部 adapter fallback。

## 0. 文档地位、执行边界与最终判定

### 0.1 文档地位

本文件是 Penguin Knowledge V2 的 Master Implementation Plan。它整合并升级以下既有方向：

- 现有 Knowledge Core、Indexer、CLI、MCP、Wiki、revision COW、WHY、evidence、API documentation 和 trust/distribution 计划继续有效。
- 当旧文档 <code>docs/penguin-knowledge-strategy.md</code> 中“不要与外部 indexer 正面竞争、允许 adapter fallback”的表述与本计划冲突时，以本计划为准。
- 外部 CodeGraph、Graphify 或其他服务只能在迁移期间作为 differential oracle，不能成为发布后正确性的依赖。
- 本计划里的竞品能力是设计基线，不是尚未完成的性能实测结论。只有第 16 阶段的盲测结果可以支持“超越”结论。

### 0.2 不可协商的产品契约

1. **代码存在即可确定性找到。** 对 coverage manifest 标记为 <code>admitted</code> 的非二进制文本文件：
   - 精确路径查询必须返回该文件。
   - 精确子串、短语、标识符、注释、字符串常量、局部变量、调用表达式必须返回正确文件和行号。
   - 文件没有 Tree-sitter grammar、解析失败或不参与结构图，都不能让全文检索消失。
2. **零结果必须可解释。** 空结果要说明搜索过哪些通道、解析出的作用域、索引版本、被排除的文件及原因、是否有 stale/failed coverage，以及下一步建议。
3. **确定性通道优先。** exact/path/phrase/substring 的真实命中不能被 semantic 结果压低或替代；语义召回绝不是唯一入口。
4. **CLI 与 MCP 完整同源。** capability manifest 中标为 <code>requiredOn: ["cli", "mcp"]</code> 的能力必须两边都有，输入输出经过规范化后相等。
5. **版本和分支隔离。** 所有结果必须绑定已解析的 repo、branch、snapshot、commit；不能把 master、feature、已删除文件或其他 repo 的事实混在一起。
6. **发布物与源码一致。** clean install 后，schema version、capability hash、tool list、query contract hash 必须与源码构建一致。
7. **移除外部工具有硬门槛。** 两个连续 release candidate 全部通过 universal retrieval、surface parity、real-question differential 和 packaged-runtime gate，才能移除 CodeGraph/Graphify。

### 0.3 明确不做

- 不在 P0 阶段用 LLM 生成结果来掩盖全文检索缺口。
- 不把每个局部变量都升级为图节点；全文检索负责“找得到”，结构图负责“关系可信”。
- 不默认索引二进制、凭据文件、用户明确排除的目录；这些文件必须出现在 coverage diagnostics 中。
- 不要求 Wiki 暴露全部管理命令；完整能力覆盖的硬要求是 CLI 与 MCP，Wiki 负责高频浏览、搜索、解释和知识编辑。
- 不在实现任务中自动执行 <code>git add</code>、<code>git commit</code>、<code>git push</code>、发布、tag 或删除外部工具。需要这些动作时，只报告建议命令和等待操作者授权。

### 0.4 Definition of Done

只有同时满足以下条件，项目才可标记完成：

- 10,000 个分层随机源码 needle：exact recall = 100%，path recall = 100%，文件和行号正确率 = 100%。
- unsupported parser、解析失败、YAML/SQL/Proto/Markdown、中文注释、带标点调用表达式均在固定回归集中。
- warm exact search p95 小于 150 ms；warm structural search p95 小于 300 ms。该性能目标适用于长度至少 3 个 Unicode code point、默认 limit 50 的典型查询；长度 1–2 的查询仍保证正确，但允许走受诊断标记的全扫描路径。
- CLI/MCP 的 normalized response 在相同请求和 revision 上逐字节相等。
- Wiki 调用同一 contract，并能从任意 hit 打开文件、行号、图上下文、WHY 和证据。
- 源码构建、bundled CLI、bundled MCP、实际安装 MCP 的 capability hash 相等。
- 100 个以上真实问题的 blind differential 无正确性回退；任何 Penguin 独有结论都带可打开的 provenance。
- 两个连续 release candidate 通过全部 gate，且 rollback 演练成功。

---

## 1. 已核实现状与问题基线

以下 Knowledge 源码与 benchmark 事实最初在 2026-07-17 的 <code>feature/knowledge-core</code> 上审计。计划编写期间，共享工作树被外部操作先切到 <code>fix/package-download-refresh-loop</code>，随后又切到 <code>main</code> 并出现并行改动；本计划没有执行 checkout/switch，也没有修改这些文件。因此本文是 branch-neutral master plan。实施者必须先在操作者指定的 Knowledge 分支或独立 worktree 重跑 M0；若结果变化，在执行报告记录差异，不可静默改写本节。

### 1.1 当前可用能力

- <code>packages/knowledge-core</code> 已有 repo、branch、snapshot、symbol version、edge、note、evidence、response sample、file fact 和 COW revision 模型。
- 当前 schema version 为 9；SQLite 使用 WAL，<code>foreign_keys = OFF</code>，因此所有新引用完整性都必须有显式验证查询和测试。
- 当前结构搜索覆盖 symbol/name/signature、notes，以及 endpoint/service/entity/log_site 等结构字段。
- Indexer 已支持多语言 Tree-sitter、前后端 gRPC/Connect/HTTP 关系、调用、测试、日志点、package dependency、git topology 和 notes。
- CLI 已有约 50 个命令；源码 MCP 定义已有 Knowledge、API doc、repository analysis、evidence/SLS 等能力。
- Wiki 当前主页面以 Context、Graph、SLS Evidence 浏览为主；全局搜索不是主入口。
- fixture benchmark、21-repo real benchmark、branch isolation、rename alias、delete stale 和已知 graph relation parity 当前通过。

### 1.2 已复现的确定性缺口

源码存在：

~~~text
/Users/shieng/Desktop/Projects/auth/apps/player/src/player/player.service.ts
入口日志只记 platformId,绝不回显明文 cpf(PII)
this.playerAdditionalDetailRepository.findAllByCpf(...)
~~~

但以下查询返回空数组：

~~~bash
rtk penguin search 'playerAdditionalDetailRepository.findAllByCpf' \
  --repo FPMS-NT-Auth-Player --json

rtk penguin search 'libs/tools/src/vault/types/legitimuz-config.type.ts' --json

rtk penguin search 'blacklist player login' --json
~~~

根因不是文件不存在，而是当前全文入口只覆盖：

- note 的 title/body；
- symbol 的 name/signature；
- lightweight identifier 的名称；
- 一部分结构节点字段。

它不覆盖完整路径、注释、字符串、局部变量、完整调用表达式和无 parser 文件。当前 walker 还会把超过 1 MB、minified/vendor、unsupported grammar 的文件跳过，且 unsupported 文件没有独立全文索引。

### 1.3 已复现的发布漂移

- 当前源码 bundle runtime doctor 能看到完整工具集合。
- 当前安装在 <code>~/.penguin/mcp</code> 的 MCP 产物哈希与源码 bundle 不同。
- <code>pnpm knowledge:doctor</code> 当前以 <code>knowledge_tool_missing</code> 失败。
- 这不是开发态 core correctness 失败，而是发布物/安装物漂移；必须成为 P0 release gate。

### 1.4 基线命令与预期

~~~bash
rtk git status --short --branch
rtk npm run knowledge:benchmark
rtk npm run knowledge:benchmark:real
rtk test node --test \
  tests/knowledge-core-search.test.mjs \
  tests/knowledge-query.test.mjs \
  tests/knowledge-mcp-tools.test.mjs \
  tests/wiki-page.test.mjs \
  tests/knowledge-runtime-doctor.test.mjs \
  tests/knowledge-quality-benchmark.test.mjs
rtk npm run knowledge:doctor
~~~

预期基线：

- 前三组 correctness test 通过。
- real benchmark 的 truth、shadow parity、test mapping、ClaudeDebug 通过。
- doctor 在修复安装漂移前失败，并明确报告 <code>knowledge_tool_missing</code>；不能用 <code>--force</code> 或复制旧产物掩盖。

---

## 2. 目标架构

### 2.1 系统结构

~~~mermaid
flowchart LR
    CLI[Penguin CLI] --> A[Contract Adapter]
    MCP[Penguin MCP] --> A
    WIKI[Wiki UI] --> A
    A --> Q[Unified Query Engine]

    Q --> S1[Deterministic Source Lane]
    Q --> S2[Structural Graph Lane]
    Q --> S3[Markdown Knowledge Lane]
    Q --> S4[Semantic Lane Optional]
    Q --> S5[Runtime Evidence Lane]
    Q --> S6[Memory and Feedback Lane]

    S1 --> DB[(Content-addressed SQLite)]
    S2 --> DB
    S3 --> DB
    S4 --> V[(Local Vector Index)]
    S5 --> E[(Evidence Store)]
    S6 --> DB

    C[Capability Manifest] --> CLI
    C --> MCP
    C --> WIKI
    C --> R[Release Doctor]
    R --> B[Bundled CLI and MCP]
~~~

### 2.2 索引流程

~~~mermaid
sequenceDiagram
    participant G as Git truth
    participant W as Walker
    participant C as Classifier
    participant B as Blob Store
    participant P as Parser
    participant O as Snapshot COW
    participant V as Coverage Validator

    G->>W: git ls-files cached and others exclude-standard
    W->>C: path, bytes, stat, ignore reason
    C-->>W: admitted or excluded with reason
    alt admitted text
        W->>B: content hash, bytes, line index
        B-->>W: deduplicated blob id
        W->>O: source fact and overlay
        opt supported parser
            W->>P: parse same immutable bytes
            P->>O: graph file fact and resolution
        end
    else excluded or failed
        W->>O: coverage fact without searchable blob
    end
    O->>V: materialized effective snapshot
    V-->>O: discovered = admitted + excluded + failed
~~~

### 2.3 查询流程

~~~mermaid
sequenceDiagram
    participant U as CLI MCP Wiki
    participant N as Request Normalizer
    participant R as Revision Resolver
    participant P as Query Planner
    participant L as Search Lanes
    participant K as Ranker
    participant D as Diagnostics

    U->>N: SearchRequest
    N->>R: repo, branch, snapshot, commit
    R-->>N: immutable ResolvedScope
    N->>P: normalized query and scope
    P->>L: exact/path/lexical/graph/note/semantic/evidence
    L-->>P: candidates with provenance
    P->>K: deduplicate and reciprocal-rank
    K-->>D: ordered hits
    D-->>U: SearchResponse, cursor, coverage, searched lanes
~~~

### 2.4 Surface parity

~~~mermaid
flowchart TD
    M[Capability Manifest] --> C1[CLI Registry]
    M --> C2[MCP Tool Registry]
    M --> C3[Wiki Feature Registry]
    C1 --> CORE[Core Function]
    C2 --> CORE
    C3 --> CORE
    CORE --> N[Normalized JSON]
    N --> P[Parity Test]
    P -->|equal| PASS[Gate Pass]
    P -->|missing or unequal| FAIL[Release Blocked]
~~~

### 2.5 Release 与外部工具移除

~~~mermaid
flowchart TD
    A[Source tests pass] --> B[Universal retrieval 100 percent]
    B --> C[CLI MCP parity]
    C --> D[Packaged runtime hash parity]
    D --> E[100 plus blind questions]
    E --> F[RC N]
    F --> G[Rollback drill]
    G --> H[RC N plus 1 repeats all gates]
    H --> I{External-only correct cases?}
    I -->|yes| J[Keep external tool and open gap]
    I -->|no| K[Operator-approved uninstall]
~~~

---

## 3. Canonical contracts

所有 surface 直接依赖 <code>packages/knowledge-contracts</code>。禁止在 CLI、MCP 或 UI 复制同名 interface。

### 3.1 Search contract

创建 <code>packages/knowledge-contracts/src/search.ts</code>：

~~~typescript
export type SearchMode =
  | "auto"
  | "exact"
  | "phrase"
  | "substring"
  | "path"
  | "regex"
  | "lexical"
  | "semantic"
  | "structural";

export type SearchLane =
  | "source"
  | "path"
  | "symbol"
  | "graph"
  | "note"
  | "semantic"
  | "evidence";

export interface RevisionSelector {
  repoId?: string;
  repoName?: string;
  branch?: string;
  snapshotId?: string;
  commitSha?: string;
  workingTree?: boolean;
}

export interface SearchRequest {
  query: string;
  mode?: SearchMode;
  scope?: {
    workspaceId?: string;
    revisions?: RevisionSelector[];
    paths?: string[];
    languages?: string[];
    kinds?: string[];
  };
  options?: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    includeGenerated?: boolean;
    includeVendor?: boolean;
    includeExcludedMetadata?: boolean;
    semantic?: "off" | "fallback" | "blend";
    compact?: boolean;
    explain?: boolean;
  };
  page?: {
    limit?: number;
    cursor?: string;
  };
}

export interface SearchLocator {
  repoId: string;
  repoName: string;
  revisionId: string;
  revisionKind: "commit" | "working_tree";
  branch?: string;
  commitSha?: string;
  worktreeFingerprint?: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  startByte?: number;
  endByte?: number;
  offsetEncoding?: "utf8_normalized";
  nodeId?: string;
}

export interface SearchEvidence {
  source: "source" | "graph" | "note" | "runtime" | "semantic";
  locator: SearchLocator;
  excerpt?: string;
  contentHash?: string;
  evidenceId?: string;
  observedAt?: string;
  status: "verified" | "observed" | "reviewed" | "inference";
}

export interface SearchHit {
  hitId: string;
  kind: string;
  lane: SearchLane;
  title: string;
  locator: SearchLocator;
  snippet?: string;
  highlights?: Array<{ start: number; end: number }>;
  score: number;
  rankReasons: string[];
  evidence: SearchEvidence[];
}

export interface SearchDiagnostics {
  requestId: string;
  contractVersion: string;
  capabilityHash: string;
  resolvedScopes: Array<{
    repoId: string;
    branch: string;
    snapshotId: string;
    commitSha?: string;
    revisionKind: "commit" | "working_tree";
    worktreeFingerprint?: string;
  }>;
  searchedLanes: SearchLane[];
  skippedLanes: Array<{ lane: SearchLane; reason: string }>;
  coverage: {
    discovered: number;
    admitted: number;
    excluded: number;
    failed: number;
    stale: number;
  };
  exclusions: Array<{ filePath: string; code: string; reason: string }>;
  warnings: Array<{ code: string; message: string }>;
  suggestions: Array<{ query: string; mode: SearchMode; reason: string }>;
  timingsMs: Record<string, number>;
  truncated: boolean;
}

export interface SearchResponse {
  schemaVersion: "2";
  hits: SearchHit[];
  diagnostics: SearchDiagnostics;
  page: {
    limit: number;
    nextCursor?: string;
    totalIsExact: boolean;
    total?: number;
  };
}
~~~

### 3.2 模式语义

| 模式 | 必须行为 | 不允许行为 |
|---|---|---|
| <code>exact</code> | 按用户字节序列或明确的 Unicode normalization 策略最终验证；返回全部真实 occurrence 的可分页集合 | 仅用 tokenizer 猜测后直接返回 |
| <code>phrase</code> | 保持 token 顺序和相邻性；支持中文和标点 | 自动改写成 OR |
| <code>substring</code> | 任意子串，长度 1 也正确；长度小于 3 可退化扫描 | 因查询短而静默截断 |
| <code>path</code> | 搜 basename、segment、relative path、完整 path；精确 path 优先 | 只搜已解析文件 |
| <code>regex</code> | RE2-compatible 或受限安全 regex；有预算、超时和明确错误 | 执行可灾难回溯的无限 regex |
| <code>lexical</code> | Unicode、camelCase、snake_case、kebab-case 扩展后 BM25 | 把 lexical 命中伪装成 exact |
| <code>structural</code> | 查 symbol、edge、route、service、entity、field、data flow | 混入不带 provenance 的 LLM 推测 |
| <code>semantic</code> | 本地/配置 provider 的向量召回；结果标记 inference | semantic 不可用时让 exact 失败 |
| <code>auto</code> | exact/path/lexical/structural/note 并发，semantic 按选项 fallback/blend | 隐藏实际执行通道 |

### 3.3 Coverage contract

创建 <code>packages/knowledge-contracts/src/coverage.ts</code>：

~~~typescript
export type CoverageStatus =
  | "admitted"
  | "excluded"
  | "failed"
  | "stale";

export type CoverageReasonCode =
  | "text_searchable"
  | "binary"
  | "secret_policy"
  | "ignored_by_git"
  | "outside_workspace"
  | "generated_policy"
  | "vendor_policy"
  | "hard_size_limit"
  | "unsupported_encoding"
  | "read_error"
  | "hash_error";

export interface CoverageRecord {
  repoId: string;
  snapshotId: string;
  filePath: string;
  status: CoverageStatus;
  reasonCode: CoverageReasonCode;
  reason: string;
  contentHash?: string;
  sourceBlobId?: number;
  byteSize: number;
  lineCount?: number;
  encoding?: "utf8" | "utf16le" | "utf16be";
  classification:
    | "source"
    | "config"
    | "documentation"
    | "generated"
    | "vendor"
    | "secret"
    | "binary"
    | "unknown";
  parser: {
    status: "parsed" | "unsupported" | "failed" | "not_applicable";
    language?: string;
    version?: string;
    error?: string;
  };
  indexedAt: string;
}
~~~

### 3.4 Capability manifest

创建 <code>packages/knowledge-contracts/src/capabilities.ts</code>：

~~~typescript
export interface CapabilityDefinition {
  id: string;
  version: number;
  title: string;
  coreOperation: string;
  requiredOn: Array<"cli" | "mcp" | "wiki">;
  supportsCompact: boolean;
  supportsCursor: boolean;
  mutating: boolean;
  inputSchemaId: string;
  outputSchemaId: string;
}

export const KNOWLEDGE_SEARCH_CAPABILITY = {
  id: "knowledge.search",
  version: 2,
  title: "Search code and knowledge",
  coreOperation: "searchKnowledge",
  requiredOn: ["cli", "mcp", "wiki"],
  supportsCompact: true,
  supportsCursor: true,
  mutating: false,
  inputSchemaId: "SearchRequest.v2",
  outputSchemaId: "SearchResponse.v2",
} as const satisfies CapabilityDefinition;
~~~

上述常量只定义单条 entry 的精确 shape。实现同时导出 <code>CAPABILITIES</code>，并逐项包含第 6.2 节列出的每个 ID；manifest completeness test 以该清单为 gold set。

### 3.5 游标和 compact contract

- Cursor 是 base64url 编码、带 HMAC 的 JSON，至少包含 contract version、capability hash、resolved snapshot IDs、mode、last score、last stable key、expiry。
- 任一 snapshot 或 capability hash 变化，旧 cursor 返回 <code>CURSOR_STALE</code>，不能悄悄跳到新 revision。
- Compact 模式只能省略大 snippet、重复 evidence body 和 rank detail；不能省略 hit ID、repo、revision、path、line、lane、score、coverage warning、next cursor。
- 提供 <code>knowledge.get_hit</code> 按 hit ID 补取完整内容；hit ID 必须由 revision、locator、content hash 稳定计算。

---

## 4. 数据模型与 COW 设计

### 4.1 Schema v10：通用源码层

在 <code>packages/knowledge-core/src/schema.ts</code> 通过现有 idempotent migration 增加：

~~~sql
CREATE TABLE source_blobs (
  id INTEGER PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL,
  line_count INTEGER NOT NULL,
  encoding TEXT NOT NULL,
  content TEXT NOT NULL,
  line_starts BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE source_facts (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  fact_fingerprint TEXT NOT NULL,
  content_hash TEXT,
  source_blob_id INTEGER,
  byte_size INTEGER NOT NULL,
  classification TEXT NOT NULL,
  coverage_status TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  parser_status TEXT NOT NULL,
  parser_language TEXT,
  parser_version TEXT,
  parser_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (repo_id, file_path, fact_fingerprint)
);

CREATE TABLE file_fact_sources (
  file_fact_id TEXT PRIMARY KEY,
  source_fact_id TEXT NOT NULL
);
CREATE INDEX idx_file_fact_sources_source
  ON file_fact_sources(source_fact_id);

CREATE TABLE snapshot_source_overlays (
  snapshot_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('add','modify','delete')),
  source_fact_id TEXT,
  renamed_from TEXT,
  PRIMARY KEY (snapshot_id, file_path),
  CHECK ((operation = 'delete' AND source_fact_id IS NULL) OR
         (operation IN ('add','modify') AND source_fact_id IS NOT NULL))
);

CREATE TABLE effective_snapshot_sources (
  snapshot_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  source_fact_id TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, file_path)
);

CREATE VIRTUAL TABLE fts_source_trigram USING fts5(
  content,
  content='',
  tokenize='trigram case_sensitive 0'
);

CREATE VIRTUAL TABLE fts_source_lexical USING fts5(
  lexical_text,
  content='',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE fts_source_paths USING fts5(
  repo_id UNINDEXED,
  source_fact_id UNINDEXED,
  file_path,
  basename,
  segments,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE INDEX idx_source_facts_repo_path_hash
  ON source_facts(repo_id, file_path, content_hash);
CREATE INDEX idx_source_facts_blob
  ON source_facts(source_blob_id);
CREATE INDEX idx_effective_sources_snapshot
  ON effective_snapshot_sources(snapshot_id, file_path);
~~~

注意：

- FTS contentless table 的 <code>rowid</code> 必须等于 <code>source_blobs.id</code>；插入和删除由 <code>SourceStore</code> 的单一事务维护，禁止散落 SQL。
- <code>fts_source_paths</code> 对 source fact 建索引，不只对 admitted file；这样用户能找到被排除的路径并看到原因。
- <code>fact_fingerprint</code> 对 admitted file 由 content hash + coverage-policy version + parser version 计算；对无法读取/hash 的 excluded/failed file，由 repo-relative path + stat metadata + reason code + policy version 计算。它不能包含 secret 内容。
- <code>content_hash</code> 和 <code>source_blob_id</code> 对 read/hash failure 允许为空；只有 <code>coverage_status=admitted</code> 时两者必须非空，由 application-level CHECK test 保证。
- 同一个 source fact 可对应多个 parser-version file fact，所以 <code>file_fact_sources.source_fact_id</code> 不能 UNIQUE。
- SQLite <code>foreign_keys = OFF</code>，所以 schema 中即使写 REFERENCES 也不能当成完整性保证；doctor 必须执行 orphan queries。
- migration 必须先 probe FTS5 trigram availability。若 bundled SQLite 不支持 trigram，构建直接失败并给出 <code>FTS5_TRIGRAM_UNAVAILABLE</code>，不能降级成有漏报的 tokenizer。

### 4.2 内容去重与 revision 规则

- 相同 <code>content_hash</code> 的文件内容只存一个 <code>source_blobs</code> row，即使出现在多个 repo/path/snapshot。
- <code>source_facts</code> 保存路径级分类和 coverage；同一内容在 vendor 路径与 source 路径可有不同策略。
- <code>effective_snapshot_sources</code> 与当前 <code>effective_snapshot_files</code> 并行：
  - source view 包含所有 discovered 路径；
  - graph view 只包含成功解析并产生 facts 的路径。
- base snapshot materialization 复制 mapping，不复制 blob。
- feature branch overlay 只记录 add/modify/delete；rename 同时保留 <code>renamed_from</code>。
- revision retention 删除 snapshot mapping 后，只有不被任何 source fact 引用的 blob 才进入 grace-period GC。
- 搜索必须先解析 effective source mapping，再 join blob；绝不能先搜所有 blob 后仅按 repo 名过滤，因为那会泄漏其他 revision 的旧内容。

Working tree 规则：

- dirty/untracked 内容属于 <code>revisionKind="working_tree"</code>，以 HEAD snapshot 为 base，加 source overlay。
- <code>worktreeFingerprint</code> 是排序后的 path + operation + content hash digest；同一文件集合产生稳定 fingerprint。
- locator 可同时给 HEAD <code>commitSha</code>，但不能把 working-tree hit 表述成“该 commit 中的代码”。
- <code>commitSha</code> 查询永远读取 git object，不混入 working tree。
- watcher 每次完成原子 batch 后发布新的 working-tree snapshot；正在构建的 snapshot 不可查询。

### 4.3 行号索引

创建 <code>packages/knowledge-core/src/line-index.ts</code>：

~~~typescript
export function encodeLineStarts(content: string): Buffer;
export function decodeLineStarts(encoded: Buffer): Uint32Array;
export function byteOffsetToLine(
  starts: Uint32Array,
  byteOffset: number,
): { line: number; column: number };
~~~

- DB 中的 <code>content</code> 是从原文件 encoding 解码后的 Unicode 文本，再以 canonical UTF-8 计算 locator；不改写 CRLF/LF，也不做 Unicode normalization。<code>content_hash</code> 仍基于原始文件 bytes。
- <code>startByte/endByte</code> 和 <code>line_starts</code> 都是 canonical UTF-8 byte offset，response 必须带 <code>offsetEncoding="utf8_normalized"</code>；line 为 1-based，column 为 1-based Unicode code point。UTF-16 原文件的消费者应优先使用 line/column。
- JS string index 是 UTF-16 code unit，不能直接当 byte offset；实现必须用 UTF-8 Buffer 搜索或显式 code-unit→UTF-8 mapping。
- <code>line_starts</code> 采用 little-endian uint32；canonical UTF-8 超过 4 GiB 的单文件按 <code>hard_size_limit</code> 明确排除。
- CRLF、LF、文件末尾无换行、emoji、CJK、UTF-16 BOM 都必须有固定测试。

---

## 5. AI 执行协议

每个实施 AI 在开始任一任务前都必须执行以下流程。

### 5.1 开始前

- [ ] 完整阅读当前会话提供的 AGENTS instructions；若 repo 根目录存在 <code>AGENTS.md</code>，再完整阅读该文件和本计划。当前基线中 repo 根没有实体 <code>AGENTS.md</code>，不能因此中断。
- [ ] 确认当前分支和工作树：<code>rtk git status --short --branch</code>。
- [ ] 不覆盖用户已有改动；若任务文件已有未知 diff，停止该文件并报告。
- [ ] 若 repo 根有 <code>.codegraph/</code>，先用 <code>rtk codegraph explore "问题或符号"</code>；随后用 <code>penguin context/search/flow</code> 交叉验证。
- [ ] 运行该任务列出的 baseline test，保存失败/通过摘要。
- [ ] 把当前任务 checkbox 标记为进行中；一次只处理一个 dependency-ready task。

### 5.2 每个子任务的 TDD 循环

1. 添加一个只表达当前契约的失败测试。
2. 运行最小测试，确认失败原因正是缺失能力，而不是 syntax/import/environment。
3. 写最小实现。
4. 重跑最小测试至绿色。
5. 运行受影响测试和 typecheck。
6. 用 <code>penguin affected</code> 或 CodeGraph blast radius 检查未覆盖调用者。
7. 更新计划 checkbox 和执行日志，列出文件、命令、结果、遗留风险。

### 5.3 禁止动作

- 不执行 git write 操作：<code>git add</code>、<code>git commit</code>、<code>git push</code>、rebase、merge、tag。
- 不发布 npm/Tauri release，不替换用户安装目录，不卸载 CodeGraph/Graphify。
- 不用 <code>--force</code>、删除 cache 或跳过 test 来制造绿色。
- 不把 failing test 改成更宽松的断言来接受错误行为。
- 不把 exact miss fallback 到 LLM 后宣称已找到。

### 5.4 阻塞报告格式

~~~text
BLOCKED
Task: Mx.y
Observed: 精确命令和输出摘要
Expected: 本计划中的验收条件
Root cause: 已验证事实；未知项明确写 unknown
Attempts: 已尝试的安全动作
Need from operator: 唯一需要的权限、选择或外部状态
Safe next task: 若有，可并行执行的 task ID
~~~

### 5.5 人工 checkpoint

每个主任务结束只输出建议 commit message，例如：

~~~text
Suggested commit: feat(knowledge): add universal source coverage manifest
~~~

AI 不执行 commit。操作者决定何时提交、合并和发布。

---

## 6. 能力清单与竞品覆盖矩阵

### 6.0 设计参考快照

实施者在 M0/M16 冻结具体 commit、release、配置和观察日期；不能用会变化的 README 当前页作为历史 benchmark 证据。

- [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
- [Understand Anything](https://github.com/Egonex-AI/Understand-Anything)
- [no-mistakes](https://github.com/kunchenguid/no-mistakes)
- [Cognee](https://github.com/topoteretes/cognee)
- [Strix](https://github.com/usestrix/strix)
- [Caveman](https://github.com/juliusbrussee/caveman)
- [Headroom](https://github.com/headroomlabs-ai/headroom)
- [Obsidian](https://obsidian.md/)

CodeGraph 和 Graphify 使用本机实际安装版本作为 differential baseline。M16 只认可可重放输出，不把产品宣传文字当成能力已验证。

### 6.1 必须吸收的能力

| 设计基线 | 要吸收的强项 | Penguin 对应任务 | 最终验证 |
|---|---|---|---|
| CodeGraph | 一次返回相关源码、call path、dynamic dispatch、affected | M4、M10 | exact corpus + graph flow corpus |
| Graphify | 全局多 repo 图、community、feedback、reflect、portable graph、token budget | M10、M13、M15 | multi-repo、feedback、artifact tests |
| codebase-memory-mcp | BM25、semantic、本地 embedding、Cypher-like graph、data flow、channels、IaC、GraphQL/tRPC/gRPC/HTTP、watch | M5、M10、M13 | protocol fixtures + watch tests |
| Understand Anything | domain flow、onboarding、guided tour、persona UI、claim extraction | M9、M12 | generated guide provenance review |
| Cognee | remember/recall/forget/improve、session/long-term、ontology、audit | M12、M14 | lifecycle and audit tests |
| Obsidian | Markdown、properties、wikilink、backlink、unlinked mention、Search DSL、local graph、Canvas | M11 | vault compatibility fixture |
| no-mistakes | isolated gate、review/test/docs/lint/CI、安全修复、人审 release | M16、M17 | release gate and rollback drill |
| Strix | validated finding、PoC/reproduction、static+dynamic evidence | M14 | evidence state machine tests |
| Headroom | 可逆 compact、原文补取、response stats | M1、M7 | compact/hydration parity |
| Caveman | terse mode | M6、M7 | compact CLI/MCP snapshots |

### 6.2 Canonical capability IDs

M1 必须一次性把以下 ID 加入 manifest，并为 required surface 注册 adapter：

~~~text
knowledge.repository.register
knowledge.search
knowledge.get_hit
knowledge.coverage
knowledge.capabilities
knowledge.index
knowledge.rebuild
knowledge.snapshot.materialize
knowledge.watch
knowledge.repository.remove
knowledge.branch.pin
knowledge.index_status
knowledge.set_master_branch
knowledge.snapshot.list
knowledge.get_node
knowledge.callers
knowledge.callees
knowledge.impact
knowledge.context
knowledge.explore
knowledge.locate
knowledge.explain
knowledge.flow
knowledge.affected
knowledge.path
knowledge.architecture
knowledge.service_graph
knowledge.local_graph
knowledge.graph.query
knowledge.repository_graph
knowledge.communities
knowledge.timeline
knowledge.recent
knowledge.compare_branches
knowledge.files
knowledge.file_symbols
knowledge.dead_code
knowledge.package_dependencies
knowledge.dependency_path
knowledge.analyze_repository
knowledge.response_sample.capture
knowledge.response_sample.list
knowledge.incident.create
knowledge.note.create
knowledge.note.append
knowledge.note.list
knowledge.note.reindex
knowledge.note.write
knowledge.note.backlinks
knowledge.tag.list
knowledge.link.create
knowledge.link.list
knowledge.link.delete
knowledge.source.register
knowledge.source.sync
knowledge.source.list
knowledge.source.remove
knowledge.memory.remember
knowledge.memory.recall
knowledge.memory.forget
knowledge.memory.improve
knowledge.ontology.list
knowledge.ontology.upsert
knowledge.ontology.link
knowledge.suggestion.list
knowledge.suggestion.accept
knowledge.suggestion.reject
knowledge.evidence.target.list
knowledge.evidence.investigation.plan
knowledge.evidence.investigation.capture
knowledge.evidence.note.get
knowledge.evidence.note.list
knowledge.evidence.status.set
knowledge.evidence.doctor
knowledge.evidence.repair
knowledge.evidence.validate
knowledge.api_doc.generate
knowledge.api_doc.list
knowledge.api_doc.show
knowledge.api_doc.diff
knowledge.api_doc.bind
knowledge.api_doc.unbind
knowledge.api_doc.draft
knowledge.api_doc.sync
knowledge.api_doc.repair
knowledge.api_doc.export
knowledge.saved_query.list
knowledge.saved_query.run
knowledge.saved_query.write
knowledge.why.get
knowledge.domain.explain
knowledge.onboarding.generate
knowledge.artifact.export
knowledge.artifact.import
knowledge.agent_hook.invoke
knowledge.cli.install
knowledge.doctor
~~~

Surface policy：

- 所有 ID 必须有 CLI 和 MCP adapter。
- Wiki 必须覆盖 search、get_hit、coverage、capabilities、index_status、get_node、context、explore、locate、flow、affected、architecture、service/local/repository graph、communities、timeline、compare_branches、files、file_symbols、note、memory、evidence、saved_query、why、domain、onboarding。
- index/rebuild/remove/import 等破坏性或长任务在 Wiki 可不提供，但 CLI/MCP 必须有确认/权限机制。
- 当前 CLI help 或 MCP tools/list 中任何不在 canonical list 的 Knowledge 操作会让 M1 test 失败；执行者必须判断它是 alias 还是新增 capability，不能静默忽略。

---

## 7. Phase 与依赖总览

~~~mermaid
flowchart TD
    M0[M0 Freeze baseline] --> M1[M1 Contracts and manifest]
    M1 --> M2[M2 Coverage discovery]
    M2 --> M3[M3 Source persistence and COW]
    M3 --> M4[M4 Deterministic retrieval]
    M4 --> M5[M5 Unified planner]
    M5 --> M6[M6 CLI parity]
    M5 --> M7[M7 MCP parity]
    M6 --> M8[M8 Resident runtime]
    M7 --> M8
    M8 --> M9[M9 Wiki global search]
    M5 --> M10[M10 Structural graph depth]
    M5 --> M11[M11 Markdown and Obsidian]
    M10 --> M12[M12 WHY domain memory]
    M11 --> M12
    M11 --> M13[M13 Semantic and feedback]
    M12 --> M14[M14 Evidence and security]
    M13 --> M14
    M14 --> M15[M15 Portable artifact]
    M9 --> M16[M16 Benchmarks and release gate]
    M10 --> M16
    M15 --> M16
    M16 --> M17[M17 Rollout and tool removal]
    M17 --> M18[M18 Final documentation]
~~~

优先级：

- P0：M0–M8、M16 的 universal retrieval 与 package parity 部分。
- P1：M9–M12。
- P2：M13–M15。
- 外部工具移除：只能在 M17。

估算是计划参考，不是 deadline：P0 约 4–6 周，P1 约 3–4 周，P2 和硬化约 3–5 周；单人顺序执行总计约 10–15 周。可并行项必须使用独立 worktree，并且不能同时修改 schema/query contracts。

---

## 8. 详细实施任务

## M0 — 冻结基线、失败语料与替代边界

**目标：** 在改动检索逻辑前，把当前“哪些通过、哪些漏报、哪些发布物漂移”变成可重复执行的机器证据。

**依赖：** 无。

**创建：**

- <code>docs/knowledge-v2/baseline-2026-07-17.md</code>
- <code>tests/fixtures/knowledge-universal-retrieval/</code>
- <code>tests/knowledge-universal-retrieval-baseline.test.mjs</code>
- <code>scripts/knowledge-baseline-snapshot.mjs</code>

**修改：**

- <code>package.json</code>：增加 <code>knowledge:baseline</code>。
- <code>docs/penguin-knowledge-strategy.md</code>：添加 superseded notice，只改冲突段，不删除历史内容。

### M0.1 建立固定 fixture

- [x] 创建至少以下文件，内容必须由 test 自己控制，不能依赖用户 <code>/Desktop/Projects</code>：
  - TypeScript：中文注释、局部变量、字符串常量、完整 dotted call。
  - YAML：无 Tree-sitter structural extraction 也必须全文可搜。
  - SQL：DDL、表名、注释。
  - Proto：service、rpc、field。
  - Markdown：properties、wikilink、普通文本。
  - 无扩展名文本文件。
  - UTF-16LE BOM 文本。
  - CRLF 文件。
  - 1.5 MB 文本文件，用于证明不再被旧 1 MB 门槛静默丢弃。
  - binary 文件，用 NUL byte 触发排除。
  - secret fixture，路径为 <code>.env</code>，只验证排除原因，内容使用假 token。
- [x] 每个 searchable fixture 写一份 <code>needles.json</code>，记录 query、mode、expected path、expected line、case sensitivity。
- [x] 每个 excluded fixture 写一份 <code>coverage-expectations.json</code>。

### M0.2 先写当前必败的 baseline test

测试必须断言当前实现的真实缺口：

~~~javascript
assert.equal(result.hits.length, 0);
assert.equal(result.knownGap, "full_source_not_indexed");
~~~

该断言只存在于 baseline test；M4 完成时删除“期望漏报”的断言，替换成 100% recall 验收。不能长期保留一个把错误行为视为绿色的测试。

- [x] 运行：

~~~bash
rtk test node --test tests/knowledge-universal-retrieval-baseline.test.mjs
~~~

**预期：** 测试通过并明确记录当前缺口，不允许只 snapshot 一个空数组而没有原因标签。

### M0.3 记录环境和产物哈希

<code>scripts/knowledge-baseline-snapshot.mjs</code> 输出稳定 JSON：

~~~json
{
  "capturedAt": "<ISO timestamp>",
  "git": { "branch": "<detected-branch>", "head": "<sha>", "dirty": false },
  "schemaVersion": 9,
  "sourceCapabilityHash": "<sha256>",
  "bundledCliHash": "<sha256>",
  "bundledMcpHash": "<sha256>",
  "installedMcpHash": "<sha256 or missing>",
  "tests": {},
  "knownMisses": []
}
~~~

- [x] 时间戳只出现在报告 metadata；用于 diff 的 capability/tool arrays 必须排序。
- [x] 不把 <code>~/.penguin</code> 的绝对路径和用户 token 写入 repo。
- [x] 执行：

~~~bash
rtk npm run knowledge:baseline
~~~

**预期：** 当前 installed MCP drift 被记录为 fail，但脚本本身以 0 退出；只有 <code>--gate</code> 才因 drift 非 0。

### M0.4 策略 supersession

- [x] 在旧 strategy 文档顶部增加日期、替代范围和本计划链接。
- [x] 明确写：外部 indexer 仅可作为迁移期 oracle；Penguin release correctness 不得依赖 adapter fallback。
- [x] 不删除旧设计理由，方便审计决策演变。

### M0 验收

~~~bash
rtk npm run knowledge:baseline
rtk npm run knowledge:benchmark
rtk npm run knowledge:benchmark:real
rtk git diff --check
~~~

**预期结果：**

- baseline JSON 可重复生成。
- 三个固定 miss 被机器记录。
- graph benchmark 仍绿。
- strategy 冲突有显式 supersession。

**建议 checkpoint：** <code>docs(knowledge): freeze universal retrieval baseline</code>

---

## M1 — 建立共享 contract 与 capability manifest

**目标：** 消除 CLI、MCP、Wiki 各自定义输入输出和能力清单的可能性。

**依赖：** M0。

**创建：**

- <code>packages/knowledge-contracts/package.json</code>
- <code>packages/knowledge-contracts/tsconfig.json</code>
- <code>packages/knowledge-contracts/src/index.ts</code>
- <code>packages/knowledge-contracts/src/search.ts</code>
- <code>packages/knowledge-contracts/src/coverage.ts</code>
- <code>packages/knowledge-contracts/src/capabilities.ts</code>
- <code>packages/knowledge-contracts/src/errors.ts</code>
- <code>packages/knowledge-contracts/src/cursor.ts</code>
- <code>tests/knowledge-contracts.test.mjs</code>
- <code>tests/knowledge-capability-manifest.test.mjs</code>
- <code>tests/knowledge-surface-parity.test.mjs</code>

**修改：**

- 根 <code>package.json</code>。
- <code>pnpm-lock.yaml</code>，仅由正常 <code>pnpm install</code> 更新。
- <code>packages/knowledge-core/package.json</code>。
- <code>packages/knowledge-cli/package.json</code>。
- <code>packages/mcp/package.json</code>。

### M1.1 先写 contract test

- [x] 测试 SearchRequest 拒绝空 query、limit 小于 1、limit 大于 200、同时指定互斥 revision。
- [x] 测试 unknown property 的处理策略：对外 contract 必须拒绝，而不是静默忽略 typo。
- [x] 测试 response schema 要求每个 hit 都有 revision 和 evidence。
- [x] 测试 compact response 仍保留最小可定位字段。
- [x] 运行：

~~~bash
rtk test node --test tests/knowledge-contracts.test.mjs
~~~

**预期失败：** <code>ERR_MODULE_NOT_FOUND: @penguin/knowledge-contracts</code>。

### M1.2 创建纯 contract package

- [x] package 不依赖 core、CLI、MCP、React 或 Tauri。
- [x] 使用现有 repo 的 schema validation 方案；若当前没有统一库，采用 TypeScript type + 手写无副作用 validator，避免为了几个对象引入大型 runtime。
- [x] 导出：

~~~typescript
export function validateSearchRequest(input: unknown): SearchRequest;
export function normalizeSearchRequest(input: SearchRequest): SearchRequest;
export function normalizeSearchResponse(input: SearchResponse): unknown;
export function capabilityHash(
  manifest: readonly CapabilityDefinition[],
): string;
~~~

- [x] normalization 对 object key 排序、warnings 排序、timings 归零，仅供 parity test；生产 response 保留真实 timing。
- [x] hash 输入只包括 capability 的稳定字段，不包括 build time。

### M1.3 填满 capability manifest

- [x] 完整加入第 6.2 节每个 ID。
- [x] 每个 mutating capability 必须声明 <code>confirmation: "required"</code> 或 <code>"not_required"</code>。
- [x] 每个 capability 必须绑定 input/output schema ID。
- [x] manifest 中 ID 唯一、排序稳定、version 大于 0。
- [x] 不允许注释占位或 wildcard capability。

### M1.4 建立 adapter registry contract

每个 surface 导出：

~~~typescript
export interface SurfaceRegistration {
  capabilityId: string;
  invoke(input: unknown, context: SurfaceContext): Promise<unknown>;
}

export function listCliRegistrations(): readonly SurfaceRegistration[];
export function listMcpRegistrations(): readonly SurfaceRegistration[];
export function listWikiRegistrations(): readonly SurfaceRegistration[];
~~~

M1 只接入现有命令/tool，不要求此刻实现未来能力；尚未实现的 capability 以明确 <code>NOT_IMPLEMENTED</code> registration 存在，并使 release gate 失败。开发态 list 可以看到缺口，不能假装不存在。

### M1.5 parity test

- [x] 断言 manifest requiredOn CLI/MCP 的集合与 registration 集合完全相等。
- [x] 断言不存在 surface 私有的同义能力；CLI/MCP tool aliases 统一经共享 `CAPABILITY_ALIASES`/canonical resolver，且 parity test 覆盖。
- [x] 断言每个 adapter 的 output 都通过对应 schema validator；97 个 manifest capability 均注册 output validator，Search 使用严格 response schema，其余输出先执行统一 JSON 边界校验。
- [x] 断言 source manifest hash 可由 CLI <code>penguin capabilities --json</code> 和 MCP <code>knowledge_capabilities</code> 读取。

### M1 验收

~~~bash
rtk test node --test \
  tests/knowledge-contracts.test.mjs \
  tests/knowledge-capability-manifest.test.mjs \
  tests/knowledge-surface-parity.test.mjs
rtk npm run typecheck
rtk git diff --check
~~~

**预期结果：**

- 共享 package 编译通过。
- manifest 无重复、无漏 surface。
- 未实现项可见且会阻断 release，不阻断后续开发态构建。

**建议 checkpoint：** <code>feat(knowledge): add canonical contracts and capability manifest</code>

---

## M2 — 建立完整文件发现与 coverage manifest

**目标：** 先精确回答“应该索引哪些文件、哪些被排除、为什么”，再谈检索。

**依赖：** M1。

**创建：**

- <code>packages/knowledge-indexer/src/coverage-policy.ts</code>
- <code>packages/knowledge-indexer/src/text-classifier.ts</code>
- <code>packages/knowledge-indexer/src/coverage.ts</code>
- <code>packages/knowledge-indexer/src/encoding.ts</code>
- <code>tests/knowledge-coverage-policy.test.mjs</code>
- <code>tests/knowledge-text-classifier.test.mjs</code>
- <code>tests/knowledge-walk-git-truth.test.mjs</code>

**修改：**

- <code>packages/knowledge-indexer/src/walk.ts</code>
- <code>packages/knowledge-indexer/src/registry.ts</code>
- <code>packages/knowledge-indexer/src/pipeline.ts</code>
- <code>packages/knowledge-indexer/src/index.ts</code>
- <code>tests/knowledge-minified.test.mjs</code>
- <code>tests/knowledge-indexer-pipeline.test.mjs</code>

### M2.1 先写 discovery tests

- [x] 创建临时 git repo，覆盖 tracked、untracked、ignored、deleted、symlink、submodule entry、nested gitignore。
- [x] 断言 candidate truth 来自：

~~~bash
rtk git -C <repo> ls-files --cached --others --exclude-standard -z
~~~

- [x] 另行用以下命令只收集 ignored metadata，不读取其内容：

~~~bash
rtk git -C <repo> ls-files --others --ignored --exclude-standard -z
~~~

- [x] 断言路径使用 repo-relative POSIX slash，拒绝 <code>..</code> escaping。
- [x] 断言 symlink 只记录 link 本身；目标超出 repo 时标记 <code>outside_workspace</code>。
- [x] 运行最小 test；旧 walker 的 submodule gitlink 边界已被测试捕获并修复，当前 discovery fixture 全部通过。

### M2.2 固定 coverage policy

实现：

~~~typescript
export interface CoveragePolicy {
  includeUntracked: boolean;
  includeIgnoredMetadata: boolean;
  exactSearchGenerated: boolean;
  exactSearchVendor: boolean;
  ignoredMetadataMaxEntries: number;
  secretPaths: string[];
  hardFileSizeBytes: number;
  sampleBytes: number;
}

export const DEFAULT_COVERAGE_POLICY: CoveragePolicy = {
  includeUntracked: true,
  includeIgnoredMetadata: true,
  exactSearchGenerated: true,
  exactSearchVendor: true,
  ignoredMetadataMaxEntries: 10_000,
  secretPaths: [
    ".env",
    ".env.*",
    "**/*.pem",
    "**/*.key",
    "**/credentials.json",
  ],
  hardFileSizeBytes: 4_294_967_295,
  sampleBytes: 65_536,
};
~~~

规则优先级固定：

1. workspace/path escape；
2. secret policy；
3. binary detection；
4. encoding support；
5. hard size limit；
6. vendor/generated classification；
7. admitted。

用户 config 可更严格；放宽 secret policy 必须显式 local trusted flag，MCP server 默认不能放宽。

默认策略必须让所有 tracked 或 unignored 的文本文件进入 exact/path corpus，包括 generated/vendor/minified；这些分类可以默认不进入结构图和 semantic lane，但不能破坏“repo 中的文本源码一定可 exact 找到”。被 git ignore 的 dependency/build tree 只记录 bounded metadata，除非用户显式纳入。

ignored metadata 达到上限时停止枚举并写 <code>IGNORED_METADATA_TRUNCATED</code> warning；这不降低 admitted corpus 的完整性，但 UI 不能宣称已列出所有 ignored path。

### M2.3 文本与 encoding 判定

- [x] NUL sample 默认 binary；UTF-16 BOM 除外。
- [x] 支持 UTF-8、UTF-8 BOM、UTF-16LE、UTF-16BE，统一解码成 JS string，hash 仍基于原始 bytes。
- [x] invalid UTF-8 且无支持 BOM：<code>unsupported_encoding</code>。
- [x] 大文件流式 hash 和解码，不一次创建多份 Buffer；`hashFileStream`/`decodeTextFileStream` 已接入 indexer pipeline 并有 UTF-8/UTF-16 回归测试。
- [x] minified/generated/vendor 只影响 classification 和默认 lane，不再导致 coverage 消失。
- [x] YAML、YML、SQL、Proto、Markdown、TOML、Dockerfile、无扩展名文本都可 admitted，即使 parser 不支持。

### M2.4 walker 输出新 contract

~~~typescript
export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  gitState: "tracked" | "untracked" | "ignored";
  byteSize: number;
  classification: CoverageRecord["classification"];
  coverageStatus: CoverageRecord["status"];
  reasonCode: CoverageReasonCode;
  reason: string;
  encoding?: CoverageRecord["encoding"];
}
~~~

- [x] walker 不读取 ignored secret 内容。
- [x] 所有 file path 都产生一条 coverage record。
- [x] pipeline 的 <code>skipped</code> 已拆成 coverage status 与 parser status；`coverage_records` 持久化 parsed/unsupported/failed/not_applicable，unsupported parser 不等于 source excluded。

### M2.5 CLI 暂存诊断

在 M6 完整 CLI 前，先让内部 API 可输出：

~~~json
{
  "discovered": 123,
  "admitted": 110,
  "excluded": 12,
  "failed": 1,
  "byReason": {
    "binary": 4,
    "secret_policy": 2,
    "vendor_policy": 6,
    "read_error": 1
  }
}
~~~

- [x] 内部 `discoverRepoCoverage()` 与 `summarizeCoverage()` 已提供 discovered/admitted/excluded/failed/stale/byReason 诊断数据；CLI 展示仍留到 M6。

### M2 验收

~~~bash
rtk test node --test \
  tests/knowledge-coverage-policy.test.mjs \
  tests/knowledge-text-classifier.test.mjs \
  tests/knowledge-walk-git-truth.test.mjs \
  tests/knowledge-minified.test.mjs \
  tests/knowledge-indexer-pipeline.test.mjs
rtk npm run typecheck
~~~

**预期结果：**

- discovery count 等于 git truth 加 ignored metadata。
- 1.5 MB text admitted。
- unsupported parser 仍是 source admitted。
- 每个未 admitted 文件都有稳定 reason code。

**建议 checkpoint：** <code>feat(knowledge): add auditable source coverage discovery</code>

---

## M3 — 内容寻址源码存储、schema migration 与 snapshot COW

**目标：** 把所有 admitted 文本持久化成 revision-aware、可去重、可回收的 source corpus。

**依赖：** M2。

**创建：**

- <code>packages/knowledge-core/src/source-store.ts</code>
- <code>packages/knowledge-core/src/source-cow.ts</code>
- <code>packages/knowledge-core/src/line-index.ts</code>
- <code>packages/knowledge-indexer/src/source-ingest.ts</code>
- <code>tests/knowledge-source-schema.test.mjs</code>
- <code>tests/knowledge-source-store.test.mjs</code>
- <code>tests/knowledge-source-cow.test.mjs</code>
- <code>tests/knowledge-line-index.test.mjs</code>
- <code>tests/knowledge-source-backfill.test.mjs</code>

**修改：**

- <code>packages/knowledge-core/src/schema.ts</code>
- <code>packages/knowledge-core/src/store.ts</code>
- <code>packages/knowledge-core/src/index.ts</code>
- <code>packages/knowledge-core/src/materializer.ts</code>
- <code>packages/knowledge-core/src/revision-retention.ts</code>
- <code>packages/knowledge-indexer/src/pipeline.ts</code>
- <code>packages/knowledge-indexer/src/base-snapshot.ts</code>
- <code>packages/knowledge-indexer/src/revision-indexer.ts</code>

### M3.1 先写 schema 与 integrity tests

- [x] 从空 DB 创建当前 schema v13（包含 v10 source corpus 层；当前版本已 supersede 计划初始的 v10 标签）。
- [x] v9-labelled fixture migration 到当前 schema，不丢现有 nodes/edges/file_facts。
- [x] migration 重跑两次结果相同。
- [x] 用显式 SQL 断言没有：
  - source fact 指向不存在 blob；
  - effective mapping 指向不存在 source fact；
  - file_fact_sources 指向不存在任一端；
  - FTS rowid 指向不存在 blob。
- [x] 初始 v9 失败预期已被当前 migration ladder 取代；现行测试验证 v9-labelled DB 自动迁移到 schema v13 且 graph/source integrity 保持不变。

### M3.2 实现 SourceStore 单一事务边界

~~~typescript
export class SourceStore {
  putBlob(input: {
    contentHash: string;
    rawBytes: Uint8Array;
    decodedContent: string;
    encoding: string;
  }): number;

  putSourceFact(input: {
    repoId: string;
    filePath: string;
    factFingerprint: string;
    contentHash?: string;
    sourceBlobId?: number;
    coverage: CoverageRecord;
  }): string;

  attachFileFact(fileFactId: string, sourceFactId: string): void;
  getEffectiveSource(
    snapshotId: string,
    filePath: string,
  ): EffectiveSource | undefined;
}
~~~

- [x] <code>putBlob</code>、line index、trigram FTS、lexical FTS 在一个 transaction。
- [x] lexical text 通过 camel/snake/kebab 拆词生成；原 content 不被改写。
- [x] 同 hash 再插入返回原 blob ID，且核对 byte size；hash collision mismatch 抛 <code>CONTENT_HASH_COLLISION</code>。
- [x] path FTS 在 source fact transaction 更新。

### M3.3 接入 snapshot COW

- [x] 为 base snapshot materialize <code>effective_snapshot_sources</code>。
- [x] feature snapshot 从 base mapping 开始，仅应用 source overlay。
- [x] delete 后当前 snapshot 搜不到，base snapshot 仍可搜。
- [x] rename 让新路径可搜，旧路径只在旧 snapshot 或 timeline/alias 查询出现。
- [x] graph file fact 可缺失，但 source fact 必须存在；source COW test 覆盖无 file-fact mapping 仍可 exact source 检索。
- [x] 同内容跨分支只增加 mapping，不增加 blob。
- [x] dirty tracked edit 和 untracked file 进入独立 working-tree overlay；dirty snapshot identity 包含 worktree fingerprint，同 HEAD 的 commit snapshot 不看到它们。

### M3.4 backfill

新增内部入口：

~~~typescript
export async function backfillSourceCorpus(options: {
  repoId?: string;
  batchSize: number;
  resumeAfter?: string;
  dryRun: boolean;
}): Promise<BackfillReport>;
~~~

- [x] backfill 不尝试从旧 <code>facts_json</code> 重建全文，必须重新读取对应 checkout。
- [x] 每 batch transaction 后写 checkpoint，可中断恢复。
- [x] checkout 与 snapshot commit 不一致时，不写错误内容，记录 <code>revision_content_unavailable</code>。
- [x] master/current working tree 可正常回填；历史 snapshot 内容需从 <code>git show &lt;sha&gt;:&lt;path&gt;</code> 流式读取。
- [x] dry-run 输出预计文件数、bytes、DB growth，不写 DB。

### M3.5 retention 和 GC

- [x] revision collection 同时清理 effective source mapping 和 source overlays。
- [x] source fact 只有在没有任何 effective mapping/overlay 引用且过 grace period后清理。
- [x] blob 只有在没有 source fact 引用且过 grace period后清理。
- [x] 删除 blob 时同步删除两个 source FTS row。
- [x] GC 前后运行 orphan SQL；`applyRevisionCollection` 在 transaction 前后 fail-closed 检查 source/FTS orphan。

### M3 验收

~~~bash
rtk test node --test \
  tests/knowledge-source-schema.test.mjs \
  tests/knowledge-source-store.test.mjs \
  tests/knowledge-source-cow.test.mjs \
  tests/knowledge-line-index.test.mjs \
  tests/knowledge-source-backfill.test.mjs \
  tests/knowledge-revision-retention.test.mjs \
  tests/knowledge-file-facts.test.mjs
rtk npm run typecheck
~~~

**预期结果：**

- v9 数据无损迁移。
- unsupported file 在 effective source view 存在。
- 内容按 hash 去重。
- branch/delete/rename/GC 隔离全部通过。

**建议 checkpoint：** <code>feat(knowledge): persist revision-aware source corpus</code>

---

## M4 — 确定性 exact、path、phrase、substring、regex 检索

**目标：** 首次兑现“coverage admitted 的代码一定找得到”。

**依赖：** M3。

**创建：**

- <code>packages/knowledge-core/src/source-search.ts</code>
- <code>packages/knowledge-core/src/source-snippet.ts</code>
- <code>packages/knowledge-core/src/path-search.ts</code>
- <code>packages/knowledge-core/src/regex-search.ts</code>
- <code>tests/knowledge-source-search.test.mjs</code>
- <code>tests/knowledge-path-search.test.mjs</code>
- <code>tests/knowledge-regex-search.test.mjs</code>
- <code>tests/knowledge-source-search-revision.test.mjs</code>

**修改：**

- <code>packages/knowledge-core/src/query.ts</code>
- <code>packages/knowledge-core/src/schema.ts</code>：注册 schema v11 的 Markdown 结构索引。
- <code>packages/knowledge-core/src/store.ts</code>
- <code>packages/knowledge-core/src/index.ts</code>
- <code>packages/knowledge-core/package.json</code>：加入锁定版本的 <code>re2-wasm</code>。
- <code>scripts/bundle-knowledge-cli.mjs</code>。
- <code>scripts/vendor-knowledge-runtime.mjs</code>。
- <code>tests/knowledge-universal-retrieval-baseline.test.mjs</code>。

### M4.1 先把固定漏报改成正确性测试

测试至少包含：

~~~javascript
{
  mode: "exact",
  query: "playerAdditionalDetailRepository.findAllByCpf",
  expectedPath: "apps/player/src/player/player.service.ts"
}
{
  mode: "phrase",
  query: "入口日志只记 platformId",
  expectedLine: 42
}
{
  mode: "path",
  query: "libs/tools/src/vault/types/legitimuz-config.type.ts"
}
{
  mode: "substring",
  query: "绝不回显明文 cpf(PII)"
}
~~~

- [x] 原始 source-search 缺口已被同一 fixture 的正确性测试取代；当前测试不再把漏报当作绿色结果。
- [x] M0 的“期望空结果”临时断言已删除；`knowledge-universal-retrieval-baseline.test.mjs` 现在断言真实 call-site source hit。

### M4.2 exact/substring candidate 与最终验证

实现：

~~~typescript
export interface SourceSearchOccurrence {
  sourceFactId: string;
  blobId: number;
  filePath: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  snippet: string;
}

export function searchSource(
  store: KnowledgeStore,
  scope: ResolvedRevisionScope,
  request: SearchRequest,
): SourceSearchOccurrence[];
~~~

算法固定：

1. 从 resolved snapshot 的 <code>effective_snapshot_sources</code> 取得允许的 blob rowid 集合。
2. query 长度至少 3 个 code point 时，用 trigram MATCH 取 candidate blob。
3. query 长度 1–2、trigram 无法表达的纯标点，或 FTS 返回语法错误时，扫描 scope 内全部 admitted blob；diagnostics 标记 <code>short_query_full_scan</code>。
4. 对每个 candidate 的 decoded content 使用明确 case/normalization 规则做最终验证；case-sensitive exact 优先在 canonical UTF-8 Buffer 上搜索。若使用 JS string 查找，必须把 UTF-16 code-unit index 显式转换为 UTF-8 byte offset。
5. 返回每个 occurrence，而不是每文件只留第一个；分页 stable key 是 repo/snapshot/path/startByte。
6. 用 line index 计算行列，snippet 默认前后各 2 行，最大 4 KiB。

正确性规则：

- Candidate 过滤可以多召回，绝不能漏召回。
- FTS score 不等于 exact proof；只有 raw content 验证后才能标记 <code>verified</code>。
- 默认不做 Unicode NFKC 改写；<code>caseSensitive=false</code> 使用 Unicode simple case fold，并在 diagnostics 写 normalization。
- exact/phrase/substring 的 CLI 默认 <code>caseSensitive=true</code>；用户显式传 case-insensitive 时，扫描器必须保留 folded index 到原文 UTF-8 offset 的映射。
- 同一 blob 映射多个 path 时，每个有效 path 都是独立 hit。

### M4.3 path search

- [x] exact relative path 排第一；path-search 回归测试覆盖 exact 与 basename/suffix 候选排序。
- [x] 然后 basename exact、suffix、segment phrase、lexical fuzzy；当前实现覆盖 basename/suffix/segment substring，fuzzy 仍是明确 lexical substring。
- [x] 查询可使用 <code>\</code>，normalize 成 slash；不允许解析成 repo 外路径。
- [x] path index 包含 excluded metadata；excluded path hit 的 lane 为 path、`metadataOnly=true`，不提供文件内容。
- [x] revision delete/rename 正确；source COW 与 path/source revision regression 覆盖旧 snapshot 保留、新 snapshot 删除/新路径可见。

### M4.4 regex

- [x] 使用 <code>re2-wasm</code>，禁止原生 JS RegExp 执行用户输入。
- [x] 只启用 RE2 支持语法；lookbehind/backreference 返回 <code>REGEX_UNSUPPORTED</code>，带位置和文档建议。
- [x] 从 regex 提取最长 literal 作为 trigram candidate；无法提取时扫描 scope admitted blob。
- [x] 每请求有 max scanned bytes 和 deadline，但命中完整性模式下达到预算返回显式 <code>SEARCH_BUDGET_EXCEEDED</code>，不能返回看似完整的部分结果。
- [x] <code>allowPartial=true</code> 只作为显式高级选项，response <code>truncated=true</code>。
- [x] vendor runtime test 证明 RE2 WASM/package 被 CLI/MCP self-contained bundle 包含并可由 vendored Node 加载。

### M4.5 revision/security filter

- [x] SQL candidate query 先限定 effective snapshot mapping；禁止把全局 FTS 命中内容先 materialize 到 JS 后才过滤。
- [x] repo/workspace allow-list 在读取 blob content 前生效。
- [x] excluded secret 路径只能返回 metadata，不返回 snippet。
- [x] cursor 绑定 snapshot。

### M4.6 性能索引

- [x] 用 <code>EXPLAIN QUERY PLAN</code> 测试 typical exact/path query 不全扫 <code>source_facts</code>。
- [x] trigram candidate SQL 使用 snapshot-scoped join、bounded trigram placeholders，不拼接不受限 scope IDs。
- [x] scope blob ID 去重，避免同 blob 多 path 重复验证；验证后展开有效 path。
- [x] 搜索取消信号能在 candidate batch 间中断。

### M4 验收

~~~bash
rtk test node --test \
  tests/knowledge-source-search.test.mjs \
  tests/knowledge-path-search.test.mjs \
  tests/knowledge-regex-search.test.mjs \
  tests/knowledge-source-search-revision.test.mjs \
  tests/knowledge-universal-retrieval-baseline.test.mjs \
  tests/knowledge-runtime-doctor.test.mjs
rtk npm run typecheck
rtk npm run knowledge:bundle
~~~

手工 smoke：

~~~bash
rtk penguin search \
  --mode exact \
  'playerAdditionalDetailRepository.findAllByCpf' \
  --repo FPMS-NT-Auth-Player \
  --json

rtk penguin search \
  --mode path \
  'libs/tools/src/vault/types/legitimuz-config.type.ts' \
  --json

rtk penguin search \
  --mode phrase \
  '入口日志只记 platformId' \
  --repo FPMS-NT-Auth-Player \
  --json
~~~

**预期结果：**

- 三个原始 miss 均返回正确 path/revision/line。
- parser unsupported fixture 可搜。
- secret fixture 只有 path metadata。
- bundled runtime 能加载 regex WASM。

**建议 checkpoint：** <code>feat(knowledge): guarantee deterministic source retrieval</code>

---

## M5 — 统一 Query Planner、排序、诊断与游标

**目标：** 把全文、路径、symbol、graph、note、semantic、evidence 合并为一个可解释、可分页、revision-safe 的核心查询。

**依赖：** M4。

**创建：**

- <code>packages/knowledge-core/src/search-engine.ts</code>
- <code>packages/knowledge-core/src/search-planner.ts</code>
- <code>packages/knowledge-core/src/search-ranking.ts</code>
- <code>packages/knowledge-core/src/search-diagnostics.ts</code>
- <code>packages/knowledge-core/src/search-cursor.ts</code>
- <code>packages/knowledge-core/src/lexical-normalize.ts</code>
- <code>tests/knowledge-search-engine.test.mjs</code>
- <code>tests/knowledge-search-ranking.test.mjs</code>
- <code>tests/knowledge-search-diagnostics.test.mjs</code>
- <code>tests/knowledge-search-cursor.test.mjs</code>
- <code>tests/knowledge-search-scope.test.mjs</code>

**修改：**

- <code>packages/knowledge-core/src/query.ts</code>
- <code>packages/knowledge-core/src/store.ts</code>
- <code>packages/knowledge-core/src/revision-scope.ts</code>
- <code>packages/knowledge-core/src/index.ts</code>
- <code>tests/knowledge-core-search.test.mjs</code>
- <code>tests/knowledge-query.test.mjs</code>
- <code>tests/knowledge-revision-isolation.test.mjs</code>

### M5.1 先写端到端核心请求测试

用同一个 fixture 同时产生 source、symbol、edge、note hit：

- [x] exact call expression 必须是第 1。
- [x] exact path 必须高于 basename fuzzy。`search-engine` 与 `knowledge-path-search` fixture 验证 exact full path boost/rank。
- [x] symbol exact 高于 lexical partial；`knowledge-search-engine.test.mjs` 插入真实 symbol/index/version fixture 并断言 exact symbol 排序与 rank reason。
- [x] semantic result 即使 cosine 更高，也不能高于 verified exact。
- [x] 相同 locator 从多个 lane 返回时合并为一个 hit，evidence 合并。
- [x] 无结果 response 仍包含 resolved scope、coverage 和 searched lanes。
- [ ] 先运行，预期旧 <code>query.search</code> 返回旧 shape 或排序失败。

### M5.2 Query Planner

实现：

~~~typescript
export interface SearchPlan {
  request: SearchRequest;
  scopes: ResolvedRevisionScope[];
  stages: Array<{
    lane: SearchLane;
    required: boolean;
    reason: string;
    budgetMs: number;
  }>;
}

export function planSearch(
  request: SearchRequest,
  context: SearchContext,
): SearchPlan;

export async function searchKnowledge(
  request: SearchRequest,
  context: SearchContext,
): Promise<SearchResponse>;
~~~

<code>auto</code> 固定规划：

1. path heuristic：query 含 slash、常见扩展名或 basename pattern 时启用。
2. source exact/substring：始终启用。
3. lexical source + existing symbol/note FTS：始终启用。
4. structural：query 可解析成 symbol/route/service 或明确 kind filter 时启用。
5. evidence：有 evidence kind/filter 或 incident intent 时启用。
6. semantic：
   - <code>off</code>：不启用；
   - <code>fallback</code>：前述 lane 无命中才启用；
   - <code>blend</code>：并发启用。

Planner 决策必须进入 diagnostics。

### M5.3 lexical normalization

- [x] <code>playerAdditionalDetailRepository</code> 生成原词及 player/additional/detail/repository。
- [x] <code>find_all_by_cpf</code>、<code>find-all-by-cpf</code>、<code>FindAllByCpf</code> 生成可比 token。
- [x] 不丢 CJK bigram；原始 phrase 仍保留。
- [x] 用户双引号 phrase 不拆开。
- [x] 查询运算符只在明确 DSL 模式解析；普通代码字符 <code>:</code>、<code>()</code> 不应误当 filter。

### M5.4 排序

使用 lane 内 rank + weighted reciprocal rank fusion，之后应用确定性 boost：

~~~typescript
export const LANE_WEIGHTS = {
  source: 1.0,
  path: 1.0,
  symbol: 0.85,
  graph: 0.8,
  note: 0.7,
  evidence: 0.75,
  semantic: 0.55,
} as const;
~~~

确定性 boost 顺序：

1. exact full path；
2. exact source occurrence；
3. exact symbol name；
4. basename/suffix；
5. phrase；
6. lexical；
7. structural proximity；
8. reviewed note/runtime evidence；
9. semantic inference。

- [x] tie-break 固定为 repo name、revision ID、file path、line、hit ID。
- [x] 每个 hit 的 <code>rankReasons</code> 写实际 boost 和 lane rank。
- [x] semantic score 不与 BM25 直接相加；先归一化到独立 semantic lane rank。
- [x] duplicate 合并 key 使用 revision + path + byte range；symbol node 可额外合并同 locator。

### M5.5 diagnostics

固定 warning/error code：

~~~text
NO_MATCH
SCOPE_EMPTY
REPOSITORY_NOT_FOUND
REVISION_NOT_FOUND
INDEX_STALE
COVERAGE_INCOMPLETE
EXCLUDED_FILES_MATCH_PATH
SHORT_QUERY_FULL_SCAN
SEMANTIC_UNAVAILABLE
REGEX_UNSUPPORTED
SEARCH_BUDGET_EXCEEDED
CURSOR_STALE
CAPABILITY_MISMATCH
~~~

- [x] <code>NO_MATCH</code> 建议最多 5 个，来源只能是 path/symbol spell candidates 或更宽 mode，不调用 LLM。
- [x] 若 query 在 excluded path metadata 中命中，empty source results 必须提示该路径和 reason。
- [x] 若 repo 未 index，不返回普通空数组，返回 typed error。
- [x] coverage stale/failed 时 <code>totalIsExact=false</code>，即使当前 page 有 hit。

### M5.6 Cursor

- [x] cursor HMAC secret 来自本地 runtime ephemeral/config secret，不写日志。
- [x] page 2 不重复 page 1，也不漏同分 hit。
- [x] request filter、snapshot、capability hash 任一变化时拒绝旧 cursor。
- [x] cursor tamper 返回 <code>CURSOR_INVALID</code>，不泄漏 HMAC detail。
- [x] total 默认不做昂贵精确 count；只有 deterministic bounded query 可给 <code>totalIsExact=true</code>。

### M5.7 兼容旧 API

- [ ] 旧 <code>query.search(text, options)</code> 变成薄 wrapper，内部构造 SearchRequest。
- [ ] wrapper response 在一个 deprecation window 内保持现有字段，同时附带 v2 response；CLI/MCP 新能力直接用 v2。
- [ ] 在 docs 写 removal version，不在本任务删除旧调用。

### M5 验收

~~~bash
rtk test node --test \
  tests/knowledge-search-engine.test.mjs \
  tests/knowledge-search-ranking.test.mjs \
  tests/knowledge-search-diagnostics.test.mjs \
  tests/knowledge-search-cursor.test.mjs \
  tests/knowledge-search-scope.test.mjs \
  tests/knowledge-core-search.test.mjs \
  tests/knowledge-query.test.mjs \
  tests/knowledge-revision-isolation.test.mjs
rtk npm run typecheck
~~~

**预期结果：**

- 一个 core function 产出完整 v2 response。
- 空结果不再不可解释。
- exact 永远高于 semantic。
- cursor revision-safe。

**建议 checkpoint：** <code>feat(knowledge): unify retrieval planning ranking and diagnostics</code>

---

## M6 — CLI 全能力覆盖与稳定机器接口

**目标：** CLI 成为 canonical contract 的完整、可脚本化适配面；所有能力有 JSON、compact、错误码和 help。

**依赖：** M5。

**创建：**

- <code>packages/knowledge-cli/src/command-registry.ts</code>
- <code>packages/knowledge-cli/src/commands/search.ts</code>
- <code>packages/knowledge-cli/src/commands/coverage.ts</code>
- <code>packages/knowledge-cli/src/commands/capabilities.ts</code>
- <code>packages/knowledge-cli/src/commands/get-hit.ts</code>
- <code>packages/knowledge-cli/src/output.ts</code>
- <code>packages/knowledge-cli/src/errors.ts</code>
- <code>tests/knowledge-cli-search-v2.test.mjs</code>
- <code>tests/knowledge-cli-capability-parity.test.mjs</code>
- <code>tests/knowledge-cli-json-contract.test.mjs</code>

**修改：**

- <code>packages/knowledge-cli/src/index.ts</code>
- <code>packages/knowledge-cli/src/bin.ts</code>
- <code>packages/knowledge-cli/src/render-progress.ts</code>
- <code>packages/knowledge-cli/package.json</code>
- <code>tests/knowledge-cli.test.mjs</code>
- <code>tests/knowledge-cli-render.test.mjs</code>
- <code>tests/knowledge-cli-multirepo.test.mjs</code>

### M6.1 先写 CLI contract tests

- [x] 对同一 SearchRequest，直接 core 调用与 CLI <code>--json</code> normalization 相等。
- [x] JSON 模式 stdout 只有一个 JSON document；progress、warning、diagnostic log 只能到 stderr。
- [x] typed error 仍输出 JSON error envelope，并使用稳定 exit code。
- [x] compact 模式保留 locator/coverage/cursor。
- [x] help 列出所有 canonical capability 或对应 command。
- [ ] 先运行，预期 capability parity 因未来命令缺失而失败。

### M6.2 命令映射

新增/固定：

~~~text
rtk penguin search <query>
rtk penguin get-hit <hit-id>
rtk penguin coverage
rtk penguin capabilities
rtk penguin saved-query list|run|write
rtk penguin memory remember|recall|forget|improve
rtk penguin evidence get|list|validate
rtk penguin why <target>
rtk penguin domain <target>
rtk penguin onboarding <repo>
rtk penguin artifact export|import
rtk penguin doctor
~~~

现有命令保留，但 command registry 必须为每个命令声明 canonical capability ID。alias 例如 <code>calls</code>/<code>callees</code> 指向同一 ID。

### M6.3 search flags

~~~text
--mode auto|exact|phrase|substring|path|regex|lexical|semantic|structural
--repo <name-or-id>             repeatable
--workspace <id>
--branch <name>
--snapshot <id>
--commit <sha>
--working-tree
--path <glob>                   repeatable
--language <name>               repeatable
--kind <kind>                   repeatable
--case-sensitive
--whole-word
--include-generated
--include-vendor
--include-excluded-metadata
--semantic off|fallback|blend
--limit <1..200>
--cursor <token>
--compact
--explain
--json
~~~

- [x] <code>--snapshot</code>、<code>--commit</code>、<code>--working-tree</code> 的互斥在 parser 层报错；branch 可与 working tree 组合用于确认所属分支。
- [x] repo flag 可重复，不用逗号隐式拆名称。
- [x] 未指定 scope 且 cwd 在已 index repo 时默认当前 repo 的最新 ready working-tree snapshot；若只有 commit snapshot，使用当前 branch snapshot并警告。cwd 不属于 repo 时默认配置 workspace，并在 diagnostics 明示。
- [x] human output 第一行给 hit count/coverage，后续 path:line、lane、snippet；颜色只在 TTY。
- [x] <code>--compact --json</code> 是机器 compact，不是删除诊断。

### M6.4 稳定 error envelope 与 exit code

~~~json
{
  "ok": false,
  "error": {
    "code": "REVISION_NOT_FOUND",
    "message": "Revision was not found",
    "details": {},
    "retryable": false
  }
}
~~~

固定：

- 0：成功，包括合法的 NO_MATCH response。
- 2：usage/validation。
- 3：scope/index not found。
- 4：coverage/runtime unavailable。
- 5：internal corruption。
- 6：confirmation required/denied。

### M6.5 长任务与确认

- [x] index/rebuild/import/remove 等通过 progress event 到 stderr。
- [x] <code>--json</code> 可加 <code>--events-jsonl</code>，此时 stdout 是 JSONL events，最后一个事件为 result。
- [x] mutating command 非交互环境必须有 <code>--confirm &lt;operation-token&gt;</code>，不能只用通用 <code>--yes</code>。
- [x] dry-run 对 rebuild/import/remove 强制可用。

### M6.6 拆小 index.ts

- [ ] <code>index.ts</code> 只保留 registry assembly、argument parse、dispatch。
- [ ] 每个 command module 不直接 <code>process.exit</code>。
- [ ] core error 统一在 CLI boundary 映射。
- [ ] command tests 可传 fake IO，不 spawn process。

### M6 验收

~~~bash
rtk test node --test \
  tests/knowledge-cli-search-v2.test.mjs \
  tests/knowledge-cli-capability-parity.test.mjs \
  tests/knowledge-cli-json-contract.test.mjs \
  tests/knowledge-cli.test.mjs \
  tests/knowledge-cli-render.test.mjs \
  tests/knowledge-cli-multirepo.test.mjs
rtk npm run typecheck
rtk npm run knowledge:bundle
~~~

Smoke：

~~~bash
rtk penguin capabilities --json
rtk penguin coverage --repo FPMS-NT-Auth-Player --json
rtk penguin search \
  --mode exact \
  --repo FPMS-NT-Auth-Player \
  --compact \
  --json \
  'playerAdditionalDetailRepository.findAllByCpf'
~~~

**预期结果：**

- CLI required capabilities 缺失数为 0。
- stdout JSON 可直接 parse。
- search 返回正确 path/line 和 coverage。

**建议 checkpoint：** <code>feat(knowledge): expose complete canonical CLI surface</code>

---

## M7 — MCP 全能力覆盖、compact hydration 与安全 mutation

**目标：** MCP 不再是 CLI 的能力子集；agent 可以发现、查询、分页、补取、写知识和执行受控管理操作。

**依赖：** M5；可与 M6 在 contract 冻结后并行。

**创建：**

- <code>packages/mcp/src/knowledge-capability-registry.ts</code>
- <code>packages/mcp/src/knowledge-contract-adapter.ts</code>
- <code>packages/mcp/src/knowledge-tool-generator.ts</code>
- <code>packages/mcp/src/knowledge-mutation-guard.ts</code>
- <code>tests/knowledge-mcp-capability-parity.test.mjs</code>
- <code>tests/knowledge-mcp-search-v2.test.mjs</code>
- <code>tests/knowledge-mcp-compact-hydration.test.mjs</code>
- <code>tests/knowledge-mcp-mutation-guard.test.mjs</code>

**修改：**

- <code>packages/mcp/src/knowledge-tool-defs.ts</code>
- <code>packages/mcp/src/knowledge-tools.ts</code>
- <code>packages/mcp/src/index.ts</code>。
- <code>tests/knowledge-mcp-tools.test.mjs</code>
- <code>scripts/check-knowledge-runtime.mjs</code>

### M7.1 先写 tools/list parity

- [x] 从 manifest 计算 required MCP capability IDs。
- [x] 从 initialize + tools/list 读取 tool metadata 中的 <code>x-penguin-capability-id</code>。
- [x] 两集合完全相等。
- [ ] 每个 tool input schema 与 contract schema snapshot 相等。
- [x] 初次运行应列出缺失 capability，而不是只说 count 不同。

### M7.2 Tool 命名

canonical ID 到 MCP tool 名固定把点替换为下划线：

~~~text
knowledge.search            -> knowledge_search
knowledge.get_hit           -> knowledge_get_hit
knowledge.memory.remember   -> knowledge_memory_remember
knowledge.artifact.export   -> knowledge_artifact_export
~~~

- [x] 旧 tool 名保留为 deprecated alias 一个 release window。
- [x] alias 不重复出现在 capability completeness 计数。
- [x] tool description 明确 verified/inference、revision 和 zero-result diagnostics。
- [x] 删除当前 <code>knowledge_search</code>“不能搜 call-site/string”限制描述，因为 M4 已解决；若 M4 未完成，M7 不可标绿。

### M7.3 Handler 必须薄

~~~typescript
export async function invokeKnowledgeCapability(
  capabilityId: string,
  input: unknown,
  context: McpContext,
): Promise<McpToolResult>;
~~~

只允许：

1. validate MCP input；
2. 映射 auth/workspace context；
3. 调 core operation；
4. 把 typed result 放入 MCP content + structuredContent。

禁止在 handler 重写 search/ranking/scope。

### M7.4 compact 与 hydration

- [x] 默认 agent search 使用 <code>compact=true</code>、limit 20。
- [x] structuredContent 永远保留完整 contract 中 compact 允许字段。
- [x] text content 提供人类短摘要，不作为唯一机器数据。
- [x] <code>knowledge_get_hit</code> 返回完整 snippet/evidence/source range。
- [x] response 增加 stats：原始字节估算、发送字节、compact ratio、timings；不得保存用户源码内容到 telemetry。
- [x] hydration 请求验证 caller workspace 和 original hit revision。

### M7.5 mutation guard

- [x] write_note、remember、forget、improve、suggestion accept/reject、index、rebuild、remove、artifact import 均通过 canonical manifest/alias guard 声明 mutating。
- [x] MCP server config 默认只开 read-only；mutating tool 在 disabled 时仍可 discover，但调用返回 <code>MUTATION_DISABLED</code>；已有 MCP guard 测试。
- [x] enabled 时需要 operation-scoped confirmation token；token 包含 capability、scope、expiry、input digest；篡改 token 会拒绝。
- [ ] index/watch 可配置为 trusted background operation；remove/import 永不默认 trusted。
- [x] 所有通过 `runKnowledgeTool` 的 mutation 进入统一 audit finally；token 与 feedback 只保存 digest，不写 secret/raw query。

### M7.6 MCP 初始化和 schema negotiation

- [x] initialize response 暴露 contract version、capability hash、schema version、runtime build ID。
- [x] client 指定不兼容 major contract 时拒绝，给升级建议。
- [x] tools/list stable sort。
- [x] source MCP 和 bundled MCP 的 tools/list snapshot 一致。

### M7 验收

~~~bash
rtk test node --test \
  tests/knowledge-mcp-capability-parity.test.mjs \
  tests/knowledge-mcp-search-v2.test.mjs \
  tests/knowledge-mcp-compact-hydration.test.mjs \
  tests/knowledge-mcp-mutation-guard.test.mjs \
  tests/knowledge-mcp-tools.test.mjs \
  tests/knowledge-runtime-doctor.test.mjs
rtk npm run typecheck
rtk npm run knowledge:bundle
~~~

**预期结果：**

- MCP required capability 缺失数为 0。
- 同请求 normalized MCP response 等于 core/CLI。
- compact 可逆补取。
- mutation 默认拒绝且可审计。

**建议 checkpoint：** <code>feat(knowledge): expose complete guarded MCP surface</code>

---

## M8 — 常驻 Query Runtime 与 Tauri 连接

**目标：** 消除 Wiki 每次查询 spawn 一个 Node process 的延迟，同时保持崩溃恢复、版本握手和可诊断性。

**依赖：** M6、M7。

**创建：**

- <code>packages/knowledge-cli/src/query-server.ts</code>
- <code>packages/knowledge-cli/src/query-protocol.ts</code>
- <code>src-tauri/src/knowledge_runtime.rs</code>
- <code>tests/knowledge-query-server.test.mjs</code>
- <code>tests/knowledge-query-server-restart.test.mjs</code>
- <code>tests/knowledge-query-protocol.test.mjs</code>

**修改：**

- <code>packages/knowledge-cli/src/bin.ts</code>
- <code>src-tauri/src/knowledge.rs</code>
- <code>src-tauri/src/lib.rs</code> 或实际 command registration 文件。
- <code>src/lib/knowledge-client.ts</code>
- <code>tests/knowledge-runtime-doctor.test.mjs</code>

### M8.1 先写 JSONL protocol test

协议：

~~~json
{"type":"hello","protocolVersion":1,"capabilityHash":"...","schemaVersion":10}
{"type":"request","id":"r1","capabilityId":"knowledge.search","input":{}}
{"type":"response","id":"r1","ok":true,"result":{}}
{"type":"response","id":"r2","ok":false,"error":{"code":"..."}}
{"type":"event","requestId":"r3","event":{"kind":"progress"}}
~~~

- [x] 每条 JSON 一行；源码 newline 由 JSON escaping 表达。已由 `tests/knowledge-query-protocol.test.mjs` 与 `tests/knowledge-query-runtime-e2e.test.mjs` 验证。
- [x] stdout 只允许协议；Node log 全到 stderr。
- [x] request ID 可并发乱序返回。
- [x] malformed frame 只失败对应 request；连续 framing corruption 才重启 runtime。
- [x] protocol major mismatch 必须拒绝。

### M8.2 Node query server

新增 CLI hidden command：

~~~bash
rtk penguin __query-server --stdio
~~~

- [x] 启动时打开一个 KnowledgeStore connection 并发送 hello。`knowledge-query-runtime-e2e.test.mjs` 启动编译后的 `__query-server`，读取真实 SQLite store 的 hello。
- [ ] 保持 prepared statement、FTS cache、capability registry 常驻。
- [ ] read request 可并发，但 better-sqlite3 实际 DB 操作在受控队列；长 search 分 batch 让 cancellation 有机会生效。
- [x] mutation 串行。
- [x] 支持 <code>cancel</code> frame。
- [x] 收到 SIGTERM/EOF：完成当前 transaction、关闭 DB、退出。runtime E2E 发送 EOF 后验证 child 正常关闭。
- [ ] idle 期间不轮询 DB；用 schema/capability check interval 或明确 invalidate event。

### M8.3 Rust runtime manager

<code>KnowledgeRuntime</code> 持有：

~~~rust
pub struct KnowledgeRuntime {
    child: Mutex<Option<RuntimeChild>>,
    pending: Mutex<HashMap<String, oneshot::Sender<RuntimeResponse>>>,
    hello: RwLock<Option<RuntimeHello>>,
}
~~~

- [x] Tauri app 启动后 lazy spawn；Wiki prewarm 可显式触发。`QueryRuntimeState` 按首次 resident query 懒启动，setup 调用 `prewarm` 复用同一 resident worker；prewarm 无 DB 时不产生启动副作用。
- [x] 使用 resource 中 vendored Node 和 bundled CLI，不依赖用户 PATH。
- [x] hello capability hash 与 Tauri expected manifest 不同，runtime 标记 unhealthy，拒绝 query。
- [x] reader task 按 ID resolve pending request。
- [x] child crash：失败所有 pending request，以 <code>RUNTIME_RESTARTED</code> 返回；下一请求最多自动重启一次。
- [x] 1 分钟内连续 3 次 crash 进入 circuit-open，不无限重启；Rust unit test 覆盖计数和熔断。
- [ ] app exit 杀掉 child，不留 orphan；`Drop` 已显式 kill/wait，但仍缺真实 app-exit process test。

### M8.4 替换 per-query spawn

- [x] <code>src-tauri/src/knowledge.rs::knowledge_query</code> 改成调用 runtime manager。search/get-hit 使用 typed protocol capability；其余兼容 UI query 也通过 resident `knowledge.cli` bridge。
- [x] 保留一次性 spawn 作为显式 diagnostic fallback <code>knowledge_query_once</code>，UI 不默认使用。Tauri command 已注册，默认 UI 只调用 `knowledge_query`。
- [x] <code>src/lib/knowledge-client.ts</code> 的 Wiki search/get-hit 已传 canonical capability/input，不拼 CLI argv；其余兼容命令仍走 resident bridge。
- [x] 所有 UI query 支持 AbortSignal，对应 protocol cancel。

### M8.5 性能和恢复测试

- [ ] 第一次冷查询记录 spawn/open/index warmup。
- [x] 之后 100 次查询只产生一个 Node PID。`tests/knowledge-query-runtime-e2e.test.mjs` 启动一个真实 `__query-server` child，连续发送 100 个真实 search request 并验证同一 PID。
- [ ] 杀掉 child 后下一请求重启且成功。
- [ ] 模拟 hash mismatch，UI 收到 typed health error。
- [ ] 关闭 app/runtime 后 PID 不存在。

### M8 验收

~~~bash
rtk test node --test \
  tests/knowledge-query-server.test.mjs \
  tests/knowledge-query-server-restart.test.mjs \
  tests/knowledge-query-protocol.test.mjs \
  tests/knowledge-runtime-doctor.test.mjs
rtk cargo test --manifest-path src-tauri/Cargo.toml knowledge_runtime
rtk npm run typecheck
~~~

**预期结果：**

- warm Wiki query 不再 spawn process。
- runtime crash 可恢复且不循环。
- protocol/capability mismatch 可见。
- warm exact p95 为后续 150 ms gate 留出空间。

**建议 checkpoint：** <code>perf(knowledge): add resident query runtime</code>

---

## M9 — Wiki 全局搜索、结果预览与知识导航

**目标：** 让 Wiki 从“知道节点后浏览”升级成“任何代码/知识都可从一个入口找到并追到上下文、WHY、证据”。

**依赖：** M8。

**创建：**

- <code>src/components/wiki/WikiSearchPage.tsx</code>
- <code>src/components/wiki/WikiSearchBar.tsx</code>
- <code>src/components/wiki/WikiSearchFilters.tsx</code>
- <code>src/components/wiki/WikiSearchResults.tsx</code>
- <code>src/components/wiki/WikiSearchPreview.tsx</code>
- <code>src/components/wiki/WikiSearchDiagnostics.tsx</code>
- <code>src/components/wiki/WikiSavedQueries.tsx</code>
- <code>src/lib/knowledge-search-state.ts</code>
- <code>tests/wiki-search-page.test.mjs</code>
- <code>tests/wiki-search-keyboard.test.mjs</code>
- <code>tests/wiki-search-zero-result.test.mjs</code>

**修改：**

- <code>src/components/wiki/WikiPage.tsx</code>
- <code>src/components/wiki/WikiContextPane.tsx</code>
- <code>src/components/wiki/WikiWhyPanel.tsx</code>
- <code>src/components/wiki/WikiNoteEditor.tsx</code>
- <code>src/lib/knowledge-client.ts</code>
- <code>tests/wiki-page.test.mjs</code>

### M9.1 先改 product contract test

当前 <code>tests/wiki-page.test.mjs</code> 锁定 browse-only。先把契约改成：

- [x] WikiPage 有 Search 主入口。
- [x] 输入查询会调用 canonical <code>knowledge.search</code>。
- [x] 不允许 UI 自己过滤原始 node list 来模拟 search。
- [x] hit 可打开 preview，再打开 Context、Graph、WHY、Evidence。
- [x] zero result 展示 coverage diagnostics。
- [x] 初次运行应因组件不存在失败。

### M9.2 页面信息架构

Wiki 一级 tab：

~~~text
Search | Context | Graph | Knowledge | Evidence
~~~

- Search 是默认 tab。
- Context 保留当前 symbol/route deep dive。
- Graph 保留 2D/3D/flow/community。
- Knowledge 管理 Markdown notes、saved queries、domain/onboarding。
- Evidence 管理 SLS/runtime/validated findings。

### M9.3 搜索交互

- [x] 全局快捷键 <code>Cmd/Ctrl+K</code> 聚焦 search。
- [x] 输入 150 ms debounce；Enter 立即发起；新 query abort 旧 request。
- [x] mode selector 默认 auto，可切 exact/path/regex/structural/semantic。
- [x] filters：repo、branch/snapshot、path、language、kind、generated/vendor、evidence status。
- [x] URL/state 可复制恢复，cursor 不写永久 URL。
- [x] recent query 仅存本机，不保存 query snippet 到遥测。
- [x] 显示 resolved revision chip，避免用户误看错分支。

### M9.4 结果列表

每个 hit 显示：

- repo、path、line、revision；
- kind 和 lane；
- 高亮 snippet；
- verified/observed/reviewed/inference badge；
- rank reason 的简短解释；
- Context、Graph、WHY、Evidence 快捷动作。

- [x] exact/path hit 用确定性样式，不与 semantic 混淆。
- [x] 列表虚拟化，200 hit 不冻结。WikiSearchPage 采用固定估算行高、overscan 与 top/bottom spacer，只渲染窗口内结果；`tests/wiki-search-page.test.mjs`、typecheck 通过。
- [ ] 键盘上/下选择，Enter preview，Cmd+Enter 打开代码位置。已完成上下键选择、Enter/Space preview 与 focus/click 激活；Cmd+Enter 的跨平台代码定位命令仍待补齐。
- [x] next cursor 接近底部加载；重复 hit 去重。

### M9.5 Preview

- [x] 调 <code>knowledge.get_hit</code> 补取完整 excerpt。
- [ ] 显示前后可配置行，行号可点击。
- [ ] 若 revision 不是 working tree，显示只读 commit 标识，不能假装打开当前文件同一行。
- [x] symbol hit 展示 callers/callees/tests/routes。
- [ ] note hit 展示 backlinks/unlinked mentions。
- [x] evidence hit 展示来源、时间、新鲜度和验证状态。

### M9.6 零结果与 coverage

禁止只显示“没有结果”。必须显示：

~~~text
已搜索：source, path, symbol, graph, note
作用域：FPMS-NT-Auth-Player / master / <snapshot>
覆盖：4,812 admitted, 93 excluded, 1 failed, 0 stale
可能原因：2 个路径因 secret_policy 排除
建议：切换 substring；清除 path filter；重新索引 stale file
~~~

- [ ] reindex 按钮是 mutation，先展示范围和确认。
- [ ] excluded secret 不展示内容。

### M9.7 Saved query

- [x] 保存的是 canonical SearchRequest，不是 UI 私有 state。
- [x] 保存时记录 contract version；旧 version 打开时 migration 或明确不兼容。
- [ ] 支持 pin 到 Knowledge tab。
- [ ] M11 再把 saved query 写入 Markdown/Obsidian-compatible 文件；本阶段先走 core API。

### M9 验收

~~~bash
rtk test node --test \
  tests/wiki-search-page.test.mjs \
  tests/wiki-search-keyboard.test.mjs \
  tests/wiki-search-zero-result.test.mjs \
  tests/wiki-page.test.mjs
rtk npm run typecheck
rtk npm run build
~~~

手工验收：

1. 搜完整 dotted call，第一项是 source exact。
2. 搜中文注释，打开正确行。
3. 搜被排除 <code>.env</code> 路径，只见 policy reason。
4. 切 feature snapshot，确认 deleted file 不出现。
5. 连续输入 10 次，只有最后一个 request 渲染。

**预期结果：** 用户无需先知道 symbol/node 名，从 Wiki 一个入口即可定位代码、上下文、WHY 和证据。

**建议 checkpoint：** <code>feat(wiki): add universal code and knowledge search</code>

---

## M10 — 深化结构图：身份、数据流、动态派发、协议与基础设施

**目标：** 在“全文一定找得到”之上，让 Penguin 对调用关系、跨服务流、字段读写、消息通道和影响范围的可信度达到可替代 CodeGraph/Graphify/codebase-memory-mcp 的程度。

**依赖：** M5。可与 M9 并行，但不能更改 Search contract。

**创建：**

- <code>packages/knowledge-indexer/src/symbol-identity.ts</code>
- <code>packages/knowledge-indexer/src/field-access.ts</code>
- <code>packages/knowledge-indexer/src/data-flow.ts</code>
- <code>packages/knowledge-indexer/src/dynamic-dispatch.ts</code>
- <code>packages/knowledge-indexer/src/channel-extract.ts</code>
- <code>packages/knowledge-indexer/src/graphql-extract.ts</code>
- <code>packages/knowledge-indexer/src/trpc-extract.ts</code>
- <code>packages/knowledge-indexer/src/iac-extract.ts</code>
- <code>packages/knowledge-indexer/src/resolution-provider.ts</code>
- <code>packages/knowledge-core/src/graph-confidence.ts</code>
- <code>packages/knowledge-core/src/data-flow-query.ts</code>
- <code>packages/knowledge-core/src/graph-query.ts</code>
- <code>tests/knowledge-symbol-identity-v2.test.mjs</code>
- <code>tests/knowledge-field-access.test.mjs</code>
- <code>tests/knowledge-data-flow.test.mjs</code>
- <code>tests/knowledge-dynamic-dispatch.test.mjs</code>
- <code>tests/knowledge-channel-flow.test.mjs</code>
- <code>tests/knowledge-graphql-trpc.test.mjs</code>
- <code>tests/knowledge-iac.test.mjs</code>
- <code>tests/knowledge-graph-query-dsl.test.mjs</code>

**修改：**

- <code>packages/knowledge-indexer/src/extract.ts</code>
- <code>packages/knowledge-indexer/src/resolve.ts</code>
- <code>packages/knowledge-indexer/src/resolution-context.ts</code>
- <code>packages/knowledge-indexer/src/routes.ts</code>
- <code>packages/knowledge-indexer/src/fusion.ts</code>
- <code>packages/knowledge-core/src/query.ts</code>
- <code>packages/knowledge-core/src/schema.ts</code>，仅在现有 node/edge columns 无法表达 provenance 时迁移。
- <code>tests/knowledge-symbol-disambiguation.test.mjs</code>
- <code>tests/knowledge-affected.test.mjs</code>
- <code>tests/knowledge-context-pack.test.mjs</code>

### M10.1 先定义结构可信度契约

每条 edge 必须能回答：

~~~typescript
export interface GraphProvenance {
  method:
    | "ast_exact"
    | "type_resolution"
    | "lsp_resolution"
    | "framework_convention"
    | "string_literal"
    | "runtime_observation"
    | "heuristic";
  status: "verified" | "candidate" | "rejected";
  confidence: number;
  sourceLocator: SearchLocator;
  targetLocator?: SearchLocator;
  explanation: string;
}
~~~

- [ ] <code>verified</code> 只能来自明确 AST/type/LSP/runtime proof。
- [ ] framework convention 默认 candidate，除非 route/channel registration 可精确对接。
- [x] heuristic edge 不进入默认 affected 的“确定影响”，只进入 possible impact。
- [x] 每个 graph query 同时返回 coverage：语言、resolver、unresolved count。

### M10.2 Symbol identity v2

Identity key 固定优先级：

~~~text
repo + language + module/package + fully-qualified container + symbol + signature discriminator
~~~

- [ ] 同名函数不同文件不合并。
- [ ] method overload 按参数 arity/type discriminator 区分。
- [ ] anonymous callback 使用 parent identity + AST ordinal，不用不稳定行号单独作为 ID。
- [ ] rename 保留 alias，跨 revision 不把新旧实现误当并存。
- [ ] TypeScript barrel export、path alias、default export/re-export 有 fixture。
- [ ] Rust module/use、Go package receiver、Java package/class、Python module/class 有 fixture。

### M10.3 字段读写

新增 edge：

~~~text
reads_field
writes_field
passes_field
returns_field
validates_field
serializes_field
~~~

- [x] TypeScript/JavaScript 先支持 property access、destructuring、object literal、spread 的保守解析。
- [ ] schema/interface field 仍可保持 lightweight identifier，不强制成为全局 symbol；只有参与关系时创建 field node。
- [x] computed dynamic property 标记 candidate，不猜具体字段。
- [ ] query 可回答“谁写入 cpf”“这个 response field 从哪里来”。
- [ ] PII 字段示例只用 synthetic fixture。

### M10.4 局部数据流

先实现 intra-procedural SSA-lite：

- assignment；
- parameter to local；
- return；
- function call argument；
- object field mapping；
- guard/validator；
- throw/error branch。

新增：

~~~typescript
export interface DataFlowPath {
  source: GraphEndpoint;
  sink: GraphEndpoint;
  steps: Array<{
    kind: "assign" | "argument" | "return" | "field" | "guard" | "call";
    locator: SearchLocator;
    status: "verified" | "candidate";
  }>;
  truncated: boolean;
  gaps: string[];
}
~~~

- [x] 不跨不透明 dynamic call 虚构 flow；在那里结束并给 gap。
- [ ] inter-procedural 只沿 verified call edge 连接。
- [x] 最大深度和节点数可配置；达到上限明确 truncated。
- [ ] data flow hit 可从 source line 打开。

### M10.5 动态派发

- [ ] interface method call：根据 resolved type/implementations 产生候选集合。
- [ ] dependency injection token：从 provider registration 解析 concrete target。
- [ ] NestJS module/provider/controller、Spring bean、Go interface assignment、Rust trait impl 分 framework adapter。
- [ ] 单一确定 target 标 verified；多个合法 target 标 candidate set。
- [ ] graph flow 展示 dispatch hop，不能画成普通 direct call。
- [ ] 运行时 evidence 可把 observed target 提升为 <code>runtime_observation</code>，但只对对应 revision/environment。

### M10.6 协议与 channel

统一 node/edge：

~~~text
Node: endpoint, rpc, event, queue, topic, websocket_event, graphql_operation
Edge: handles, invokes, publishes, subscribes, produces, consumes, sends, receives
~~~

支持：

- HTTP/NestJS/Express/Spring；
- gRPC/Connect/Proto；
- GraphQL query/mutation/subscription；
- tRPC router/procedure/client；
- WebSocket event；
- Kafka/RabbitMQ/SQS/SNS/Redis pubsub 常见注册模式；
- cron/job producer/consumer。

- [ ] 每个 framework 有 producer + consumer + ambiguous fixture。
- [ ] 字符串 topic 名 exact 对接可 verified。
- [ ] template/dynamic topic 只建 candidate pattern。
- [ ] 跨 repo flow 返回每一跳 source。

### M10.7 IaC

解析：

- Dockerfile stage、image、port、entrypoint；
- docker-compose service、depends_on、port、volume；
- Kubernetes Deployment/Service/Ingress/ConfigMap/Secret reference；
- Terraform resource/module/data reference；
- GitHub Actions workflow/job/step；
- Helm values/template 的可静态引用。

- [ ] secret 只存 key/name locator，不存明文 value。
- [ ] IaC node 可连接到 service/package/endpoint。
- [ ] deploy blast radius 区分 verified reference 与 name heuristic。

### M10.8 Resolution provider

~~~typescript
export interface ResolutionProvider {
  id: string;
  supports(language: string): boolean;
  resolve(request: ResolutionRequest): Promise<ResolutionResult>;
}
~~~

优先级：

1. parser local exact；
2. type/project resolver；
3. configured LSP；
4. framework adapter；
5. heuristic。

- [ ] LSP 不可用时索引继续，coverage 记录 resolver unavailable。
- [ ] provider result 绑定 parser/config hash，变更后失效。
- [ ] 不让 LSP 启动过程阻塞 exact source ingestion。

### M10.9 Graph query 输出

<code>context</code>、<code>flow</code>、<code>affected</code> 增加：

- verified paths；
- possible paths；
- unresolved gaps；
- source excerpts；
- revision；
- graph coverage。

<code>knowledge.explore</code> 一次调用应能返回相关 symbol 的当前源码与 call path，达到 CodeGraph 的高频体验，但仍使用统一 compact/hydration。

### M10.10 Bounded graph query DSL

提供比 raw Cypher 更安全、CLI/MCP 同源的 typed query：

~~~typescript
export interface GraphQueryRequest {
  scope: SearchRequest["scope"];
  start: {
    nodeIds?: string[];
    kinds?: string[];
    name?: string;
    filePath?: string;
  };
  traverse: Array<{
    edgeTypes: string[];
    direction: "out" | "in" | "both";
    minDepth: number;
    maxDepth: number;
    statuses: Array<"verified" | "candidate">;
  }>;
  where?: {
    nodeKinds?: string[];
    repoIds?: string[];
    pathPrefixes?: string[];
  };
  project: Array<"nodes" | "edges" | "paths" | "source" | "provenance">;
  limit: number;
  cursor?: string;
}
~~~

- [x] CLI 为 <code>rtk penguin graph-query --request &lt;json-file&gt; --json</code>。
- [x] MCP capability 为 <code>knowledge.graph.query</code>。
- [x] maxDepth 上限 12、limit 上限 500；超限在 validator 拒绝。
- [x] query 只能读 effective revision graph，不能执行 SQL、procedure、file/network I/O。
- [x] path expansion 防 cycle，并返回 truncated/cursor。
- [x] candidate edge 必须由 request 明确包含；默认只走 verified。
- [x] source projection 走 compact hit + hydration，不复制无限源码。
- [x] `docs/knowledge-v2/search-contract.md` 提供常见 read-only Cypher pattern 到 bounded typed DSL 的迁移表；不执行任意 Cypher。

### M10 验收

~~~bash
rtk test node --test \
  tests/knowledge-symbol-identity-v2.test.mjs \
  tests/knowledge-field-access.test.mjs \
  tests/knowledge-data-flow.test.mjs \
  tests/knowledge-dynamic-dispatch.test.mjs \
  tests/knowledge-channel-flow.test.mjs \
  tests/knowledge-graphql-trpc.test.mjs \
  tests/knowledge-iac.test.mjs \
  tests/knowledge-graph-query-dsl.test.mjs \
  tests/knowledge-symbol-disambiguation.test.mjs \
  tests/knowledge-affected.test.mjs \
  tests/knowledge-context-pack.test.mjs
rtk npm run knowledge:benchmark
rtk npm run knowledge:benchmark:real
rtk npm run typecheck
~~~

**预期结果：**

- 已知 graph benchmark 不回退。
- 新 protocol/data-flow corpus 的 verified precision = 100%。
- ambiguous 情况诚实返回 candidate/gap。
- explore 一次返回 source + path + provenance。

**建议 checkpoint：** <code>feat(knowledge): deepen verified structural and cross-service graph</code>

---

## M11 — Markdown-first Knowledge Vault 与 Obsidian 兼容层

**目标：** 让人类知识保持开放 Markdown 文件，同时拥有 properties、wikilink、backlink、unlinked mention、Search DSL、local graph 和 Canvas。

**依赖：** M5；M12 依赖本任务。

**创建：**

- <code>packages/knowledge-indexer/src/markdown-properties.ts</code>
- <code>packages/knowledge-indexer/src/markdown-links.ts</code>
- <code>packages/knowledge-indexer/src/canvas.ts</code>
- <code>packages/knowledge-indexer/src/external-source.ts</code>
- <code>packages/knowledge-indexer/src/url-source.ts</code>
- <code>packages/knowledge-indexer/src/database-schema-source.ts</code>
- <code>packages/knowledge-core/src/knowledge-dsl.ts</code>
- <code>packages/knowledge-core/src/saved-query.ts</code>
- <code>packages/knowledge-core/src/unlinked-mentions.ts</code>
- <code>src/components/wiki/WikiKnowledgeVault.tsx</code>
- <code>src/components/wiki/WikiLocalGraph.tsx</code>
- <code>src/components/wiki/WikiCanvas.tsx</code>
- <code>tests/knowledge-markdown-properties.test.mjs</code>
- <code>tests/knowledge-wikilinks.test.mjs</code>
- <code>tests/knowledge-search-dsl.test.mjs</code>
- <code>tests/knowledge-canvas.test.mjs</code>
- <code>tests/knowledge-unlinked-mentions.test.mjs</code>
- <code>tests/knowledge-external-source.test.mjs</code>

**修改：**

- <code>packages/knowledge-indexer/src/notes-fs.ts</code>
- <code>packages/knowledge-indexer/src/notes.ts</code>
- <code>packages/knowledge-indexer/src/notes-public.ts</code>
- <code>packages/knowledge-core/src/query.ts</code>
- <code>src/components/wiki/WikiNoteEditor.tsx</code>
- <code>src/components/wiki/WikiGraph.tsx</code>
- <code>tests/knowledge-indexer-notes.test.mjs</code>
- <code>tests/knowledge-note-cli.test.mjs</code>
- <code>tests/knowledge-typed-notes.test.mjs</code>

### M11.1 文件为真相

- [x] Markdown/Canvas 文件是 canonical；DB 是可重建索引。
- [x] note write 使用 temp file + fsync + atomic rename。
- [x] 保留用户未知 frontmatter key、字段顺序和正文。
- [x] 外部 Obsidian 修改由 watcher 重新索引。
- [x] DB 丢失后重新 index 可恢复所有 note/link/property/canvas。
- [x] 冲突时不静默覆盖；返回 expected content hash mismatch。

Schema v11 只保存可重建索引，不成为文档真相：

~~~sql
CREATE TABLE note_properties (
  note_node_id TEXT NOT NULL,
  property_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_number REAL,
  value_boolean INTEGER,
  value_date TEXT,
  source_line INTEGER NOT NULL,
  PRIMARY KEY (note_node_id, property_key, ordinal)
);

CREATE TABLE note_links (
  source_node_id TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  raw_target TEXT NOT NULL,
  target_node_id TEXT,
  target_anchor TEXT,
  display_text TEXT,
  embedded INTEGER NOT NULL,
  resolution_status TEXT NOT NULL,
  PRIMARY KEY (source_node_id, source_line, raw_target, target_anchor)
);

CREATE INDEX idx_note_links_target
  ON note_links(target_node_id, source_node_id);
CREATE INDEX idx_note_properties_lookup
  ON note_properties(property_key, value_text, value_number, value_date);
~~~

- [x] note reindex 在一个 transaction 内先替换 properties/links，再更新 FTS。
- [x] 删除 Markdown 会删除派生 rows；文件仍可从 git history/revision 查。
- [x] DB rebuild test 证明 v11 rows 与文件重建结果一致。

### M11.2 Properties

支持 YAML frontmatter：

~~~yaml
---
id: auth-login-blacklist
title: Auth login blacklist
type: why
aliases:
  - Login blacklist
tags:
  - auth
  - risk
status: reviewed
repo:
  - FPMS-NT-Auth-Player
revision: 8f3c...
owners:
  - platform
---
~~~

- [x] string、number、boolean、date、list、null 可索引。
- [x] property query 保留 typed comparison。
- [x] aliases 参与 wikilink resolve 和 unlinked mention。
- [x] reserved keys 有 validator；unknown key 保留并可查。
- [x] secret-looking property value 默认 redacted，不进入 full-text。

### M11.3 Wikilinks 与 backlinks

支持：

~~~text
[[Note]]
[[Note|Alias]]
[[Note#Heading]]
[[Note#^block-id]]
![[Note]]
~~~

- [x] resolve 顺序：stable id、exact path、title、alias；歧义不猜，返回 candidates。
- [x] heading/block anchor 有 locator。
- [x] backlink 保存 source note、target、anchor、line、embed flag。
- [x] rename note 时更新 index；是否重写源文件由显式 mutation 决定。
- [x] dangling link 可搜和修复。Indexer 提供 `listDanglingNoteLinks`，CLI `note links`/`note reindex` 与 MCP `knowledge_note_reindex` 返回 raw target、anchor、status；修复仍以显式 Markdown reindex mutation 执行。

### M11.4 Unlinked mentions

- [x] 从 note title/aliases 构造候选词典。
- [x] 只在 Markdown 正文查；排除 code fence、inline code、已有 link、frontmatter。
- [x] 大小写和词边界按语言处理；CJK 用 exact phrase。
- [x] 返回 suggestion，不自动写 link。
- [x] accept 通过 content hash guard 修改文件。

### M11.5 Search DSL

语法固定：

~~~text
path:"apps/player"
file:player.service.ts
content:"findAllByCpf"
tag:#auth
property:status=reviewed
property:priority>=2
line:"入口日志"
section:"Manual KYC"
block:"^decision-1"
task:open
regex:/findAllByCpf\s*\(/
repo:FPMS-NT-Auth-Player
branch:master
kind:why
AND OR NOT ( )
~~~

- [x] 普通 search 不隐式解释 DSL；只有 <code>--dsl</code> 或 Wiki advanced mode。
- [x] parser 给精确位置错误。
- [x] DSL 编译为 SearchRequest + property predicates，不拼 SQL。
- [x] regex 复用 M4 safe engine。
- [x] line/section/block 返回精确 Markdown locator。

### M11.6 Saved queries

文件位置：

~~~text
<knowledge-root>/.penguin/queries/<slug>.md
~~~

格式：

~~~yaml
---
type: saved-query
contractVersion: 2
name: Auth CPF call sites
---
~~~

正文包含 canonical JSON code block。写入时 stable format；读取时验证 contract。

### M11.7 Canvas

支持 Obsidian <code>.canvas</code> JSON：

- text/file/link/group node；
- edge、label、color；
- x/y/width/height；
- unknown fields round-trip。

- [x] file node 可指向 Markdown 或 code path。
- [x] local graph selection 可 export 成 Canvas。
- [x] Canvas 中 code hit 保存 revision + locator extension property，Obsidian 忽略也不破坏。
- [x] import 不执行 URL 或 embedded script。

### M11.8 Local graph

- [ ] 当前 note/code symbol 为中心，可调深度 1–3。
- [ ] edge 类型区分 wikilink、backlink、mentions、code relation、evidence。
- [ ] revision 不同的 code node 有明显标识。
- [ ] graph selection 可送到 search/context/canvas。

### M11.9 外部知识源

支持显式注册：

~~~typescript
export type ExternalKnowledgeSource =
  | { type: "markdown_directory"; path: string }
  | { type: "url"; url: string }
  | { type: "postgres_schema"; credentialEntryId: string; schemas: string[] }
  | { type: "openapi"; pathOrUrl: string };
~~~

- [x] 默认没有网络抓取；URL/OpenAPI URL 每个 source 由用户显式注册。
- [x] URL 防 SSRF：拒绝 loopback、link-local、metadata IP、file URL、重定向到禁区；允许的内部域必须显式 allow-list。
- [x] 保存抓取快照 hash、final URL、retrievedAt、content type、license/robots warning 和 source locator。
- [x] HTML 转 text/Markdown 时保留 heading/link locator；原始响应按 content policy 决定是否保存。
- [ ] Postgres 只用 read-only credential introspect schema/table/column/index/constraint/function signature，默认不读取业务 row。
- [ ] credential 复用现有 <code>credential_entries</code> 安全存储，只保存 ID，不写 note/artifact。
- [ ] source sync 产生新 revision；旧 claim 自动 stale，不原地覆盖历史。
- [ ] external source 的内容标 untrusted，进入 M14 content boundary。
- [ ] CLI/MCP 都覆盖 register/sync/list/remove；register/remove 是 guarded mutation。

### M11 验收

~~~bash
rtk test node --test \
  tests/knowledge-markdown-properties.test.mjs \
  tests/knowledge-wikilinks.test.mjs \
  tests/knowledge-search-dsl.test.mjs \
  tests/knowledge-canvas.test.mjs \
  tests/knowledge-unlinked-mentions.test.mjs \
  tests/knowledge-external-source.test.mjs \
  tests/knowledge-indexer-notes.test.mjs \
  tests/knowledge-note-cli.test.mjs \
  tests/knowledge-typed-notes.test.mjs
rtk npm run typecheck
rtk npm run build
~~~

手工兼容验收：

1. 用 Obsidian 打开 fixture vault。
2. 修改 property、wikilink 和 Canvas。
3. Penguin watcher 重新索引。
4. Penguin 写 note 后 Obsidian 正常打开且未知字段未丢。

**预期结果：** 用户不被专有 DB 锁定，Obsidian 和 Penguin 可共同使用同一知识文件。

**建议 checkpoint：** <code>feat(knowledge): add markdown-first Obsidian-compatible vault</code>

---

## M12 — WHY Cards、记忆生命周期、Domain Flow 与 Onboarding

**目标：** 不只回答“代码在哪里”，还要回答“为什么这样做、何时改变、谁验证、业务流程是什么”，且每个结论可追溯。

**依赖：** M10、M11。

**创建：**

- <code>packages/knowledge-core/src/why-card.ts</code>
- <code>packages/knowledge-core/src/memory.ts</code>
- <code>packages/knowledge-core/src/domain-model.ts</code>
- <code>packages/knowledge-core/src/ontology.ts</code>
- <code>packages/knowledge-core/src/onboarding.ts</code>
- <code>packages/knowledge-indexer/src/why-extract.ts</code>
- <code>packages/knowledge-indexer/src/domain-extract.ts</code>
- <code>src/components/wiki/WikiMemoryPanel.tsx</code>
- <code>src/components/wiki/WikiDomainFlow.tsx</code>
- <code>src/components/wiki/WikiOnboardingGuide.tsx</code>
- <code>tests/knowledge-why-card.test.mjs</code>
- <code>tests/knowledge-memory-lifecycle.test.mjs</code>
- <code>tests/knowledge-domain-model.test.mjs</code>
- <code>tests/knowledge-ontology.test.mjs</code>
- <code>tests/knowledge-onboarding.test.mjs</code>

**修改：**

- <code>src/components/wiki/WikiWhyPanel.tsx</code>
- <code>packages/knowledge-cli/src/command-registry.ts</code>
- <code>packages/mcp/src/knowledge-capability-registry.ts</code>

### M12.1 WHY evidence hierarchy

证据优先级：

1. 当前 revision 的直接 source/config/schema；
2. 当前 revision 的 test；
3. git commit/PR/linked agent session；
4. runtime observation；
5. reviewed human note；
6. stale/other-revision note；
7. model inference。

WHY card：

~~~typescript
export interface WhyCard {
  id: string;
  subject: SearchLocator | { nodeId: string };
  question: string;
  answer: string;
  decision: string;
  alternatives: Array<{ option: string; rejectedBecause: string }>;
  constraints: string[];
  consequences: string[];
  evidence: SearchEvidence[];
  gaps: string[];
  status: "draft" | "reviewed" | "verified" | "stale" | "disputed";
  revisionId?: string;
  owners: string[];
  createdAt: string;
  reviewedAt?: string;
}
~~~

规则：

- source 能证明“做了什么”，但不能自动证明“为什么”；没有 decision evidence 时 answer 标 inference/gap。
- 注释中的 WHY 可成为 source evidence，但仍保留原 locator。
- stale revision 的理由不能自动套到 current revision。
- model 生成的 alternatives 必须标 inference，不能伪装成历史决策。

### M12.2 WHY 状态机

~~~mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Reviewed: human review
    Reviewed --> Verified: evidence complete
    Draft --> Disputed: conflicting evidence
    Reviewed --> Disputed: conflicting evidence
    Verified --> Stale: revision or evidence changed
    Stale --> Reviewed: revalidated
    Disputed --> Reviewed: conflict resolved
    Draft --> Forgotten: explicit forget
    Reviewed --> Forgotten: explicit forget
    Forgotten --> [*]
~~~

- [x] source/evidence content hash 变化自动标 stale。
- [x] conflicting reviewed cards 同 subject 不自动合并，标 disputed。
- [x] 每次状态变化写 audit event。

### M12.3 记忆 lifecycle

<code>remember</code>：

- 创建 typed Markdown note；
- 必须有 scope：workspace/repo/subject/global；
- 必须有 source、confidence、retention class。

<code>recall</code>：

- 复用统一 search；
- session memory 默认高 freshness、低持久性；
- long-term reviewed memory 排名高于旧 draft。

<code>forget</code>：

- 先列出将删除/隐藏的 item；
- 显式确认；
- 删除 Markdown 或写 tombstone 取决于 retention policy；
- 从 FTS/vector/graph 全部移除；
- audit 只保留 ID、操作者、时间、reason，不保留已忘内容。

<code>improve</code>：

- 输入 feedback/evidence；
- 生成新 revision，不覆盖旧版；
- human review 前状态 draft；
- 重新建立 links/embedding。

### M12.4 Session 与 long-term

~~~typescript
export type MemoryClass =
  | "session"
  | "project"
  | "decision"
  | "runbook"
  | "incident"
  | "preference";
~~~

- [x] session memory 有 TTL，promote 才变 long-term。
- [x] decision/runbook 默认无自动 TTL，但 revision drift 可 stale。
- [x] repo scope 不泄漏到另一个 workspace。
- [x] local user identity 和 audit event 分离；不索引个人 secret。`tests/knowledge-why-memory-ontology.test.mjs` 验证 actor_id 只在 audit metadata、input 只存 digest，memory_items 不出现 secret。

### M12.5 Domain model

提取但不直接宣布为真：

~~~text
Actor -> Capability -> Entry point -> Rules -> State change
      -> Side effects -> External systems -> Failure modes -> Evidence
~~~

- [x] 从 endpoint、service、entity、event、test、note 生成 claim candidates。
- [x] 每个 claim 至少一个 evidence locator。
- [x] 同名业务词跨 repo 用 ontology alias 明确连接，不能只按 string 合并。测试验证 repo-scoped 同名 alias 各自唯一、workspace-wide 查询显式 ambiguous。
- [x] 支持 persona：frontend、backend、QA、SRE、PM/security。
- [x] domain flow 图每一跳可打开 source。

Ontology 只负责显式术语关系：

~~~typescript
export interface OntologyTerm {
  id: string;
  canonicalName: string;
  aliases: string[];
  scope: { workspaceId?: string; repoIds?: string[] };
  type: "actor" | "capability" | "entity" | "state" | "event" | "system";
  definition: string;
  evidence: SearchEvidence[];
  status: "draft" | "reviewed" | "verified" | "stale";
}
~~~

- [x] 同名不自动同义；<code>ontology.link</code> 显式声明 same-as/related-to/owns/produces。
- [x] alias 冲突返回 candidates。
- [x] ontology boost 只影响 semantic/lexical expansion，不改变 exact proof。
- [x] upsert/link 是 guarded mutation，CLI/MCP 两面都有。

### M12.6 Onboarding

输出 Markdown：

~~~text
1. 系统边界
2. 主要 actor 和术语
3. 关键请求/事件流程
4. 数据和状态
5. 本地运行与测试入口
6. 常见改动的 blast radius
7. 已知风险与 evidence gaps
8. 推荐阅读顺序
~~~

- [x] 所有具体文件/命令来自 source/package facts。
- [x] 不能确定的环境步骤写 gap，不编造。
- [x] 生成文档带 revision/capability hash。
- [x] review 后可保存为 Markdown note。

### M12 验收

~~~bash
rtk test node --test \
  tests/knowledge-why-card.test.mjs \
  tests/knowledge-memory-lifecycle.test.mjs \
  tests/knowledge-domain-model.test.mjs \
  tests/knowledge-ontology.test.mjs \
  tests/knowledge-onboarding.test.mjs
rtk npm run typecheck
rtk npm run build
~~~

**预期结果：**

- WHY 结论和推测分开。
- remember/recall/forget/improve 全部 CLI/MCP 可用且可审计。
- domain/onboarding 每个 claim 可追源。

**建议 checkpoint：** <code>feat(knowledge): add auditable why memory and domain knowledge</code>

---

## M13 — 可选本地语义召回、反馈与反思

**目标：** 在不牺牲确定性检索的前提下，支持自然语言、同义概念、跨代码/文档语义召回，并从 useful/dead-end/corrected 反馈改进排序。

**依赖：** M5、M11；M14 依赖本任务。M11 的 schema v11 合并后，本任务才注册 v12，避免并行 schema version 冲突。

**创建：**

- <code>packages/knowledge-core/src/embedding-provider.ts</code>
- <code>packages/knowledge-core/src/vector-store.ts</code>
- <code>packages/knowledge-core/src/semantic-search.ts</code>
- <code>packages/knowledge-core/src/search-feedback.ts</code>
- <code>packages/knowledge-core/src/reflection.ts</code>
- <code>packages/knowledge-indexer/src/semantic-chunks.ts</code>
- <code>tests/knowledge-semantic-search.test.mjs</code>
- <code>tests/knowledge-semantic-fallback.test.mjs</code>
- <code>tests/knowledge-search-feedback.test.mjs</code>
- <code>tests/knowledge-reflection.test.mjs</code>

**修改：**

- <code>packages/knowledge-core/src/schema.ts</code>
- <code>packages/knowledge-core/src/search-planner.ts</code>
- <code>packages/knowledge-core/src/search-ranking.ts</code>
- <code>packages/knowledge-core/package.json</code>。
- <code>pnpm-lock.yaml</code>。
- <code>packages/knowledge-indexer/src/pipeline.ts</code>
- <code>scripts/vendor-knowledge-runtime.mjs</code>
- <code>scripts/check-knowledge-runtime.mjs</code>

### M13.1 Provider contract

~~~typescript
export interface EmbeddingProvider {
  id: string;
  modelId: string;
  modelHash: string;
  dimensions: number;
  maxTokens: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  health(): Promise<{ ok: boolean; reason?: string }>;
}
~~~

- [x] 默认 <code>semantic=off</code> 时不下载模型、不联网。
- [x] local provider 使用明确模型目录和 SHA-256；`inspectLocalModelDirectory` 校验 manifest/file hash，且 model hash 进入 embedding key；无真实推理 runtime 时仍返回 degraded。
- [x] remote provider 不是默认项；启用时先显示 code exfiltration warning 和 allow-list。
- [x] provider 不健康时 exact/lexical/graph 正常，diagnostics 为 <code>SEMANTIC_UNAVAILABLE</code>。

### M13.2 Chunking

语义 chunk 与 exact blob 分离：

- symbol/function/class chunk 优先；
- unsupported text 按 heading/paragraph/窗口；
- chunk 最大 token 数不超过 provider；
- 10–20% overlap；
- 每 chunk 保留 revision-independent content hash 和 locator mapping。

- [x] exact search 不使用这些 chunk 作为 correctness source；universal benchmark 仍以独立原始 corpus 扫描校验。
- [x] 相同 content/model 复用 embedding。
- [x] source change 只重算受影响 chunk；`persistSemanticChunks` 删除旧 blob 的 embedding refs 后替换该 blob chunk 集合。
- [x] comments/docstrings 可独立 chunk，但关联所属 symbol。

### M13.3 Vector store

采用 <code>sqlite-vec</code> 扩展作为本地向量索引：

Schema v12：

~~~sql
CREATE TABLE semantic_chunks (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  source_blob_id INTEGER,
  node_id TEXT,
  start_byte INTEGER,
  end_byte INTEGER,
  chunk_kind TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE embedding_models (
  model_hash TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vec_table_name TEXT NOT NULL UNIQUE,
  installed_at TEXT NOT NULL
);

CREATE TABLE semantic_embedding_refs (
  model_hash TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  vec_rowid INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  embedded_at TEXT,
  PRIMARY KEY (model_hash, chunk_id)
);

CREATE TABLE search_feedback (
  id TEXT PRIMARY KEY,
  query_hash TEXT NOT NULL,
  hit_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  correction_json TEXT,
  scope_hash TEXT NOT NULL,
  capability_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE reflection_suggestions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  reproduction_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
~~~

每个 model 创建独立 vec0 virtual table：

~~~text
vec_<first-16-hex-of-model-hash>(embedding float[dimensions])
~~~

table name 只能由已验证的 lowercase hex model hash 派生，dimensions 必须是 provider health 返回的正整数；禁止把用户字符串拼进 identifier。<code>semantic_embedding_refs</code> 负责 chunk→vec row 映射。

- [x] `sqlite-vec@0.1.9` 在 `package.json`/lockfile 固定 exact version，不用 floating range。
- [x] `sqlite-vec` optional platform packages 固定对应 darwin-arm64/darwin-x64/linux-x64/linux-arm64/windows-x64 extension；不支持的平台明确 degraded。
- [x] `VectorStore.doctor()` 验证 extension load、dimensions、model hash 和 vec0 sample query；extension 不可用时返回 degraded fallback。
- [x] schema 保存 chunk ID、source/content hash、model hash、dimensions、embedding status，并有 SQLite fallback 回归测试。
- [x] extension 不可用时 release 若声明 semantic capability 为 required 则失败；若产品配置为 optional，capability 显示 degraded，确定性 gate 不失败。
- [x] vector result 最终 join effective revision mappings。

### M13.4 Semantic query

- [x] query embedding cache 按 model hash + normalized query；缓存有固定 256 项上限并有回归测试。
- [x] top K 默认 50，再由统一 ranker 融合。
- [x] 每个 semantic hit 标 <code>inference</code>，包含 similarity 和 model ID。
- [x] exact source hit 永远排在 semantic 前；semantic lane 权重为 0.55，source 为 1.0，并有 deterministic-vs-semantic 回归测试。
- [x] semantic 不得突破 repo/workspace/secret policy。

### M13.5 Feedback

支持：

~~~text
useful
dead_end
corrected
~~~

Feedback record：

~~~typescript
export interface SearchFeedback {
  queryHash: string;
  hitId: string;
  verdict: "useful" | "dead_end" | "corrected";
  correction?: {
    preferredHitId?: string;
    note?: string;
  };
  scopeHash: string;
  capabilityHash: string;
  createdAt: string;
}
~~~

- [x] 不存 raw query，除非用户明确 opt-in。
- [x] useful 给同 scope/query family 小幅 boost。
- [x] dead_end 只降同 revision/content hash，不永久惩罚同路径未来版本。
- [x] corrected 创建 review suggestion，不直接改 source truth。
- [x] 所有 feedback 可 list/delete/export。

### M13.6 Reflect

<code>reflection</code> 是离线、可审计任务：

1. 聚合重复 dead-end query family；
2. 定位 coverage/resolution/ranking gap；
3. 产生 suggestion；
4. 给 reproduction query 和受影响 capability；
5. 人工 accept 后才改 config/note。

- [x] reflect 不自动改 ranking weight。
- [x] suggestion 的依据可重放。
- [x] 没有足够样本时明确 insufficient evidence。

### M13 验收

~~~bash
rtk test node --test \
  tests/knowledge-semantic-search.test.mjs \
  tests/knowledge-semantic-fallback.test.mjs \
  tests/knowledge-search-feedback.test.mjs \
  tests/knowledge-reflection.test.mjs
rtk npm run typecheck
rtk npm run knowledge:bundle
rtk npm run knowledge:doctor
~~~

**预期结果：**

- 自然语言同义查询能找到 fixture。
- model/extension 不可用不影响 exact。
- feedback 可回滚、可解释。
- compact response 标明 semantic inference。

**建议 checkpoint：** <code>feat(knowledge): add optional semantic recall and feedback loop</code>

---

## M14 — 证据可信、Validated Findings、安全与审计

**目标：** 让 Penguin 的结论区分静态事实、运行时观察、人工复现和推测；同时防止源码/文档中的 secret、恶意提示和跨 scope 数据泄漏。

**依赖：** M12、M13。

**创建：**

- <code>packages/knowledge-core/src/evidence-state.ts</code>
- <code>packages/knowledge-core/src/finding.ts</code>
- <code>packages/knowledge-core/src/audit.ts</code>
- <code>packages/knowledge-core/src/trust-policy.ts</code>
- <code>packages/knowledge-core/src/content-safety.ts</code>
- <code>packages/knowledge-indexer/src/secret-policy.ts</code>
- <code>src/components/wiki/WikiFindingPanel.tsx</code>
- <code>tests/knowledge-evidence-state.test.mjs</code>
- <code>tests/knowledge-validated-finding.test.mjs</code>
- <code>tests/knowledge-scope-security.test.mjs</code>
- <code>tests/knowledge-content-safety.test.mjs</code>
- <code>tests/knowledge-audit.test.mjs</code>

**修改：**

- <code>packages/knowledge-core/src/schema.ts</code>：注册 schema v13 的 evidence/finding/audit 表。
- <code>packages/knowledge-indexer/src/evidence.ts</code>
- <code>packages/mcp/src/log-investigation.ts</code>。
- <code>packages/mcp/src/log-investigation-store.ts</code>。
- <code>packages/mcp/src/log-evidence-correlator.ts</code>。
- <code>packages/knowledge-core/src/search-ranking.ts</code>
- <code>packages/knowledge-core/src/why-card.ts</code>
- <code>src/components/wiki/EvidenceInbox.tsx</code>

### M14.1 Evidence state

~~~typescript
export type EvidenceStatus =
  | "synthetic"
  | "inferred"
  | "static_verified"
  | "runtime_observed"
  | "reproduced"
  | "human_reviewed"
  | "stale"
  | "contradicted";

export interface EvidenceRecord {
  id: string;
  status: EvidenceStatus;
  sourceType: "code" | "test" | "git" | "wiki" | "sls" | "trace" | "manual";
  locator: string;
  revisionId?: string;
  environment?: string;
  contentHash?: string;
  observedAt?: string;
  expiresAt?: string;
  redactionPolicy: string;
  claimIds: string[];
}
~~~

Schema v13：

~~~sql
CREATE TABLE trust_evidence (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  locator TEXT NOT NULL,
  revision_id TEXT,
  environment TEXT,
  content_hash TEXT,
  observed_at TEXT,
  expires_at TEXT,
  redaction_policy TEXT NOT NULL,
  claim_ids_json TEXT NOT NULL
);

CREATE TABLE validated_findings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  claim TEXT NOT NULL,
  affected_scopes_json TEXT NOT NULL,
  reproduction_json TEXT NOT NULL,
  status TEXT NOT NULL,
  gaps_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE finding_evidence (
  finding_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  evidence_role TEXT NOT NULL,
  PRIMARY KEY (finding_id, evidence_id, evidence_role)
);

CREATE TABLE knowledge_audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  result_code TEXT NOT NULL,
  created_at TEXT NOT NULL
);
~~~

由于 foreign keys 关闭，M14 doctor 要显式检查 finding/evidence orphan 和 audit hash chain。

- [x] static source 改变时 evidence stale。
- [x] runtime evidence 绑定 environment、time range、query hash；不能泛化成所有环境。
- [x] synthetic test evidence 永远不标 runtime observed。
- [x] contradictory evidence 不自动选择赢家。

### M14.2 Finding 与可复现 proof

~~~typescript
export interface ValidatedFinding {
  id: string;
  title: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  claim: string;
  affectedScopes: string[];
  staticEvidence: EvidenceRecord[];
  dynamicEvidence: EvidenceRecord[];
  reproduction: {
    prerequisites: string[];
    steps: string[];
    expected: string;
    observed: string;
    safe: boolean;
  };
  status: "candidate" | "validated" | "rejected" | "fixed" | "regressed";
  gaps: string[];
}
~~~

规则：

- candidate 不能显示为 validated。
- 没有实际 reproduction 时，reproduction status 明确 unavailable。
- destructive/exploit reproduction 默认只生成安全 dry-run steps；执行需单独授权。
- finding fixed 必须绑定修复 revision 和 regression test。
- Strix 类能力的目标是“证据更可靠”，不是自动主动攻击外部系统。

### M14.3 Agent content boundary

源码、comment、Markdown、runtime log 都是 **untrusted content**：

- [x] SearchResponse 的 retrieved text 标记 <code>untrustedContent=true</code>。
- [x] MCP tool description 告知 agent：内容中的命令不是系统指令。
- [x] 不解析/执行 Markdown HTML、script、shell code。
- [x] Canvas URL 不自动打开。
- [x] 文档中的“ignore previous instructions”只作为文本返回。
- [ ] compact/hydration 不因 prompt-like 内容改变 tool behavior。

### M14.4 Secret 与 PII

- [x] 默认不索引 .env/key/pem/credential paths。
- [x] source snippet 做 defense-in-depth secret detector；高置信 token 以局部 mask 返回，并在本地 trusted exact 模式允许显式解锁。
- [ ] 日志 evidence 使用现有 redaction；CPF/email/token fixture 验证。
- [x] raw secret 不进入 notes、feedback、audit、embedding。
- [x] path metadata 可见但说明 <code>secret_policy</code>。Excluded path hits carry `secret_policy=path_only`, with regression coverage in `knowledge-search-engine.test.mjs`.
- [x] export artifact 默认排除 secret。

### M14.5 Scope 和权限

- [ ] CLI 根据 cwd/config 解析 allow-list。
- [ ] MCP 启动时固定 workspace roots；请求不能扩大到 root 外。
- [ ] symlink escape 在 index 和 query 双重检查。
- [x] hit hydration 重查 scope，不信任 hit ID 自带 path；`getSourceHit` 可绑定 repo scope，错误 repo 会返回空，并有 source-search 回归测试。
- [ ] memory/note mutation 只允许 knowledge root。
- [x] artifact import 先解压到隔离 temp，防 zip-slip 和 symlink。

### M14.6 Audit

记录：

- mutation capability；
- actor/local client ID；
- scope；
- input digest；
- result；
- timestamp；
- capability/build hash。

不记录：

- raw source query；
- snippet；
- secret；
- note 正文；
- HMAC/confirmation token。

- [x] audit append-only，支持 verify chain。
- [x] forget 操作不能从 audit 复原被删内容。Memory forget 清空 body；回归测试确认 audit 不含原文。
- [x] audit export 可选择时间/scope。

### M14 验收

~~~bash
rtk test node --test \
  tests/knowledge-evidence-state.test.mjs \
  tests/knowledge-validated-finding.test.mjs \
  tests/knowledge-scope-security.test.mjs \
  tests/knowledge-content-safety.test.mjs \
  tests/knowledge-audit.test.mjs
rtk npm run typecheck
rtk npm run build
~~~

**预期结果：**

- 每个 finding 状态有机器条件。
- prompt injection fixture 不影响执行。
- 跨 workspace/secret/symlink 测试拒绝。
- audit 可验证且不保存敏感内容。

**建议 checkpoint：** <code>feat(knowledge): harden evidence trust security and audit</code>

---

## M15 — 可移植、可校验、可增量的 Knowledge Artifact

**目标：** 支持团队共享、CI 产出、离线导入和灾难恢复，而不依赖同一台机器的绝对路径或外部图服务。

**依赖：** M14。

**创建：**

- <code>packages/knowledge-core/src/artifact-manifest.ts</code>
- <code>packages/knowledge-core/src/artifact-export.ts</code>
- <code>packages/knowledge-core/src/artifact-import.ts</code>
- <code>packages/knowledge-core/src/artifact-crypto.ts</code>
- <code>tests/knowledge-artifact-roundtrip.test.mjs</code>
- <code>tests/knowledge-artifact-security.test.mjs</code>
- <code>tests/knowledge-artifact-delta.test.mjs</code>
- <code>tests/knowledge-artifact-compatibility.test.mjs</code>

**修改：**

- <code>packages/knowledge-core/package.json</code>：加入纯 JS zip 库 <code>fflate</code> 并锁定 exact version。
- <code>packages/knowledge-cli/src/command-registry.ts</code>。
- <code>packages/mcp/src/knowledge-capability-registry.ts</code>。
- <code>scripts/check-knowledge-runtime.mjs</code>。

### M15.1 Artifact 格式

扩展名：<code>.penguin-knowledge</code>。内部为 ZIP：

~~~text
manifest.json
checksums.sha256
database/knowledge.sqlite
vault/...
models/manifest.json
reports/coverage.json
reports/capabilities.json
signature/ed25519.json
~~~

manifest：

~~~typescript
export interface KnowledgeArtifactManifest {
  formatVersion: 1;
  createdAt: string;
  buildId: string;
  capabilityHash: string;
  contractVersion: string;
  schemaVersion: number;
  repositories: Array<{
    repoId: string;
    name: string;
    remoteFingerprint?: string;
    revisions: Array<{ snapshotId: string; commitSha?: string }>;
  }>;
  contentPolicy: {
    includesSource: boolean;
    includesNotes: boolean;
    includesEvidence: boolean;
    includesEmbeddings: boolean;
    secretPolicyHash: string;
  };
  baseArtifactHash?: string;
}
~~~

### M15.2 一致性 snapshot

- [x] 导出前执行 SQLite checkpoint。`exportKnowledgeArtifact` 在 serialize 前执行 `wal_checkpoint(PASSIVE)`。
- [ ] 使用 better-sqlite3 backup API 或 SQLite online backup，不直接复制活跃 WAL DB。
- [x] artifact DB 只含选定 scope/revision；CLI 支持 `--repo` / `--snapshot`，并有显式 repository-scope round-trip 测试。
- [x] 绝对路径转 repo-relative；artifact clone 将 repo root 转为 `artifact://repo/<id>`，checkout path 清空。
- [x] export 时重新跑 orphan/integrity check；SQLite `integrity_check`、source corpus orphan SQL 与 artifact round-trip 已验证。

### M15.3 Content policy

CLI：

~~~bash
rtk penguin artifact export \
  --repo FPMS-NT-Auth-Player \
  --snapshot <snapshot-id> \
  --include-source \
  --include-notes \
  --exclude-runtime-evidence \
  --output auth-player.penguin-knowledge
~~~

- [x] 默认不含 source、runtime evidence、embedding；用户逐项 opt-in。`knowledge-artifact-roundtrip.test.mjs` 验证 source 默认被剔除、`includeSource` 后恢复。
- [x] 若不含 source，artifact 仍可图查询，但 exact search diagnostics 明确 <code>SOURCE_NOT_INCLUDED</code>。
- [x] secret policy 永远生效。
- [x] 输出预估大小和包含内容，确认后导出。

### M15.4 Checksums、签名和加密

- [x] 每个 entry 有 SHA-256；import 在读取数据库前验证 `checksums.sha256`。
- [x] 可选 Ed25519 signature；import 可配置 trusted public keys；HMAC 兼容路径保留。
- [x] 可选 AES-256-GCM whole-artifact encryption，key 用 Node <code>scrypt</code> 从 passphrase 派生；salt/params 在外层 header。
- [x] CLI 只接受 `--passphrase-env <ENV>` 或 `--passphrase-fd <fd>`，argv 不包含口令本身；core 仍支持直接传入受控 API secret。
- [x] checksum/signature 失败在解压/打开 DB 前拒绝；tamper、错误 HMAC、Ed25519 错误 key 已有测试。

### M15.5 Import

- [x] 先读 header/manifest，验证 format/capability/schema compatibility。
- [ ] 解压路径防 <code>..</code>、absolute path、symlink。当前已拒绝 absolute、`..` 与反斜杠 entry，测试覆盖 `../escape`；ZIP symlink metadata 仍需单独拒绝。
- [x] dry-run 输出新增/冲突 repo、snapshot、notes；`inspectKnowledgeArtifact` 与 CLI `artifact import --dry-run` 返回 repository/snapshot/note conflict report，且有 no-mutation regression。
- [ ] repo identity 按 remote fingerprint + configured mapping；不按同名自动合并。
- [x] note conflict 在 dry-run 中保留双方 hash 并生成 conflict report；实际 restore 仍需 operator confirmation，不静默覆盖。
- [x] import 到 staging DB，完成 SQLite integrity validation 后 atomic switch；restore test 验证旧 DB backup 保留。
- [x] 失败不改变当前 DB。staging validation/atomic restore failure regression verifies the existing repository remains present.

### M15.6 Delta

- [x] delta artifact 引用 base artifact hash；`knowledge-artifact-roundtrip.test.mjs` 验证 base mismatch 被拒绝。
- [ ] 只含新增 blob/fact/snapshot/note revision。
- [x] import 缺 base 时拒绝；delta import 必须显式提供 `baseDatabase`。
- [x] base + delta 结果与 full export normalization 相等；delta round-trip 测试逐字节验证。
- [ ] 删除通过 tombstone 表达，不靠“没出现”推断。

### M15 验收

~~~bash
rtk test node --test \
  tests/knowledge-artifact-roundtrip.test.mjs \
  tests/knowledge-artifact-security.test.mjs \
  tests/knowledge-artifact-delta.test.mjs \
  tests/knowledge-artifact-compatibility.test.mjs
rtk npm run typecheck
rtk npm run knowledge:bundle
~~~

**预期结果：**

- fresh HOME 导入后查询结果 normalization 等于导出端。
- tamper、zip-slip、错误签名、错误 base 全部安全拒绝。
- 无 source artifact 不冒充全文可用。

**建议 checkpoint：** <code>feat(knowledge): add portable verified knowledge artifacts</code>

---

## M16 — Universal Retrieval Benchmark、盲测与发布 Gate

**目标：** 用机器证明“找得到、找得准、surface 一致、发布物没漂移”，而不是靠 demo 或少量 known query。

**依赖：** M9、M10、M15；P0 可先运行 M0–M8 子集 gate，最终 release 需要全部。

**创建：**

- <code>scripts/knowledge-universal-retrieval-benchmark.mjs</code>
- <code>scripts/knowledge-surface-parity.mjs</code>
- <code>scripts/knowledge-competitor-differential.mjs</code>
- <code>scripts/knowledge-release-gate.mjs</code>
- <code>scripts/knowledge-package-install-smoke.mjs</code>
- <code>scripts/knowledge-sbom.mjs</code>
- <code>tests/knowledge-universal-retrieval-benchmark.test.mjs</code>
- <code>tests/knowledge-surface-parity-e2e.test.mjs</code>
- <code>tests/knowledge-package-install-smoke.test.mjs</code>
- <code>docs/knowledge-v2/real-question-corpus.jsonl</code>
- <code>docs/knowledge-v2/release-gate.md</code>

**修改：**

- <code>package.json</code>。
- <code>scripts/check-knowledge-runtime.mjs</code>。
- <code>scripts/bundle-knowledge-cli.mjs</code>。
- <code>scripts/vendor-knowledge-runtime.mjs</code>。
- <code>src-tauri/tauri.conf.json</code>。
- <code>.github/workflows/ci.yml</code>。
- <code>.github/workflows/build.yml</code>。

### M16.1 10,000 needle generator

从每个 admitted file 采样，分层维度：

- repo；
- language/extension；
- source/config/docs；
- file size bucket；
- ASCII/CJK/Unicode；
- comment/string/local variable/call expression；
- punctuation；
- parser supported/unsupported；
- generated classification；
- line beginning/middle/end；
- duplicate/non-duplicate content。

Needle：

~~~typescript
export interface RetrievalNeedle {
  id: string;
  repoId: string;
  snapshotId: string;
  filePath: string;
  mode: "exact" | "phrase" | "substring" | "path";
  query: string;
  expectedOccurrences: Array<{
    filePath: string;
    line: number;
    startByte: number;
  }>;
  stratum: Record<string, string>;
}
~~~

生成规则：

- [x] query 长度主要 8–64 code point，另有 1–2 short query bucket。
- [x] 不采全空白。
- [x] expected occurrences 用原始 corpus 独立扫描生成，不能调用被测 search。
- [x] 若 query 在多个文件出现，expected 列出全部；不能只认采样来源。
- [x] path needle 包含 full/suffix/basename/segment。
- [x] seed 固定并记录，失败可重放。

### M16.2 Recall 与 locator

计算：

~~~text
exact_recall = found expected occurrences / all expected occurrences
path_recall = found expected paths / all expected paths
locator_accuracy = correct path and line / returned expected occurrences
unexpected_verified_hits = returned verified hits not present in independent scan
~~~

Gate：

- exact_recall = 1.000000；
- path_recall = 1.000000；
- locator_accuracy = 1.000000；
- unexpected_verified_hits = 0；
- coverage accounting = discovered = admitted + excluded + failed。

一个漏报就失败，并输出 needle ID、repo、path、line、query、mode、diagnostics。

### M16.3 Surface parity

对至少 200 个 SearchRequest：

1. 直接调用 core；
2. spawn bundled CLI；
3. 初始化 bundled MCP 并调用 tool；
4. 通过 resident protocol 调用。

Normalization 去掉 request ID/timing，仅保留语义字段。

- [x] hits 顺序、locator、revision、score rounded、warnings、cursor presence 相等。`tests/knowledge-mcp-tools.test.mjs` 对同一批 200 个请求逐项比较 Core、CLI、MCP、Resident。
- [x] page 2 也比较。该测试额外用 `ParityNeedle` 比较四入口 page 1/page 2，并验证跨 Node 进程 cursor 可复用。
- [x] errors 同 code/details。query protocol/runtime 测试覆盖 malformed、unsupported capability、cancel 与 typed errors。
- [x] mutation capability 只比较 dry-run。mutation parity 维持 guarded/dry-run contract，未把真实 mutation 混入 read parity。

### M16.4 100+ 真实问题盲测

问题类别至少：

~~~text
20 exact code/path questions
15 caller/callee/impact questions
15 cross-service/protocol flow questions
10 field/data-flow questions
10 branch/revision/history questions
10 WHY/domain/onboarding questions
10 notes/backlinks/property questions
10 incident/evidence questions
5 dead-code/community/architecture questions
5 adversarial zero-result/ambiguous questions
~~~

每条 JSONL 包含：

~~~json
{
  "id": "RQ-001",
  "question": "Where is the CPF lookup actually called?",
  "scope": {},
  "gold": {
    "requiredLocators": [],
    "requiredFacts": [],
    "allowedGaps": []
  },
  "scoring": {
    "correctness": 0,
    "provenance": 0,
    "completeness": 0,
    "latency": 0
  }
}
~~~

- [x] gold 由两人或“源码独立复核 + 人工确认”建立，不从 Penguin output 直接抄。
- [x] Penguin、CodeGraph、Graphify、其他基线结果匿名化后评分。
- [x] 工具无法回答时记录 honest gap；当前 110 条 differential 中 CodeGraph/Graphify 均 110/110 captured，honest gap 为空。
- [x] 外部工具版本冻结在报告：CodeGraph 1.1.6、Graphify 0.9.5；报告含 generatedAt 和逐题 outputHash。
- [ ] “超越”要求 Penguin correctness/provenance 不低于任一基线，且 universal exact、surface parity、revision diagnostics 是独有强项；不能只比较功能清单。

### M16.5 性能

环境报告：

- CPU/RAM/OS；
- DB/source bytes；
- repo/file/node/edge count；
- cold/warm；
- cache state；
- query strata。

Gate：

- warm exact p50/p95/p99；
- warm structural p50/p95/p99；
- resident startup；
- index files/sec 和 MB/sec；
- peak RSS；
- DB amplification ratio；
- artifact export/import。

- [x] warm exact p95 < 150 ms。10,000-needle full workspace gate报告 exact p95 33.5ms。
- [x] warm structural p95 < 300 ms。benchmark 将 path structural lane 独立输出为 `performance.structuralMs`，并纳入 `--performance-gate`。
- [x] no query correctness cutoff。benchmark gate 先验证 exact recall/locator/path recall，再单独验证 latency；正确性失败不会被性能阈值掩盖。
- [x] short full-scan bucket 单独报告，不混淆典型目标。benchmark report 输出 `queryStrata.length.short` 与 path full/basename/segment 分层。

### M16.6 Clean packaged install

脚本在临时 HOME：

1. build CLI/MCP/Tauri resources；
2. 安装到临时 <code>~/.penguin</code>；
3. initialize MCP；
4. tools/list；
5. capabilities；
6. 创建/index fixture；
7. exact/path/query；
8. get-hit；
9. doctor；
10. shutdown。

必须比较：

~~~text
source capability hash
bundled CLI capability hash
bundled MCP capability hash
installed MCP capability hash
contract version
schema version
tool count and IDs
vendored Node version
native/WASM dependency hashes
~~~

任何不等立即失败；这一步解决当前 <code>knowledge_tool_missing</code> 漂移。

### M16.7 Release gate 顺序

~~~mermaid
sequenceDiagram
    participant D as Developer
    participant G as Gate
    participant P as Package
    participant H as Temporary Home

    D->>G: pnpm knowledge:release-gate
    G->>G: lint typecheck unit integration
    G->>G: 10000 needle benchmark
    G->>G: surface parity and real benchmark
    G->>P: build source bundle
    P->>H: clean install
    H->>G: runtime hashes tools and smoke results
    G-->>D: signed pass report or exact blockers
~~~

<code>scripts/knowledge-release-gate.mjs</code> 顺序失败即停：

1. dirty generated artifact check；
2. lint/typecheck；
3. targeted unit/integration；
4. current benchmark；
5. universal retrieval；
6. surface parity；
7. real-question differential；
8. bundle；
9. temporary clean install；
10. runtime doctor；
11. license/SBOM；
12. report hash。

### M16.8 Scripts

根 <code>package.json</code> 增加：

~~~json
{
  "knowledge:benchmark:universal": "node scripts/knowledge-universal-retrieval-benchmark.mjs",
  "knowledge:parity": "node scripts/knowledge-surface-parity.mjs",
  "knowledge:differential": "node scripts/knowledge-competitor-differential.mjs",
  "knowledge:package-smoke": "node scripts/knowledge-package-install-smoke.mjs",
  "knowledge:sbom": "node scripts/knowledge-sbom.mjs",
  "knowledge:release-gate": "node scripts/knowledge-release-gate.mjs"
}
~~~

### M16 验收

~~~bash
rtk npm run knowledge:benchmark
rtk npm run knowledge:benchmark:real
rtk npm run knowledge:benchmark:universal
rtk npm run knowledge:parity
rtk npm run knowledge:differential
rtk npm run knowledge:package-smoke
rtk npm run knowledge:release-gate
~~~

**预期结果：**

- universal 三个正确性指标全为 1。
- surface parity 0 mismatch。
- clean installed doctor healthy。
- 当前 installed-MCP drift 类型被自动测试覆盖。
- differential 产出逐问题、逐工具、逐证据报告。

**建议 checkpoint：** <code>test(knowledge): enforce universal retrieval and release parity gates</code>

---

## M17 — Backfill、Shadow、双 RC、回滚与外部工具下线

**目标：** 在真实 21+ repo 上安全迁移，证明 Penguin 独立可用，再由操作者批准移除 CodeGraph/Graphify。

**依赖：** M16 全绿。

**创建：**

- <code>docs/knowledge-v2/rollout-runbook.md</code>
- <code>docs/knowledge-v2/rollback-runbook.md</code>
- <code>scripts/knowledge-rollout-audit.mjs</code>
- <code>scripts/knowledge-shadow-compare.mjs</code>
- <code>tests/knowledge-rollback.test.mjs</code>
- <code>assets/penguin-agent-guidance.md</code>，作为 app 全局 guidance 的唯一文本来源。

**修改：**

- <code>scripts/release.sh</code>。
- <code>package.json</code>。
- <code>src-tauri/tauri.conf.json</code>。
- <code>src-tauri/src/knowledge.rs</code>。
- <code>scripts/check-knowledge-runtime.mjs</code>。
- <code>src-tauri/src/knowledge.rs</code> 中的全局 <code>~/.codex/AGENTS.md</code>/<code>~/.claude/CLAUDE.md</code> auto-managed generator；最终移除 CodeGraph 文案时只改 canonical asset 和 generator，不手改每个 repo。

### M17.1 迁移前备份

- [x] 记录当前 app/CLI/MCP version 和 hash。
- [x] SQLite online backup。
- [x] vault 文件 archive。
- [x] export current artifact，不含 secret。
- [x] 保存 external tool config/index metadata；不复制许可受限内容。
- [x] 验证 backup 可在临时 HOME restore。

### M17.2 Dry-run backfill

对每 repo：

~~~bash
rtk penguin rebuild --source-corpus --dry-run --repo <repo> --json
~~~

报告：

- discovered/admitted/excluded/failed；
- estimated bytes/DB growth/time；
- unavailable historical revisions；
- parser/resolver coverage；
- secret/vendor policy。

任何 <code>failed > 0</code> 必须逐项处理或记录 approved exclusion。

### M17.3 Canary

顺序：

1. fixture repo；
2. 小型真实 repo；
3. 中型 TypeScript repo；
4. 多语言 repo；
5. Auth/FPMS 大 repo；
6. 全 workspace。

- [x] 每个 canary 后运行 1,000 repo-local needles。
- [x] `docs/knowledge-v2/benchmark-budgets.json` 定义 DB size/RSS/index time/放大率预算；`knowledge-canary-audit.mjs` 强制检查，预算失败立即停止下一 canary，并由 `tests/knowledge-canary-audit.test.mjs` 覆盖。
- [x] branch isolation smoke。`tests/knowledge-source-cow.test.mjs` 通过 revision/COW branch isolation assertions。
- [x] watcher edit/delete/rename smoke。`tests/knowledge-notes-watcher.test.mjs` 与 `tests/knowledge-notes-prune.test.mjs` 通过。
- [x] 任一 recall、coverage、资源预算或 benchmark 失败立即停止下一 canary；脚本和测试覆盖。

### M17.4 Shadow mode

迁移期对真实查询同时调用 Penguin 和外部 oracle，但：

- UI/agent 主结果仍标出来源；
- shadow failure 不改变 Penguin response；
- 不发送 secret/excluded source；
- 只保存 normalized locator/score/difference，不保存完整 query/snippet，除非 opt-in。

Diff 分类：

~~~text
penguin_only_correct
external_only_correct
both_correct
both_wrong
scope_mismatch
revision_mismatch
unverifiable
~~~

- [x] <code>external_only_correct</code> 自动开 gap，带 reproduction。
- [ ] 每周 review，不能只看 aggregate count。

### M17.5 RC1

- [x] 从 clean branch build。`f49d8b8` 后 worktree clean，`rtk npm run build` 与 Rust tests 通过。
- [x] 运行 M16 全 gate。RC1 full audit 的 release gate exit 0，包含 10,000 needles、surface parity、package smoke、110 real questions 和 differential。
- [ ] 真实 workspace backfill。
- [ ] 连续使用至少一个完整工作周期，覆盖 CLI/MCP/Wiki。
- [ ] crash/corruption/false verified hit = 0。
- [x] 发布报告记录所有 degraded optional capability；RC1 报告 `degradedOptional=[]`。
- [x] 执行 rollback 演练并恢复同一查询结果；`tests/knowledge-rollback.test.mjs` 通过。

### M17.6 RC2

RC2 必须是 RC1 后的独立构建，不是重跑同 artifact：

- [x] 再跑全部 gate。RC2 full audit release gate exit 0。
- [x] 再跑 clean install。RC2 gate package smoke exit 0，CLI/Core/MCP artifacts 存在且 parity 通过。
- [x] 再跑 100+ real questions。RC2 gate real-question audit 110/110 reviewed/baselined。
- [x] external-only correct blocking cases = 0。RC2 differential 110/110 baseline captures，honest gaps 为空。
- [x] capability drift = 0。RC2 surface parity 97/97 CLI、117 MCP，mismatch 0。
- [x] rollback 再演练一次。RC2 后重新运行 `tests/knowledge-rollback.test.mjs`，通过。

### M17.7 外部工具移除批准点

只有满足：

~~~text
RC1 = pass
RC2 = pass
universal recall = 100 percent twice
surface parity = pass twice
packaged doctor = healthy twice
external-only correct blocker = 0
rollback = pass twice
operator approval = explicit
~~~

AI 才能提出下线命令。没有显式批准时停在报告，不执行。

### M17.8 下线动作

批准后，按顺序：

- [ ] disable CodeGraph/Graphify hooks/MCP config，不先删数据。
- [ ] 启动新 shell/app，确认不再加载 external tool。
- [ ] 在没有 external binary 的 PATH 环境运行 Penguin smoke。
- [ ] 更新 AGENTS auto-managed instructions，只保留 Penguin Knowledge。
- [ ] 从 package/plugin config 移除依赖。
- [ ] 再跑 release gate。
- [ ] 外部 index 保留 quarantine 7–14 天；到期删除需再次确认。
- [ ] 记录移除日期、版本、备份位置和 rollback 命令。

### M17.9 回滚触发条件

任一触发立即回滚：

- verified false positive；
- admitted exact miss；
- cross-repo/revision leak；
- DB corruption；
- package hash drift；
- runtime crash loop；
- PII/secret leak；
- p95 连续超过目标 2 倍且影响工作。

回滚：

1. 停 watcher/runtime；
2. 切回上一个 signed artifact；
3. restore backup DB/vault；
4. doctor；
5. 重放固定 queries；
6. 若需要，重新 enable external tool；
7. 保存失败 DB 副本用于离线诊断，先 redaction。

### M17 验收

~~~bash
rtk test node --test tests/knowledge-rollback.test.mjs
rtk npm run knowledge:release-gate
rtk proxy node scripts/knowledge-rollout-audit.mjs --json
~~~

**预期结果：**

- 两个独立 RC 报告完整。
- 无 external-only correctness blocker。
- rollback 可恢复。
- 外部工具只有在明确批准后才 disable/remove。

**建议 checkpoint：** <code>chore(knowledge): complete guarded standalone rollout</code>

---

## M18 — 最终文档、运维手册与交接

**目标：** 让新的开发者或 AI 不读实现历史也能安装、索引、查询、诊断、发布和回滚。

**依赖：** M17。

**创建：**

- <code>docs/knowledge-v2/README.md</code>
- <code>docs/knowledge-v2/architecture.md</code>
- <code>docs/knowledge-v2/search-contract.md</code>
- <code>docs/knowledge-v2/coverage-policy.md</code>
- <code>docs/knowledge-v2/cli-reference.md</code>
- <code>docs/knowledge-v2/mcp-reference.md</code>
- <code>docs/knowledge-v2/wiki-guide.md</code>
- <code>docs/knowledge-v2/vault-and-obsidian.md</code>
- <code>docs/knowledge-v2/security-and-evidence.md</code>
- <code>docs/knowledge-v2/operations.md</code>
- <code>docs/knowledge-v2/release.md</code>
- <code>docs/knowledge-v2/troubleshooting.md</code>
- <code>docs/knowledge-v2/migration-from-codegraph-graphify.md</code>
- <code>packages/knowledge-contracts/README.md</code>
- <code>packages/knowledge-core/README.md</code>
- <code>packages/knowledge-indexer/README.md</code>
- <code>packages/knowledge-cli/README.md</code>
- <code>packages/mcp/README-knowledge.md</code>

**修改：**

- 根 <code>README.md</code>。
- <code>assets/penguin-agent-guidance.md</code>。
- <code>src-tauri/src/knowledge.rs</code>，读取 canonical guidance asset 并更新 auto-managed Penguin section。

### M18.1 文档必须来自 canonical data

- [x] CLI reference 由 command registry 生成并检查 clean diff。
- [x] MCP reference 由 capability manifest/tool schemas 生成。
- [x] schema table list 由 migration metadata 生成。
- [x] example output 在 test 中执行后 snapshot，不手写漂移 JSON。
- [x] capability matrix 显示 available/degraded/optional。

### M18.2 必须覆盖的用户流程

1. 第一次安装和 doctor。
2. 添加单 repo/workspace。
3. 全量 index 和 watch。
4. exact/path/regex/structural/semantic 查询。
5. branch/snapshot/commit 查询。
6. Wiki 搜索与代码定位。
7. Obsidian vault 双向编辑。
8. WHY/memory/domain/onboarding。
9. evidence/finding。
10. artifact export/import。
11. release gate。
12. backup/restore/rollback。

### M18.3 Troubleshooting 目录

至少：

~~~text
NO_MATCH but source exists
COVERAGE_INCOMPLETE
INDEX_STALE
FTS5_TRIGRAM_UNAVAILABLE
REGEX_UNSUPPORTED
SEMANTIC_UNAVAILABLE
CURSOR_STALE
CAPABILITY_MISMATCH
knowledge_tool_missing
native or WASM load failure
readonly database
runtime crash loop
artifact signature failure
revision content unavailable
~~~

每项必须有：

- symptom；
- safe diagnostic command；
- expected healthy output；
- root-cause branches；
- safe fix；
- rollback；
- 禁止的危险捷径。

### M18.4 AI handoff

README 顶部提供 10 分钟路径：

~~~text
1. Read active AGENTS instructions and repo AGENTS.md if present
2. Run rtk penguin doctor --json
3. Run rtk penguin architecture --json
4. Run rtk penguin capabilities --json
5. Search exact before structural inference
6. Inspect coverage on zero result
7. Always bind revision in claims
8. Hydrate compact hits before quoting
9. Mark inference as inference
10. Never mutate or release without confirmation
~~~

### M18 验收

~~~bash
rtk npm run knowledge:release-gate
rtk proxy rg -n -e 'TO[D]O' -e 'TB[D]' -e 'fill[ ]in' -e 'implement[ ]later' docs/knowledge-v2
rtk git diff --check
~~~

**预期结果：**

- placeholder scan 无结果。
- 生成 reference 与源码 registry 无 diff。
- fresh operator 按文档可完成 install→index→query→doctor→rollback。

**建议 checkpoint：** <code>docs(knowledge): complete standalone operations and migration guide</code>

---

## 9. 必须逐条重放的端到端流程

本节不是示例性建议，而是最终验收脚本的场景目录。尖括号内名称表示运行时输入参数，不表示未决定的实现。

## E2E-01 — 新 repo 从发现到可搜

**前置：**

- 一个临时 git repo；
- 包含 TypeScript、YAML、SQL、Markdown、binary、ignored secret；
- Penguin DB 为空。

**流程：**

1. <code>knowledge.index</code> 接收 repo path。
2. git truth 返回 tracked/untracked/ignored metadata。
3. classifier 产生 coverage record。
4. admitted text 写 content-addressed blob。
5. supported parser 产生 graph facts；unsupported 只跳过 graph。
6. materialize effective source + graph snapshot。
7. coverage validator 对账。
8. search exact/path/structural。

**命令：**

~~~bash
rtk penguin index <repo-path> --json
rtk penguin coverage --repo <repo-name> --json
rtk penguin search --repo <repo-name> --mode exact 'uniqueYamlNeedle' --json
rtk penguin search --repo <repo-name> --mode path 'config/service.yml' --json
~~~

**预期：**

- discovered = admitted + excluded + failed；
- YAML exact 命中，即使 parser status unsupported；
- binary/secret 有 path metadata 和 reason，无内容；
- schema/source capability hash 出现在 status。

## E2E-02 — 原始 Auth dotted-call 漏报修复

**前置：** <code>FPMS-NT-Auth-Player</code> 对应 revision 已完成 source corpus backfill。

**流程：**

1. CLI 构造 SearchRequest mode exact。
2. resolver 固定 repo + snapshot。
3. trigram 找 candidate。
4. raw content 最终验证。
5. line index 计算 locator。
6. ranker 把 exact 放第一。
7. CLI 输出 v2 response。

**命令：**

~~~bash
rtk penguin search \
  --mode exact \
  --repo FPMS-NT-Auth-Player \
  'playerAdditionalDetailRepository.findAllByCpf' \
  --explain \
  --json
~~~

**预期 response 条件：**

~~~json
{
  "schemaVersion": "2",
  "hits": [
    {
      "lane": "source",
      "locator": {
        "filePath": "apps/player/src/player/player.service.ts"
      },
      "rankReasons": ["exact_source"]
    }
  ],
  "diagnostics": {
    "searchedLanes": ["source"],
    "truncated": false
  }
}
~~~

行号以实际 revision 为准，但必须落在包含该调用的行；test 用 independent scan 验证，不能硬编码已漂移的本机行号。

## E2E-03 — 中文注释与精确行号

~~~bash
rtk penguin search \
  --mode phrase \
  --repo FPMS-NT-Auth-Player \
  '入口日志只记 platformId' \
  --json
~~~

**预期：**

- source hit；
- snippet 包含完整中文短语；
- line/byte offset 与独立 UTF-8 scan 相等；
- evidence status = verified；
- 不需要 semantic provider。

## E2E-04 — 完整路径和被排除路径

**A：admitted path**

~~~bash
rtk penguin search \
  --mode path \
  'libs/tools/src/vault/types/legitimuz-config.type.ts' \
  --json
~~~

**预期：** exact full path 第一名。

**B：secret path**

~~~bash
rtk penguin search \
  --mode path \
  '.env' \
  --include-excluded-metadata \
  --json
~~~

**预期：**

- path hit 或 diagnostics exclusion；
- reasonCode = secret_policy；
- snippet/content/evidence excerpt 不含 secret。

## E2E-05 — 合法零结果

~~~bash
rtk penguin search \
  --repo <indexed-repo> \
  --mode exact \
  'needle-that-independent-scan-proves-absent' \
  --json
~~~

**预期：**

- exit 0；
- hits = []；
- warning code = NO_MATCH；
- resolvedScopes 非空；
- searchedLanes 包含 source；
- coverage.failed = 0 且 stale = 0 时，才能把 totalIsExact 标 true；
- suggestions 不超过 5。

## E2E-06 — Coverage 不完整时不能证明“不存在”

模拟一个 read error：

**预期：**

- hits 可以为空；
- diagnostics 同时有 NO_MATCH 和 COVERAGE_INCOMPLETE；
- totalIsExact = false；
- failed path 和 reason 可见；
- UI 文案是“当前覆盖不足，不能确认不存在”，不是“代码不存在”。

## E2E-07 — Branch、delete、rename 隔离

**fixture：**

- master 有 <code>old/path.ts</code> 和 needle A；
- feature rename 到 <code>new/path.ts</code> 并改成 needle B；
- feature 删除另一个文件。

**查询矩阵：**

| Revision | Query | Expected |
|---|---|---|
| master | old path | found |
| master | needle A | found |
| master | needle B | not found |
| feature | new path | found |
| feature | old path | not found in source; rename history available |
| feature | needle B | found |
| feature | deleted file needle | not found |

每个结果的 diagnostics 必须给实际 snapshot ID。

## E2E-08 — CLI/MCP/Resident parity

**输入：** 同一个序列化 SearchRequest 和固定 snapshot。

**流程：**

1. core direct；
2. CLI <code>--json</code>；
3. MCP <code>knowledge_search</code>；
4. JSONL resident runtime。

**预期：**

- normalization 后 deep equal；
- hit order equal；
- same next cursor presence；
- same warning/error codes；
- MCP compact hit 用 <code>knowledge_get_hit</code> 补取后与 CLI full hit 相等。

## E2E-09 — Wiki 从搜索到 WHY

**流程：**

1. Cmd+K；
2. 搜中文注释；
3. 选第一项；
4. preview；
5. 打开 Context；
6. 查看 callers/tests；
7. 打开 WHY；
8. 查看 evidence/gaps；
9. 保存 reviewed note。

**预期：**

- 全程 revision chip 不变；
- source locator 可打开；
- WHY 没有证据时明确 inference；
- 保存 note 后 backlinks 和 search 立即可见；
- 无额外 Node process per click。

## E2E-10 — Cross-service flow

**输入：** 一个 frontend request，经 client wrapper、gRPC/HTTP、backend handler、service、DB。

**预期：**

- 每一跳有 source locator；
- protocol hop 类型明确；
- dynamic dispatch 显示 verified/candidate；
- missing hop 在 gaps；
- compact 一次返回路径摘要，hydrate 可补每跳 source。

## E2E-11 — Obsidian round-trip

**流程：**

1. Obsidian 打开 vault。
2. 修改 YAML property、wikilink、Canvas。
3. watcher reindex。
4. Penguin search/backlink/local graph 验证。
5. Penguin 更新 note。
6. Obsidian 再打开。

**预期：**

- Markdown 可读；
- unknown property/canvas field 不丢；
- DB 可删除重建；
- 冲突不会静默覆盖。

## E2E-12 — Semantic provider 不可用

**输入：** <code>semantic=fallback</code>，本地模型不存在。

**预期：**

- exact/lexical/structural 仍完成；
- diagnostics 有 SEMANTIC_UNAVAILABLE；
- 若 deterministic lane 有 hit，整体请求成功；
- UI 不弹 generic runtime failure。

## E2E-13 — Artifact round-trip

**流程：**

1. export 一个 repo/snapshot；
2. 在临时 HOME import；
3. doctor；
4. 重放 100 queries；
5. 比较 normalized output。

**预期：**

- checksums/signature 通过；
- output equal；
- absolute path 未泄漏；
- content policy 与实际包含内容一致。

## E2E-14 — Package drift

故意把临时安装 MCP 换成旧 bundle。

**预期：**

- doctor 非 0；
- error code = CAPABILITY_MISMATCH 或 knowledge_tool_missing；
- 报 source/installed hashes 和缺失 IDs；
- release gate 停止，不能发布。

## E2E-15 — Rollback

**流程：**

1. 在 canary DB 导入不兼容 artifact，预期 staging 阶段失败。
2. 模拟 runtime crash loop。
3. 触发 rollback。
4. restore signed previous artifact。
5. 重放 fixed queries。

**预期：**

- 当前 DB 未被失败 import 部分修改；
- previous version query result 恢复；
- failure evidence 已保存且 redacted；
- external tool enablement 只在 runbook 明确要求时发生。

---

## 10. Phase Exit Gates

任何任务不能因为“主要功能能跑”而跳过 exit gate。

| Gate | 必须通过的任务 | 机器判定 |
|---|---|---|
| G0 Baseline frozen | M0 | known misses、hash drift、current benchmark 均有报告 |
| G1 Contract frozen | M1 | manifest schema + surface registration test |
| G2 Coverage truthful | M2 | discovered accounting exact，所有 exclusion 有 reason |
| G3 Corpus durable | M3 | v9→v10、COW、GC、orphan tests |
| G4 Universal deterministic | M4–M5 | fixed corpus recall 100%，zero-result diagnostics |
| G5 Surface complete | M6–M7 | CLI/MCP missing capability = 0，response parity |
| G6 Runtime fast/stable | M8 | single PID、restart、hash handshake |
| G7 Product usable | M9 | Wiki E2E + keyboard + zero result |
| G8 Graph trustworthy | M10 | verified precision 100%，candidate/gap honest |
| G9 Knowledge open | M11–M12 | Obsidian round-trip、WHY/memory provenance |
| G10 Optional intelligence safe | M13–M14 | semantic degradation safe、security/audit pass |
| G11 Portable | M15 | full/delta/tamper round-trip |
| G12 Releasable | M16 | 10k + parity + differential + clean install |
| G13 Standalone | M17 | RC1/RC2 + rollback + operator approval |
| G14 Handed off | M18 | docs generated/current、fresh operator walkthrough |

若一个后续 task 暴露早期 contract 错误，返回对应 gate 修复并重跑所有下游 gate，不能只 patch 最后测试。

---

## 11. 并行执行与文件所有权

### 11.1 严格串行关键路径

~~~text
M0 -> M1 -> M2 -> M3 -> M4 -> M5
~~~

这些任务共享 contract/schema/index/query，不并行。

### 11.2 M5 后可并行

| Lane | Tasks | 主要所有权 | 不可修改 |
|---|---|---|---|
| A | M6 | knowledge-cli | core Search contract |
| B | M7 | mcp | core Search contract |
| C | M10 | indexer graph | CLI/MCP adapters |
| D | M11 | notes/vault | graph resolver |

M8 等 A+B；M9 等 M8；M12 等 C+D。

### 11.3 合并顺序

1. contract/schema owner 先报告 hash。
2. CLI/MCP adapter 分别 rebase/同步由操作者执行。
3. 运行 surface parity。
4. graph/vault 合并。
5. 运行 real benchmark + universal subset。
6. UI/runtime。

执行 AI 只提供建议顺序，不自行 merge。

### 11.4 每个并行任务必须避免

- 修改同一 generated registry；
- 自行新增 contract 字段；
- 复制 core algorithm；
- 修改 schema version；
- 改另一个 lane 的 tests 来接受自己的输出。

需要 contract 变更时，先开一项 M1/M5 amendment，由 contract owner 一次完成并通知所有 lane。

---

## 12. 风险登记

| ID | 风险 | 最早信号 | 预防 | 触发后的动作 |
|---|---|---|---|---|
| R1 | Trigram DB 体积过大 | amplification ratio 超预算 | content hash 去重、只索引 admitted、分层报告 | 暂停 rollout，优化 FTS；不得关闭 exact guarantee |
| R2 | bundled SQLite 无 trigram | migration probe 失败 | build-time/runtime doctor | 阻断 bundle，统一 SQLite build |
| R3 | FTS candidate 漏报 | independent scan 有 expected，search 无 hit | raw verification + 10k needles | P0 blocker，定位 tokenizer/normalization |
| R4 | COW 泄漏旧分支 | feature 返回 deleted/master content | effective mapping 先过滤 | 停止发布，修复 scope SQL，重建 affected snapshot |
| R5 | v9 migration 损坏 DB | orphan/integrity fail | online backup、idempotent migration | restore backup，禁止原地重试 |
| R6 | foreign_keys OFF 产生孤儿 | doctor orphan count > 0 | 单一 transaction + explicit SQL | gate fail，修复 writer/GC |
| R7 | resident runtime crash loop | 1 分钟 3 crashes | handshake/circuit breaker | fallback once、展示 stderr、rollback |
| R8 | CLI/MCP 漂移 | capability hash mismatch | canonical manifest + clean install | 发布阻断 |
| R9 | native/vector extension 不可打包 | temp HOME load fail | optional semantic + per-target doctor | semantic degraded；exact release 可继续 |
| R10 | secret/PII 被索引 | detector/audit fixture 命中 | coverage policy + snippet redaction | 安全事件：停 index/export，清理派生索引 |
| R11 | prompt injection 影响 agent | retrieved text 改变 tool path | untrusted content envelope | 安全 blocker，修 adapter |
| R12 | graph false verified edge | source review 无法证明 | provenance/status contract | 降 candidate，增加 regression |
| R13 | semantic 压过 exact | top hit lane semantic | deterministic boost invariant | rank test fail，禁 semantic blend |
| R14 | Obsidian/Penguin 冲突丢文档 | content hash mismatch | atomic write + optimistic lock | 保留双方，生成 conflict note |
| R15 | artifact 路径穿越/tamper | security fixture | stage + checksum + path validation | 拒绝 import，不改 DB |
| R16 | blind corpus 偏向 Penguin | 问题来自现有命令设计 | 独立 gold、匿名评分 | 重抽样并记录版本 |
| R17 | 项目范围拖延 P0 | advanced feature 阻塞 exact | P0/P1/P2 gate | 先交付 M0–M8 + P0 M16 |
| R18 | 外部工具过早下线 | external-only correct case | 双 RC 硬门 | 保留外部工具直到 blocker 归零 |

---

## 13. 每个任务的执行记录模板

执行者在 task checkbox 下或单独 execution log 写：

~~~markdown
### Execution M4.2

Status: complete
Branch: <detected-branch>
Base HEAD: <git-sha>

Observed before:
- Exact dotted call returned 0 hits.
- Coverage admitted the file.

Red test:
- Command: rtk test node --test tests/knowledge-source-search.test.mjs
- Expected failure: searchSource was not exported
- Observed failure: matched expectation

Files changed:
- Create packages/knowledge-core/src/source-search.ts
- Modify packages/knowledge-core/src/query.ts

Verification:
- Targeted test: pass, 14 tests
- Affected tests: pass, 63 tests
- Typecheck: pass
- Universal subset: 500/500 needles

Expected result confirmed:
- Dotted call returns source hit at actual path and line.

Risks or gaps:
- Short-query full scan p95 not yet in final performance gate.

Suggested commit:
- feat(knowledge): guarantee exact source retrieval
~~~

规则：

- 不能写“tests pass”而没有命令和数量。
- 不能写“should work”；必须区分 observed 与 expected。
- 失败命令保留最小可复现输入。
- 若使用临时 workaround，必须在同 task 移除或明确 blocker；不能留隐藏 debt。

---

## 14. 最终完成报告模板

M18 完成后，交付报告必须包含：

~~~markdown
# Penguin Knowledge V2 Completion Report

## Build identity

- Version:
- Git SHA:
- Capability hash:
- Contract version:
- Schema version:
- Bundled CLI hash:
- Bundled MCP hash:
- Installed MCP hash:

## Universal retrieval

- Corpus repositories:
- Discovered files:
- Admitted files:
- Excluded files by reason:
- Failed files:
- Needles:
- Exact recall:
- Path recall:
- Locator accuracy:
- Unexpected verified hits:

## Performance

- Warm exact p50/p95/p99:
- Warm structural p50/p95/p99:
- Resident startup:
- Peak RSS:
- DB amplification:

## Surface parity

- CLI required/missing:
- MCP required/missing:
- Requests compared:
- Mismatches:

## Real-question differential

- Questions:
- Penguin correct:
- External-only correct:
- Honest gaps:
- Provenance failures:

## Packaging

- Temporary clean installs:
- Doctor result:
- Tool/schema/hash parity:
- Rollback drill:

## Security and evidence

- Scope tests:
- Secret tests:
- Prompt-injection tests:
- Audit verification:

## RC decision

- RC1:
- RC2:
- External tool removal approved by:
- Rollback artifact:

## Remaining optional degradations

- Capability:
- Reason:
- User impact:
~~~

报告中的空字段是 release blocker；只有明确标记 optional 且 manifest 允许 degraded 的能力可以保留。

---

## 15. 本计划自身的完成检查

在开始实现前，计划 reviewer 先检查：

- [ ] 每个 task 有目标、依赖、创建/修改文件、red test、实现步骤、命令、预期结果。
- [ ] 所有现有路径在当前 repo 存在；新路径明确写在“创建”。
- [ ] 每个 shell 命令使用 <code>rtk</code> 前缀；package.json script 字符串除外。
- [ ] 没有让 semantic/LLM 成为 exact correctness 依赖。
- [ ] CLI/MCP required capabilities 有 canonical 清单。
- [ ] current schema v9、MCP drift 和真实 miss 已记录。
- [ ] COW、revision、GC、foreign_keys OFF 风险有 test。
- [ ] packaging、clean install、runtime hash 是 release gate。
- [ ] CodeGraph/Graphify 只在双 RC 后由操作者批准下线。
- [ ] 文档没有未定义的实现占位项。

计划 reviewer 通过后，从 M0 开始；不得直接跳到 UI、semantic 或外部工具移除。
