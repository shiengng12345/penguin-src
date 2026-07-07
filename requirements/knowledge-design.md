简体中文 | Penguin Knowledge 设计文档

# Penguin Knowledge —— 统一知识图谱（笔记 Vault + 代码图谱）设计

> 日期：2026-07-07
> 状态：设计稿 v2.3（2026-07-07 三次修订：D2 改判——CLI 升级为第三入口（薄壳、与 MCP 同语义）；新增 §8.3 CLI 形态与跨进程账本锁；§6 索引管线与 §7 UI 范围仍待确认）
> 上游文档：[graph.md](graph.md)（四工具能力手册 + 命令生态北极星）、[../docs/ai-knowledge-vault.md](../docs/ai-knowledge-vault.md)（笔记 Vault 产品蓝图）
> 参考实现（不依赖、只参考）：[codegraph](https://github.com/colbymchenry/codegraph) · [graphify](https://github.com/Graphify-Labs/graphify) · [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) · Obsidian（对标物）

---

## 0. 一句话

Penguin 内建一张**统一知识图谱**：Obsidian 式笔记 vault 和多 repo 代码符号图谱进**同一张 nodes/edges 表**，笔记可以链接代码符号，AI 通过 Penguin MCP 查询全图——并且图谱**理解 Repository 和 Branch**（参考实现都只有「当前代码快照」，这是 Penguin 的最大差异化）。

## 1. 已拍板的决策（2026-07-07）

| # | 决策 | 说明 |
|---|------|------|
| D1 | 笔记 vault 和代码图谱**一起做，不分期** | 一次交付完整形态，无 Phase 1/2 |
| D2 | **内建于 Penguin app，三个入口同一语义**：桌面 UI（人点）+ MCP（AI 调）+ **薄 CLI（终端用，2026-07-07 改判加入）** | MCP 扩展现有 `packages/mcp`；CLI 是 `knowledge-core` 查询层上的薄壳，动词集与 MCP 六件套一一对应（§8.3），不做 115 命令全集 |
| D3 | **不依赖 codegraph/graphify**，仅作参考实现 | 自研引擎；它们仍是开发期给 AI 用的工具 |
| D4 | **SQLite 优先**，线上存储库以后再考虑 | 核心关系模型不用 SQLite 专有特性；FTS 等加速索引隔离在 `KnowledgeStore` 检索层后面，将来换库=换实现 |
| D5 | tree-sitter **全语言**，不局限少数几门 | 走官方 `tags.scm` 标准查询，首发打包一批常用 grammar，加语言=加包 |
| D6 | **Identity/State 分层**：Node=概念身份，Version=某分支/commit 下的具体实现 | 切分支不覆盖历史状态 |
| D7 | **Branch 是一等公民**，独立 `branches` 表 | 为 worktree、多分支同开、Compare Branch、Branch Timeline 留好架构 |
| D8 | 索引策略：当前检出实时 watch；曾索引过的分支保留最后快照；stale 只标不删；切回自动恢复 | 切分支不丢知识 |
| D9 | **真相三源：Markdown 文件 + Git 仓库 + Knowledge Ledger**；派生 Index 可删可重建 | 解析衍生数据（符号/代码边/FTS/实体提取）可重建；用户建链、AI 断言、alias 历史、事件、快照清单**不可从文件推导**，必须进 Ledger（§2.1） |
| D10 | **Ledger / Index 双层存储** | `ledger.jsonl`（append-only，随 vault 同步备份）+ `knowledge.db`（SQLite 索引缓存，可删可重建） |
| D11 | **Provenance 双轴**：`origin`（谁产生）× `method`（认识论地位）+ confidence | AI 信任的基础；provenance 回填永远有损，V1 就上 |
| D12 | **事件账本从第一天记录**（append-only）；**不做双时态图** | 过去补不回来；timeline/replay/recent_changes 是 V2 在事件上长出的查询视图 |
| D13 | **稳定身份 + alias 历史**：rename/文件移动不断链 | V1 做 content_hash 全等检测自动记 alias；相似度检测 V2；歧义进确认队列，合并可撤销 |
| D14 | **Workspace 薄层**：多 repo 分组为一个逻辑产品 + 查询作用域，仅此而已 | 不做 workspace 级权限/独立 vault/重设置 |

**明确不做（本次范围外）：**

- LLM 语义层（摘要 / why / onboard / domain）——schema 留位，不实现
- 向量检索（sqlite-vec / embedding / Ollama）
- 跨分支**内容级**时间旅行（`--as-of` 查询未检出分支的代码内容）——需按 blob SHA 存全量解析缓存，属「线上存储库」阶段
- **双时态图（永不做）**：不给每条边加 `valid_from/valid_to`——复杂度乘数打在每条查询/写入/UI 上，存储无界增长。时间维度由 append-only 事件账本承担（D12）
- **公开插件 API（V3）**：先做内部注册表（语言/实体/Git provider/存储），接缝被内部实现磨过两轮再公开
- graph.md 的 115 条命令生态**全集**（❄️ 仍冻结北极星）——V1 只落地与 MCP 六件套同语义的薄 CLI 动词集（§8.3）；why/replay/scar/graveyard 等依赖捕获层的命令不做
- 凭据页加密（沿用 vault 蓝图的 sensitive 标记 + 排除机制；加密另行立项）

## 2. 总体架构

```
┌─────────────────────────── Penguin (Tauri 2) ───────────────────────────┐
│                                                                          │
│  React UI                                                                │
│   ├─ Vault 区（新）：文件树 + Markdown 编辑器（CodeMirror 6，复用现有依赖）│
│   ├─ Repos 区（新）：登记 repo/分支、索引状态、符号搜索、callers/callees   │
│   └─ 局部图视图：当前节点的邻居图（React canvas，非全库大图）              │
│                                                                          │
│  Rust (src-tauri)：文件读写命令、DB 访问、sidecar 生命周期管理             │
│                                                                          │
│  Node sidecar「knowledge-indexer」（新，复用现有 sidecar 机制）            │
│   ├─ 结构层（便宜·常开·零 LLM）：tree-sitter + tags.scm → 符号/引用/边     │
│   ├─ 笔记索引：frontmatter + [[wikilink]] + #tag + 实体正则 → 笔记边      │
│   ├─ chokidar 监听：vault 目录 + 各 repo 检出目录 + .git/HEAD             │
│   └─ 增量管线：content_hash 判变 → 只重解析真正变化的文件                  │
│                                                                          │
│  MCP server（扩展现有 packages/mcp）V1 六件套（§8.1）：knowledge_search / │
│   get_node / explore_graph / compare_branches / write_note / index_status │
└──────────────────────────────────────────────────────────────────────────┘

存储（铁律修订：真相三源 = Markdown 文件 + Git 仓库 + Ledger；派生 Index 可删可重建）
  ~/.penguin/vault/                        Markdown 笔记（Obsidian 兼容；路径可配置，
                                           可直接指向现有 Obsidian vault）
  ~/.penguin/vault/.penguin/ledger.jsonl   Knowledge Ledger（append-only 不可再生知识，
                                           随 vault 一起被 iCloud/git 同步备份）
  ~/.penguin/knowledge.db                  SQLite 索引缓存（WAL + FTS5，可删可重建），
                                           与现有 penguin.sqlite3（应用状态）分开
```

关键取舍：

1. **中央库，不搞 per-repo `.penguin/` 目录**。Penguin 是桌面 app、统一管理多 repo，中央库 + `repos` 登记表更简单、不污染用户仓库。「可分享快照」将来用 export 补。
2. **两层引擎定调**（graph.md §13）：本次只做结构层（tree-sitter，便宜、常开、确定性）；语义层（LLM，贵、惰性）留位不做。
3. **现有 MCP server 已直读 `~/.penguin/penguin.sqlite3`**（`packages/mcp/src/app-db.ts` 的 sqlite 二进制方案），knowledge.db 沿用同一访问模式。

### 2.1 Ledger / Index 双层存储（D9/D10）

「DB 删了可重建」只对解析衍生数据成立。用户建的链、AI 断言、alias 历史、事件、快照清单**不是从文件推导出来的——删库就是真丢**。因此存储劈成两层：

| 层 | 内容 | 可否重建 | 落盘 |
|---|------|---------|------|
| **Ledger（账本）** | events、node_aliases、用户手工建的边、AI 断言边、snapshot manifests、人工纠错、AI 建议的采纳/拒绝记录 | ❌ 不可再生 | `vault/.penguin/ledger.jsonl`，append-only，每行带 seq + checksum |
| **Index（索引）** | 解析符号、symbol_versions、代码边、FTS 表、实体提取结果、搜索缓存 | ✅ 可再生 | `~/.penguin/knowledge.db` |

运行机制：

- **写路径**：不可再生知识先追加进 `ledger.jsonl`，再写入 `knowledge.db`——DB 里的对应行只是账本的物化视图
- **启动时**：校验 ledger（seq 连续性 + checksum）→ 若 DB 缺失或落后则 replay 补齐
- **`knowledge.db` 被删** → 从三源全量重建：vault Markdown（笔记与笔记边）+ Git 仓库（符号与代码边）+ `ledger.jsonl`（其余一切）
- **ledger 放 vault 内的理由**：获得与笔记同等的「文件为真相」地位，免费获得 vault 的同步/备份通道
- **对账元表**：`knowledge.db` 维护 `ledger_state(materialized_seq)`——记录已物化到哪个 seq，启动一致性检查和崩溃恢复都靠它

### 2.2 Ledger 写入规则与格式（工程硬规则）

#### 2.2.1 铁律

- 真相源只有三个：**Markdown 文件、Git 仓库、`ledger.jsonl`**。`knowledge.db` 是物化索引/缓存。
- 不可再生知识**必须先追加进 `ledger.jsonl`，再物化进 `knowledge.db`**——顺序不可颠倒。
- SQLite 里的 `events`、`node_aliases`、用户建边、AI 断言边、snapshot manifests 全部是 **Ledger 的物化视图**。
- **应用代码禁止把不可再生知识直接 INSERT 进 SQLite。** 代码层面收口：写路径只暴露 `appendLedger(event)` 一个入口，物化由统一的 materialize 流程执行；`KnowledgeStore` 不提供绕过账本的写方法。
- 解析衍生数据（可再生）允许直写 SQLite——因为删了能从源码/笔记重建。

**必须走 Ledger 的操作（示例）：**

- 用户手工链接两个节点
- AI 建议关系且用户采纳（或拒绝——拒绝记录同样是不可再生知识）
- rename 检测生成 alias
- 手工 alias 合并 / 撤销
- 生成 snapshot manifest
- 事故/case 状态更新
- 无法从 Markdown 推导的笔记元数据

**允许直写 Index 的数据（示例）：**

- 解析符号、symbol_versions
- 提取的代码边（origin=parser）
- FTS 行、实体提取缓存、搜索缓存
- 解析器状态/文件错误标记

#### 2.2.2 ledger.jsonl 行格式

```json
{
  "seq": 1024,
  "id": "led_01HXYZ...",
  "ts": "2026-07-07T10:00:00.000Z",
  "type": "node_alias_added",
  "origin": "system",
  "method": "EXTRACTED",
  "actor": { "type": "system", "id": "knowledge-indexer" },
  "target": {
    "node_id": "node_abc",
    "edge_id": null,
    "repo_id": "repo_abc",
    "branch_id": "branch_abc",
    "workspace_id": null
  },
  "payload": {
    "alias_key": "UserService.login",
    "alias_type": "qualified_name",
    "reason": "rename",
    "confidence": 1.0
  },
  "provenance": {
    "file": "src/auth/user.service.ts",
    "commit": "abc123",
    "parser": "tree-sitter-typescript@x.y.z"
  },
  "checksum": "sha256..."
}
```

| 字段 | 含义 |
|------|------|
| `seq` | 单调递增序号：replay 排序 + 损坏检测（断号即告警） |
| `id` | 账本事件的稳定 id |
| `ts` | UTC 时间戳 |
| `type` | 事件/动作类型（命名纪律见下） |
| `origin` | 谁产生的知识：`parser\|user\|ai\|import\|plugin:xxx\|system` |
| `method` | 认识论地位：`EXTRACTED\|INFERRED\|ASSERTED` |
| `actor` | 谁执行的动作（用户/某个 agent/系统组件） |
| `target` | 可选的 node/edge/repo/branch/workspace 引用 |
| `payload` | 事件专属数据 |
| `provenance` | 来源细节（文件/行/commit/解析器版本） |
| `checksum` | 对**规范化 JSON（排除 checksum 自身，键序稳定）**的 sha256 |

#### 2.2.3 事件命名纪律

事件类型一律用**过去式/动作完成式**，禁止模糊动词（`update`、`change`）：

```text
node_alias_added        manual_edge_created      ai_suggestion_accepted
ai_suggestion_rejected  snapshot_manifest_created  alias_merge_undone
```

#### 2.2.4 Parser / Ledger 边界

**解析器/索引器的输出并不因为「来自 parser」就自动算可再生。** 判定标准只有一条：**能否从当前 Markdown/Git 状态重新推导出来**。

- 能从当前状态重新解析出来的事实 → 允许直写 Index
- 产生**历史性或身份性知识**的解析器决定 → 必须走 Ledger

| 允许直写 Index | 必须走 Ledger |
|---|---|
| 解析符号、symbol_versions | rename 检测生成 alias |
| 提取的 imports/calls/references 边 | 手工或自动身份合并 |
| FTS 行 | alias 合并撤销 |
| 解析器状态 | snapshot manifest 生成 |
| | AI/用户采纳的关系 |

为什么：一条 call 边删了可以从源码重新解析出来；但「A 被改名成了 B」是**历史身份知识**——当前源码里只有 B，rename 这个事实已经不在任何文件里了。不记进 Ledger，删一次 `knowledge.db` 就永远失忆。

#### 2.2.5 多设备限制（V1 单写者假设）

ledger 随 vault 被 iCloud/git 同步是把双刃剑：**两台机器同时追加会产生 seq 分叉和同步冲突文件**（iCloud 会生成 "conflicted copy"）。V1 显式假定**单写者**；启动时若检测到外来 seq 分叉或冲突副本，进入只读模式并提示人工合并，绝不静默择一丢弃。真正的多设备方案（per-device 段文件 / 合并协议）属「线上存储库」阶段。

**同机多进程另论**：app 与 CLI（§8.3）在同一台机器上并发追加是**允许**的——`Ledger.append()` 内部持跨进程文件锁，「读 lastSeq → 写行 → fsync」在锁内完成，seq 不会分叉。单写者假设针对的是**跨设备**（同步通道无法提供锁）。

## 3. 数据模型（v2，Identity/State 分层）

### 3.1 设计原则

- **Node 表示概念（Identity），Version 表示某分支/commit 下的具体实现（State）。** nodes 表不放任何随分支变化的字段。
- **代码类边必须带分支作用域**（calls/imports/references 带 `branch_id`），否则多分支调用图会串味；笔记类边（wikilink/tag/frontmatter）分支无关（`branch_id=NULL`）。
- **符号身份不含文件路径**：`identity_key = repo:qualified_name`（含命名空间/类前缀）。文件被移动/重命名不裂身份；同限定名冲突时自动降级为附加文件路径的身份，并在 meta 标记歧义。
- **身份在 rename/移动中存续（D13）**：`nodes.id`（uuid）永不变，边全部键在 uuid 上；名字/路径变化记入 `node_aliases`，旧名继续解析到同一节点。rename 检测 V1 只做保守版——同一次索引中「符号 A 消失 + 符号 B 出现 + `content_hash` 全等」→ 自动记 alias；相似度检测（rename+修改同时发生）是 V2。**错误合并比漏合并危险得多**（两个概念被焊死很难拆），歧义一律进确认队列，合并可撤销（拆分操作同样写入 Ledger）。
- **笔记链接在建链那一刻盖分支戳**：wikilink 边的 provenance 记录建链时的 branch+commit，AI 可优先取「笔记写下时所在分支」的版本。

### 3.2 表结构

```sql
repos (
  id TEXT PRIMARY KEY,              -- uuid
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,   -- 主检出目录
  remote_url TEXT,
  created_at TEXT NOT NULL          -- UTC，下同
);

-- 分支一等公民
branches (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  head_commit TEXT,                 -- 最近感知到的 HEAD
  last_indexed_commit TEXT,
  last_indexed_at TEXT,
  checkout_path TEXT,               -- 检出目录（主目录或 git worktree）；NULL=未检出
  status TEXT NOT NULL,             -- live(检出中·实时watch) | snapshot(保留最后快照) | gone(已删/已合并)
  UNIQUE (repo_id, name)
);

-- Node = 概念身份（笔记和代码符号同表）
nodes (
  id TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,          -- note|file|symbol|repo|tag|entity
  identity_key TEXT NOT NULL,       -- note: vault相对路径或frontmatter uuid
                                    -- symbol: repo:qualified_name（冲突时降级附加文件路径）
  repo_id TEXT,                     -- 代码节点归属；笔记节点 NULL
  title TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',  -- JSON，只放稳定元数据：kind大类/命名空间/身份歧义标记
  created_at TEXT NOT NULL,
  UNIQUE (node_type, identity_key)
);

-- 身份别名历史（Ledger 物化视图，写入必须先过账本 §2.2）：rename/移动后旧名继续解析到同一节点
node_aliases (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  alias_key TEXT NOT NULL,
  alias_type TEXT NOT NULL,         -- qualified_name|file_path|title|manual
  current_identity_key TEXT,        -- 调试/可读性元数据：物化时该 alias 解析到的现行身份；
                                    -- 权威关系仍是 node_id，过期可从 nodes 重算
  valid_from TEXT,
  valid_to TEXT,
  reason TEXT,                      -- rename|move|manual_merge|import
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  UNIQUE (node_id, alias_key, alias_type)
);

-- Version = 某分支/commit 下的具体实现（State）
symbol_versions (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  commit_sha TEXT NOT NULL,         -- 采集自哪个 commit
  file_path TEXT NOT NULL,          -- repo 相对路径（随分支可不同）
  lang TEXT NOT NULL,
  kind TEXT NOT NULL,               -- function|class|method|interface|struct|const…
  signature TEXT,
  start_line INTEGER, end_line INTEGER,
  content_hash TEXT NOT NULL,       -- 实现内容 hash：两分支 hash 相同 = 实现无差异，秒答
  status TEXT NOT NULL,             -- fresh | stale(该分支上已消失但保留)
  first_seen_at TEXT, last_seen_at TEXT,
  UNIQUE (node_id, branch_id)       -- 每分支保留该符号最后一份快照
);

-- 统一边
edges (
  id TEXT PRIMARY KEY,
  src TEXT NOT NULL REFERENCES nodes(id),
  dst TEXT REFERENCES nodes(id),    -- 未解析链接为 NULL
  raw_target TEXT,                  -- 未解析时保留原文（如 [[还没建的页]]），目标出现后自动补链
  edge_type TEXT NOT NULL,          -- wikilink|tag|frontmatter_rel|entity_mention|
                                    -- calls|imports|contains|defines|references
  branch_id TEXT REFERENCES branches(id),  -- 代码边必填；笔记边 NULL
  origin TEXT NOT NULL,             -- parser|user|ai|import|plugin:xxx|system（谁产生的）
  method TEXT NOT NULL,             -- EXTRACTED|INFERRED|ASSERTED（认识论地位，见 §3.3）
  confidence REAL NOT NULL DEFAULT 1.0,
  provenance TEXT NOT NULL DEFAULT '{}'    -- JSON：file/line/解析器版本 + 建链时 branch/commit
);

-- 事件查询表 —— ⚠️ 非真相源！ledger.jsonl 才是权威事件记录（§2.2）。
-- 本表是 replay 物化出来的查询加速视图：DB 被删后由 Ledger 重建；
-- 开发者禁止把本表当写入 API——写事件的唯一入口是 appendLedger()。
-- 物化必须同时保留 origin 和 method：timeline/recent_changes 查询要能区分
-- 「解析器提取的事件 / AI 推断的事件 / 用户主张的事件」。
events (
  id TEXT PRIMARY KEY,
  ledger_seq INTEGER,               -- 对应账本行 seq，对账用
  ts TEXT NOT NULL,
  event_type TEXT NOT NULL,         -- 过去式命名（§2.2.3）：node_created|node_renamed|node_stale|
                                    -- note_linked|manual_edge_created|ai_suggestion_accepted|
                                    -- ai_suggestion_rejected|snapshot_manifest_created|alias_merge_undone|
                                    -- index_started|index_finished
  node_id TEXT REFERENCES nodes(id),
  edge_id TEXT REFERENCES edges(id),
  branch_id TEXT REFERENCES branches(id),
  repo_id TEXT REFERENCES repos(id),
  workspace_id TEXT REFERENCES workspaces(id),  -- 可选：事件有明确 workspace 作用域时才填，
                                                -- 免去 recent_changes(workspace)/timeline(workspace) 的间接 join
  origin TEXT NOT NULL,             -- parser|user|ai|import|plugin:xxx|system
  method TEXT NOT NULL,             -- EXTRACTED|INFERRED|ASSERTED（与账本行一致，replay 不得丢失）
  payload TEXT NOT NULL DEFAULT '{}',
  provenance TEXT NOT NULL DEFAULT '{}'
);

-- Ledger 物化进度（§2.1 对账元表）：
-- 记录 ledger.jsonl 已物化到哪个 seq。启动 replay 比较账本最新 seq 与
-- materialized_seq：账本领先 → 从 materialized_seq + 1 续放；DB 缺失 →
-- 从 0 开始全量 replay。ledger_checksum 仅是检查点/调试元数据，不是真相源。
ledger_state (
  id TEXT PRIMARY KEY,              -- 通常为 'main'
  materialized_seq INTEGER NOT NULL DEFAULT 0,
  materialized_at TEXT,
  ledger_checksum TEXT
);

-- Workspace 薄层（D14）：多 repo 分组为一个逻辑产品，仅分组 + 查询作用域
workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

workspace_repos (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  PRIMARY KEY (workspace_id, repo_id)
);

-- 笔记文件索引（真相在 .md 文件）
notes_index (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id),
  path TEXT NOT NULL UNIQUE,        -- vault 相对路径
  frontmatter TEXT NOT NULL DEFAULT '{}',
  sensitive INTEGER NOT NULL DEFAULT 0,
  ai_access TEXT NOT NULL DEFAULT 'allowed',
  mcp_access TEXT NOT NULL DEFAULT 'allowed',
  content_hash TEXT NOT NULL        -- 增量索引用
);

-- 提取实体（vault 蓝图：trace_id/reqid/playerId/config key/API method/env…）
entities (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  UNIQUE (entity_type, normalized_value)
);
```

### 3.3 Provenance 双轴与信任模型（D11）

`origin` 和 `method` 是**正交的两轴**，捏成一个枚举将来会后悔：

- **origin（谁产生的）**：`parser | user | ai | import | plugin:xxx | system`——开放字符串，插件时代可扩展
- **method（认识论地位）**：`EXTRACTED`（原文确凿）| `INFERRED`（推断）| `ASSERTED`（人或 AI 主张，未经验证）
- **confidence**：强度

组合示例：

```text
parser + EXTRACTED + 1.0     tree-sitter 从源码解析出的调用边
ai     + INFERRED  + 0.64    AI 建议的「这两个笔记可能相关」，进确认队列
user   + ASSERTED  + 1.0     用户手工建的链接
plugin:github + EXTRACTED + 1.0   （V2+）从 PR 数据提取的关联
```

AI 时代**信任就是产品**：agent 拿到一条边，「解析出来的」和「另一个 AI 猜的」决定它敢不敢直接用。信任策略（如「origin=ai 且 method=ASSERTED 的边需人工确认才参与默认检索」）V2 实现，但数据轴 V1 必须在位——回填历史 provenance 只能填 UNKNOWN，永久有损。

### 3.4 加速索引（隔离层）

- FTS5 虚表：`fts_notes(node_id, title, body)`、`fts_symbols(node_id, name, signature)`
- 所有查询走 TS 侧 `KnowledgeStore` 模块（`searchText()` / `neighbors()` / `path()` / `whoCalls()`…），业务代码不裸写 FTS5 语法；迁线上库 = 换这一层实现（守 D4）
- FTS/加速索引可随时 drop 重建，不属于核心关系模型

### 3.5 这个模型直接解锁的能力

- 「main 和 feature 的 `GetLoginURL` 有什么差异？」→ join `symbol_versions` on `node_id`；`content_hash` 相同秒答「无差异」，不同则取两份 span 给 AI diff
- Compare Branch / Branch Timeline = versions 表的查询视图
- git worktree 同开多分支 → 多条 `branches.checkout_path` 非空，各自 live watch
- MCP 所有代码查询带可选 `branch` 参数，默认当前检出；返回必带 `branch/commit/staleness` 戳
- rename/文件移动后，笔记里的旧名链接经 `node_aliases` 继续解析到同一节点，十年知识不因改名归零
- timeline / replay / recent_changes / Branch Timeline（V2）= `events` 表上的查询视图，无需改图模型

## 4. 分支模型与索引策略

1. **索引镜像磁盘检出内容，但节点身份跨分支稳定，切分支不断链。**
2. **切分支感知**：watcher 直接监听 `.git/HEAD`，切换瞬间感知；重建靠 `content_hash` 跳过未变文件（两分支通常 95% 相同），成本 ≈ 两分支 diff。
3. **符号身份不含分支** → `[[GetLoginURL]]` 指「这个符号」，不指「某分支的版本」；切分支只更新该分支的 version 行。
4. **分支上消失的符号**：version 标 `stale`，不删。UI/MCP 显示「该符号在当前检出 (main@def456) 不存在，最后见于 feature/fix-gameurl@abc123」；切回自动恢复 fresh。调查笔记、case、符号链接因此是分支无关的持久知识。
5. **笔记可声明分支上下文**：case frontmatter 支持 `branch: feature/xxx`，生成 `case --on_branch--> branch` 边。
6. **分支生命周期**：远端被删/已合并 → 标 `gone`，快照保留，设置里可一键清理（防 versions 膨胀）。
7. **多 repo**：各自登记、各自索引、各自 watch；符号身份自带 repo 前缀；笔记跨 repo 链接自由。

## 5. 融合机制（笔记 ↔ 代码）

**链接解析统一走 nodes，优先级：笔记标题 → 符号名 → 实体。**

- `[[GetLoginURL]]` 命中符号 → 生成 `note --wikilink--> symbol` 边（provenance 盖建链时 branch/commit 戳）
- 命名空间强制指定（vault 蓝图语法）：`[[api:Svc.GetLoginURL]]`、`[[repo:fpms-provider]]`、`[[trace:3d0e…]]`
- 解析不到 → `dst=NULL, raw_target` 保留，目标出现后自动补链
- 一名多中 → 存候选、UI 展示歧义，不瞎猜
- 实体提取（正则，零 LLM）：trace_id、reqid、playerId、proposalId、API method、config key、repo/文件路径、环境名 → `entity_mention` 边
- **敏感规则**（vault 蓝图继承）：`sensitive=1` 或 `mcp_access=denied` 的笔记默认排除在 MCP 结果外，只返回「存在一个敏感关联页」占位

## 6. 索引引擎管线（提案，待确认）

### 6.1 全语言符号提取

- `web-tree-sitter`（WASM grammar）跑在 knowledge-indexer sidecar 里——WASM 免各平台原生编译，跨 arch 分发简单
- 符号/引用提取用 tree-sitter 官方 **`tags.scm`** 标准查询（`@definition.function` / `@reference.call` 等），一套管线吃所有语言
- 首发打包 grammar（约 20 门）：TS/TSX/JS、Rust、Go、Java、PHP、Python、C、C++、C#、Ruby、Kotlin、Swift、proto、SQL、Bash、HTML、CSS、JSON、YAML；加语言 = 加一个 wasm 文件 + 注册表一行
- 限定名构建：按语言的作用域节点（class/impl/namespace/module）逐层拼 `qualified_name`
- 跳过：`node_modules`/`target`/`dist` 等常规忽略目录（读 `.gitignore`）+ 单文件 >1MB 跳过（参考 codegraph）

### 6.2 引用解析（calls/imports 边怎么连）

1. import 边：按语言的 import/require/use 语句 → `file --imports--> file`
2. call 边：`@reference.call` 捕获调用名 → 在**同分支**作用域内按「同文件 → 同 repo 限定名 → 同 repo 裸名唯一命中」顺序解析；唯一命中 `origin=parser, method=EXTRACTED`，多候选取最优标 `method=INFERRED, confidence<1`，无命中不建边
3. 动态派发/反射类调用不强行解析（宁缺毋滥，守「每条边可解释」）

### 6.3 增量管线

```
文件事件（chokidar，2s 防抖）
  → content_hash 比对（没变直接丢弃）
  → 重解析该文件 → diff 符号级差异
  → rename 检测命中（符号消失+出现+hash 全等）→ appendLedger 记 alias（§2.2.4 边界），不直写 SQLite
  → 更新 nodes（新身份才插）/ symbol_versions（当前分支行）/ edges（该文件产出的边全量替换）
  → 更新 FTS
.git/HEAD 变化
  → 识别新分支（branches 插/更 live 行，旧分支转 snapshot）
  → 全仓 content_hash 扫描 → 只重解析变化文件
应用重启
  → 对账：扫描 mtime/size 找出错过的变更（参考 codegraph 重连对账）
```

- 解析/索引在 sidecar 有界并发池后台跑，前台查询永远优先
- 索引落后时查询照常返回 + 「⚠️ 可能略旧」staleness 标记，绝不阻塞

### 6.4 笔记索引

- 解析 frontmatter（yaml）、`[[wikilink]]`、`#tag`、实体正则、Markdown 标题结构
- 笔记的移动/改名：frontmatter `id`（uuid）为身份优先，路径变化不断链（Obsidian 兼容：无 id 的外来笔记以路径为身份）
- vault 目录 watch 同一管线

## 7. 笔记 Vault（UI 与行为）

按 [ai-knowledge-vault.md](../docs/ai-knowledge-vault.md) 蓝图执行，本次交付范围：

- **布局**：Icon Rail 新增 Vault 入口 | 文件树侧栏（Inbox/Cases/Knowledge/Repos/Credentials 分区）| 编辑器 | 右侧上下文面板
- **编辑器**：CodeMirror 6 Markdown 模式（复用现有依赖，不引入块编辑器库）：大标题、`[[...]]` 自动补全（跨笔记+符号+实体）、`#tag` 补全、frontmatter 属性面板、保存指示
- **上下文面板**：属性 | backlinks | 相关页 | 实体提及 | 链接的符号（带当前分支版本状态）
- **局部图视图**：以当前笔记/符号为中心的邻居图（1–2 跳，节点上限 + 按 edge_type 过滤），React canvas；**不做全库大图**（>5000 节点浏览器扛不住，graphify 已验证）
- **搜索**：标题 + FTS 全文 + `type:` `tag:` `repo:` `entity:` 过滤语法；敏感页默认排除，解锁后可含
- **新建/捕获**：快速新建入 Inbox，不强迫先选目录；类型可后改（改 frontmatter + 移文件不断链）
- **凭据区**：sensitive 默认、锁定态可视标记、默认不进 FTS/MCP；加密不在本次

## 8. MCP 工具契约（扩展 packages/mcp）

所有返回必带 `origin / method / confidence / staleness / branch / commit`（适用时）。

> **纪律：工具要少而强。** 优先给现有工具加参数/加 mode，而不是新增窄工具——agent 面对 30 个窄工具的选择困难远大于 6 个宽工具（codegraph 单个 explore 工具的实证）。只有使用数据证明某个 mode 值得独立成工具时才拆出。

### 8.1 V1 核心工具（六件套）

| 工具 | 作用 |
|------|------|
| `knowledge_search(query, filters?)` | 统一检索：标题→FTS→图邻居，笔记+符号+实体混合返回，敏感页排除；filters 含 `workspace`/`repo`/`type`/`branch` 作用域 |
| `get_node(id\|identity_key)` | 节点详情 + 版本列表（符号）或正文（笔记，尊重 mcp_access）+ alias 历史 |
| `explore_graph(mode, node, options?)` | 图遍历统一入口，`mode = who_calls \| calls_of \| impact \| backlinks \| path \| timeline \| recent_changes`；options 含 branch/workspace/深度/节点上限。timeline 与 recent_changes 直接查 events 物化表（数据 V1 已在记） |
| `compare_branches(symbol, branch_a, branch_b)` | 同一符号跨分支差异（hash 相同秒答无差异） |
| `write_note(action, payload)` | 安全写操作统一入口，`action = create_page \| append_note \| link_pages`；**所有写操作必须遵守 Ledger 写入规则（§2.2）**：不可再生知识先 appendLedger 再物化；并遵守 vault 蓝图 AI 写入策略（只建草稿、只追加、不碰敏感页） |
| `index_status()` | 各 repo/分支索引状态、staleness、repo/branch/workspace 清单（兼答原 list_repos / list_branches） |

**`write_note` 命名决定（V1 拍板）**：名字听起来 note-only，而 `link_pages` 实际可以建 note→note / note→symbol / note→entity / case→symbol 等图边——这是**有意为之的收窄**：V1 的 AI 写能力刻意限制在「Vault / 写笔记」这个面上，link 只允许作为写笔记工作流的一部分发生，**绝不让它长成任意图变更 API**。若 V2 需要更广的图变更能力，另立新工具（如 `knowledge_write(action, payload)`），**不重命名 V1 的 `write_note`**。

### 8.2 V2 派生工具

以下能力 V2 落地，且**默认以 mode/参数形式实现，不独立成工具**，除非使用数据证明值得：

- `suggest_links` / `accept_suggestion` / `reject_suggestion`：AI 建议边确认流（`origin=ai, method=INFERRED` 进队列；采纳/拒绝都写 Ledger）——V2 唯一可能独立成工具的一组，因为它是写路径
- `timeline` / `recent_changes` / `impact` / `backlinks` / `graph_path`：已是 `explore_graph` 的 mode，V1 即可用，V2 只是补 UI

### 8.3 CLI 形态（V1 第三入口，2026-07-07 改判）

**定位**：给「人在终端」用的薄壳——`packages/knowledge-cli` 新包，bin 名 `penguin`。**CLI 不长自己的逻辑**：查询动词直接调 `knowledge-core` 查询层（与 MCP 六件套同一实现、同一语义），写动词走同一个 `recordKnowledge()` 铁律。

**V1 动词集（与 MCP 一一对应 + 系统动词）：**

```text
penguin init [path]          登记当前/指定目录为 repo（探测 git/分支）+ 一次性首建索引
penguin status               各 repo/分支索引状态、staleness（= index_status）
penguin sync [path]          手动一次增量索引（headless，一次性进程）
penguin search <query>       统一检索（= knowledge_search；--type --repo --workspace --branch）
penguin node <id|name>       节点详情 + 版本 + alias 历史（= get_node）
penguin callers <symbol>     谁调用它（= explore_graph mode=who_calls；--branch）
penguin calls <symbol>       它调用谁（= explore_graph mode=calls_of）
penguin impact <symbol>      爆炸半径（= explore_graph mode=impact）
penguin backlinks <node>     谁链接了它（= explore_graph mode=backlinks）
penguin path <a> <b>         两节点最短路径（= explore_graph mode=path）
penguin recent [--since]     最近重要变化（= explore_graph mode=recent_changes）
penguin compare <symbol> <branch_a> <branch_b>   跨分支差异（= compare_branches）
penguin note new|append|link 写笔记（= write_note 三个 action，遵守 Ledger 铁律）
penguin doctor               环境 + 知识库自检（DB/账本一致性、watcher 状态）
penguin install              把 penguin CLI 软链到 PATH + 确认 MCP 已接线
```

全局旗标（graph.md §6 继承，砍到 V1 能兑现的）：`--json`（机器可读）、`--branch <b>`；每条输出必带 `origin/method/confidence/staleness/branch/commit`（适用时）——与 MCP 返回契约一致。

**分发**：CLI 随 app 捆绑（Tauri resources，同 MCP server 模式），设置页/`penguin install` 把启动脚本软链到 `/usr/local/bin/penguin`（学 VS Code 的 `code` 命令）；运行时用系统 Node（同 sidecar 机制）。

**headless 行为**：查询动词只读 `knowledge.db`（app 不在跑也能查，秒回）；`init/sync` 在 CLI 进程内跑一次性索引（复用 indexer 模块）；常驻 watcher 仍归 app（CLI 不起 daemon，V1）。

**跨进程并发（新增硬规则）**：app 和 CLI 可能同时写账本——`ledger.jsonl` 的 append 必须持**跨进程文件锁**（lock 文件 + O_EXCL 或 flock），锁内完成「读 lastSeq → 写行 → fsync」；SQLite 侧靠 WAL + busy_timeout 已安全。此规则落在 `knowledge-core` 的 `Ledger.append()` 内部，所有入口自动继承。

## 9. 错误处理 / 性能 / 降级

| 情形 | 行为 |
|------|------|
| 单文件解析失败 | 该文件标 Error 记入状态，跳过，不拖垮全库 |
| grammar 缺失的语言 | 文件级节点照建（file 节点+import 边尽力），符号层跳过，UI 标「该语言暂无符号解析」 |
| 索引进行中 | 查询照常 + staleness 横幅；绝不阻塞 UI 和 MCP |
| repo 路径失效（外置盘/删除） | repo 标 offline，快照保留，可重新指路径 |
| 笔记外部被改（Obsidian 同时开） | watcher 收敛；编辑冲突以 mtime 新者为准 + 冲突提示，不静默覆盖 |
| versions/边膨胀 | gone 分支一键清理；per-repo 统计可视 |
| SQLite 调优 | WAL + busy_timeout；FTS 单独表不拖关系查询；符号级 diff 减少写放大 |
| ledger.jsonl 损坏/被截断 | 每行带 seq + checksum；从损坏行起截断并告警，之前的完整前缀照常 replay；vault 同步通道天然多副本 |
| ledger replay 失败 | replay 事务化；校验失败的行进隔离区并报告，不阻塞启动 |
| knowledge.db 被删/损坏 | 启动检测 → 提示一键全量重建：vault Markdown + Git 仓库 + ledger.jsonl 三源（§2.1），无数据损失 |
| alias 错误合并 | 合并可撤销（拆分操作作为新账本条目写入 Ledger）；低置信度合并必须走确认队列，不自动执行 |
| 事件量膨胀（ledger 压缩） | 账本默认永远 append-only；压缩是可选操作，产物必须是**新的带校验段**，旧段归档、绝不静默删除；涉及 timeline/undo 所需语义历史的压缩必须用户显式确认。策略：按节点保留里程碑事件，聚合高频低值事件（index_started/finished 等） |
| Index 与 Ledger 漂移 | 启动一致性检查：ledger 最新 seq vs `ledger_state.materialized_seq`，不一致自动补 replay |
| 账本写入中崩溃 | 原子追加纪律（先写完整行再 fsync）；replay 只接受 checksum 有效且 seq 连续的行；末尾残行忽略并报告 |
| 账本已写、SQLite 物化前崩溃 | 安全：下次启动 replay 发现 ledger seq > materialized seq，自动补齐 |
| SQLite 已写、账本未写 | **写路径禁令下不应发生**（不可再生知识没有 SQLite-first 入口）；启动一致性检查发现「无账本出处的物化行」→ 隔离并报告，不静默保留 |
| 多设备同时追加账本 | V1 单写者假设（§2.2.5）：检测到 seq 分叉/同步冲突副本 → 只读模式 + 人工合并提示，绝不静默择一 |
| vault 未备份 | ledger 依赖 vault 的同步/备份通道；检测到 vault 不在任何同步/git 管理下时，明确警告用户 |

## 10. 测试策略

- **单元**：每语言一组 fixture 文件 → 断言提取出的符号/边（tags.scm 管线的回归保障）；限定名构建；身份冲突降级；wikilink/frontmatter/实体解析；链接解析优先级与歧义
- **集成**：以 Penguin 仓库自身为测试 repo → init 索引 → 断言已知符号存在、callers 正确；建临时 git repo 双分支 fixture → 切分支 → 断言 versions 双行、stale 标记、切回恢复、compare_branches 正确
- **Ledger**：事件 JSON 规范化（键序稳定）与 checksum 校验；按 seq 顺序 replay；末尾残行恢复；`ledger_state.materialized_seq` 追踪与对账；**SQLite-first 写入防护**（运行时断言 + 代码层无绕过账本的写入口）；从 Markdown + Git + Ledger 三源重建 knowledge.db；events 表可完全由 Ledger 重建；alias 合并与撤销回归
- **MCP 写路径**：`write_note` 每种 action 断言「先出现账本行、后出现物化行」，顺序颠倒即失败
- **MCP**：每个工具契约测试（含敏感页排除、staleness 戳存在、origin/method 字段完整）
- **UI 冒烟**：vault 建页 → 写 `[[链接]]` → backlinks 出现 → 上下文面板正确

## 11. 产品定位与架构不变量（十年视角）

**按 Software Knowledge OS 做架构，按知识库说话。** V1 对外定位一句话：

> 「你和你的 AI agents 共用的工程知识库」——local-first、懂 branch、MCP 原生。

「OS」是十年北极星，不是 V1 的营销词（OS 意味着平台 + 生态 + 第三方开发者，V1 还没有）。它对架构的真实约束是四条内核不变量，**V1 起全部生效**：

1. **万物皆 node**：`node_type` 开放字符串——PR/Issue/Release/部署等将来直接进图，零 schema 变更
2. **不可再生知识进 Ledger**：任何不能从「文件 + git」推导的断言，写进 append-only 账本（§2.1）
3. **每条断言带 provenance**：`origin × method × confidence`，事实与推断永不混淆（§3.3）
4. **扩展点皆注册表**：语言（grammar+tags.scm）、实体提取（正则包）、Git provider、存储（KnowledgeStore）先做**内部注册表**（in-tree），公开插件 API 是 V3

**能力波次**（架构现在定，实现分波交付）：

| 波次 | 内容 |
|------|------|
| **V1（本设计交付）** | 全量 schema（含 node_aliases / events / workspaces / 双轴 provenance）、Ledger/Index 双层存储与写入铁律（§2.2，含跨进程账本锁）、事件开始记录（无 UI）、content_hash 全等 rename 检测、Workspace 分组与查询作用域、MCP 六件套（`explore_graph` 的 timeline/recent_changes mode 即查即得）、**薄 CLI 动词集（§8.3）** |
| **V2** | timeline/replay 视图与 UI、相似度 rename 检测、AI 建议边确认流（suggest/accept/reject）、snapshot manifest、本地 git 对象（commit/tag/merge 拓扑）入图、远端 PR/Issue（走 GitProvider 注册表，存引用+缓存摘要，不整库镜像）、信任策略 |
| **V3** | 公开插件 API（语言/实体/provider/集成）、线上存储库、多人协作 |

## 12. 待确认（下一轮讨论）

1. §6 索引引擎管线细节（WASM grammar 首发清单、引用解析规则）是否认可
2. §7 Vault UI 范围是否认可（特别是：局部图视图要不要、slash 命令块这次做不做——蓝图里有 `/finding` `/request` 等 Penguin 专属块，建议本次先做标准 Markdown + `[[]]`/`#` 补全，Penguin 块下一轮）
3. §8 MCP 工具清单增删
4. vault 默认路径 `~/.penguin/vault`、knowledge.db 路径确认
5. Repos 区 UI：登记 repo 的交互（选目录 → 自动识别 git/分支 → 开始索引）细节
