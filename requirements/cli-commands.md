简体中文 | Penguin CLI 逐命令规格

# Penguin CLI —— V1 命令详细规格

> 日期：2026-07-07
> 上游：[knowledge-design.md](knowledge-design.md) §8.3（CLI 形态与铁律）
> 定位：`packages/knowledge-cli`，bin 名 `penguin`。**薄壳**：查询动词直接调 `knowledge-core` 查询层（与 MCP 六件套同一实现），写动词走 `recordKnowledge()` 铁律。CLI 不长自己的逻辑。
> graph.md 的 115 命令全集仍冻结；本文只规格 V1 的 17 个动词。
> 读写分类与 CLI 六条不变量见 knowledge-design.md §8.3——只读命令绝不写账本；写命令（init/index/rebuild/note/install/doctor --fix）可能获取账本锁/索引任务锁。
> 命名拍板（2026-07-07）：`index` = 增量（日常动词），`rebuild` = 全量重建（修复动词）；`sync` 弃用——听着像云同步。

---

## 0. 全局约定

### 0.1 全局旗标

| 旗标 | 适用 | 含义 |
|---|---|---|
| `--json` | 所有命令 | 机器可读输出（stdout 单个 JSON 文档；人类格式的提示走 stderr） |
| `--branch <b>` | 代码查询类 | 指定分支，缺省 = 该 repo 当前检出分支 |
| `--repo <name\|path>` | 多 repo 有歧义时 | 限定 repo；缺省 = 从 cwd 向上匹配已登记 repo |
| `--workspace <name>` | search/recent | 限定 workspace 作用域 |
| `--limit <n>` | 列表类 | 结果上限，缺省 20 |

### 0.2 输出契约（与 MCP 一致）

每条结果适用时必带 provenance 戳：`origin / method / confidence / staleness / branch / commit`。人类格式里压缩为一行尾注，例如：

```text
GetLoginURL  fpms-provider/src/login.ts:42  [parser·EXTRACTED·1.0  main@abc123  fresh]
```

staleness 取值：`fresh`（watcher 已追平）/ `stale`（索引落后，附落后原因）/ `gone`（该分支上已消失，附 last_seen）。

### 0.3 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（含「查询成功但零结果」——零结果不是错误） |
| 1 | 一般错误（参数错、目标不存在、账本锁超时等，stderr 给原因） |
| 2 | 环境错误（knowledge.db 缺失且无法重建、非登记 repo 且命令需要 repo 上下文） |
| 3 | 数据完整性警告态（账本截断/Index 落后但已自动修复——结果仍输出，供脚本感知） |
| 4 | 索引任务锁冲突且 `--no-wait`（同 repo+分支+目录已有活跃索引任务，本次跳过） |

### 0.4 进度输出（init / index / rebuild）

**分层**：indexer（knowledge-core）只发进度事件 `{phase, done, total, currentFile}`（回调），渲染是 CLI 的格式化职责——app UI（计划 5）订阅同一事件流画自己的进度，两边永远同步。

**渲染实现（2026-07-07 拍板：质量优先，用成熟库）**：`@clack/prompts`（+ 需要时用 `@clack/core` 扩展进度条）——目标视觉（◆ 菱形阶段标记 + 竖线边栏）正是 clack 的签名风格，Astro/create-vite/SvelteKit 的 CLI 皆用它。**明确不手写 ANSI 渲染**：终端 resize、行宽折行、CJK 宽字符宽度、崩溃后光标恢复、Windows 终端差异是细节翻车重灾区，自写必然做出 demo 级效果。下列 UX 行为与库无关，作为**验收标准**：

**TTY 下三阶段，完成即折叠：**

```text
运行中：
  Indexing fpms-provider (main)

  ✔ Scanning files — 412 found, 7 changed        ← 完成阶段折叠为一行
  ◆ Parsing code   ━━━━━━╺╺╺╺╺╺╺╺  4/7  src/login.ts   ⚠ 1
    Linking refs                                  ← 未开始，灰显

结束后整块替换为摘要（不留进度痕迹）：
  ✔ fpms-provider: 7 文件 → +3 ~12 -1 符号 · 2 rename · 1.1s
    ⚠ 1 文件解析失败: src/legacy/gen.ts (查 penguin doctor)
```

规则：

- 阶段：`Scanning`（清单 + files_index 比对，显示 found/changed）→ `Parsing`（**done/total + 当前文件名**，截断到行宽——卡住时能看见卡在哪，比裸百分比有用）→ `Linking refs`（引用解析/FTS）
- **不显示 ETA**：文件解析耗时方差极大，ETA 必然乱跳骗人；真实耗时只在结束摘要给
- **静默起手 300ms**：增量常见「0～3 文件」几百毫秒完事，跑不满 300ms 不升进度 UI，避免闪烁杂讯
- **单文件失败不打断**：进度行计 `⚠ N`，结束后列清单（文件+原因）；Ctrl+C 干净退出并提示「已完成 X/N，重跑 penguin index 从断点收敛」（逐文件事务 §6.3.2 保证这句话为真）
- **降级矩阵**：非 TTY（管道/CI）→ 每阶段一行普通日志；`CI=true`/`NO_COLOR` 遵守；`--json` → 进度全走 stderr，stdout 只留最终 JSON；`--quiet` → 只出错误与摘要；TTY 重画节流 ≤10fps（SSH 不刷屏）
- 进度条只是展示，**不是** `--json` 稳定契约的一部分，样式可随时调整

### 0.5 通用错误情形（所有命令）

- `knowledge.db` 不存在：查询类命令自动触发三源重建（提示进度到 stderr），重建后继续执行；重建失败退 2
- 账本尾部截断：照常执行（有效前缀），stderr 警告 + 退出码 3
- cwd 不在任何已登记 repo 且命令需要 repo：报错并提示 `penguin init`，退 2
- `--branch` 指定的分支从未被索引过：报错列出已知分支，退 1

---

## 1. `penguin init [path]`

**用途**：把目录登记为 repo 并完成首次索引。桌面 UI「登记 repo」的 headless 等价物。

**旗标**：`--name <n>`（显示名，缺省 = 目录名）、`--workspace <w>`（顺手加入 workspace，不存在则创建）

**行为**（顺序）：

1. 解析 path（缺省 cwd）→ 向上找 `.git`（纯文件解析 `.git/HEAD`/`.git/config`，gitlink/worktree 跟过去；不依赖 git 命令）
2. **是 git**：repo 根 = `.git` 所在目录；读出当前分支、HEAD commit、remote_url
   **非 git**：repo 根 = path 本身；插隐式分支 `(workdir)`（见 knowledge-design §4.8）；stderr 提示 `⚠ 不是 git 仓库——已按无版本目录索引，分支对比等功能不可用`
3. 查重：`root_path` 已登记 → 幂等，报「已登记」+ 当前状态后退 0（不重复索引；增量用 `penguin index`，强制重建用 `penguin rebuild`）
4. 写 `repos` 行 + `branches` 行（status=live, checkout_path=repo 根）
5. 首次全量索引（进程内跑 indexer，进度条到 stderr：文件数/符号数/耗时）
6. 若 Penguin app 正在跑：通知其 watcher 接管该 repo（本地 IPC，V1 可降级为「app 下次启动自动发现」）

**输出**（人类）：

```text
✓ 登记 fpms-provider (/Users/x/Projects/fpms-provider)
  git: main@abc123 · remote: git@github.com:x/fpms-provider.git
  索引: 412 文件 · 3,801 符号 · 9,214 边 · 6.2s
```

`--json`：`{ repo: {id,name,root_path,remote_url}, branch: {name,head_commit}, index: {files,symbols,edges,duration_ms}, git: true }`

**错误**：path 不存在/不可读 → 退 1；path 是文件不是目录 → 退 1；嵌套登记（path 在已登记 repo 内部）→ 报错提示已有归属，退 1。

---

## 2. `penguin status`

**用途**：各 repo/分支索引状态一览（= MCP `index_status`）。

**旗标**：`--repo`（只看一个）

**行为**：只读 `knowledge.db`，不触发索引。每 repo 输出：当前分支、head_commit、last_indexed_commit、staleness（比对两者 + 文件 mtime 抽样）、符号/边计数、已知分支列表（live/snapshot/gone 计数）、watcher 是否在跑（读 app 心跳，V1 可显示 unknown）。

**输出**（人类）：

```text
fpms-provider   main@abc123   synced   3,801 符号   分支: 2 live · 3 snapshot
penguin         main@455eac5  stale(2 commits behind)   12,044 符号   分支: 1 live
vault           —             synced   0 符号（纯笔记）
```

`--json`：`{ repos: [{name, current_branch, head_commit, last_indexed_commit, staleness, symbols, edges, branches: {live,snapshot,gone}}], ledger: {seq, materialized_seq, truncated_at} }`

**错误**：无已登记 repo → 输出空表提示 `penguin init`，退 0（不是错误）。

---

## 3. `penguin index [path]` / `penguin rebuild [path]`

一对索引动词，共用索引任务锁与协调规则（见 3.3）。**都是一次性进程，跑完即退出——不是 watcher，不是云同步，不启动 daemon，不长期监听文件变化**；长期监听请打开 Penguin app。

### 3.1 `penguin index [path]` —— 增量（日常动词）

**用途**：改完代码后手动触发一次**增量**索引（app 不在跑、或不想等 watcher 时）。增量依据 = `files_index` 文件级检查点（mtime/size 快筛 → content_hash 终判，spec §6.3.1）——不是游标进度，手动改/git pull/切分支/脚本覆盖全部被 hash 比对捕获。

**旗标**：`--all`（所有已登记 repo）、`--no-wait`（撞锁不等待，退 4）

**行为**：

1. 定位 repo（path/cwd → 已登记 repo；`--all` 遍历）
2. 获取索引任务锁（见 3.3；撞锁缺省等待）
3. 读 `.git/HEAD`——发现分支切换先走分支切换流程（旧分支转 snapshot、新分支建/升 live，检查点按 branch 隔离，spec §6.3.3）
4. files_index 比对（mtime/size 快筛 → hash 终判）→ 只重解析 变化/删除/上次 error 的文件；每个文件一个替换事务（spec §6.3.2，中途崩溃回滚、下次自动重试）
5. rename 检测（hash 全等）命中 → 经 `recordKnowledge()` 写 alias 事件（账本锁自动处理与 app 的并发）
6. 结束打印 diff 摘要

**输出**（人类）：

```text
✓ fpms-provider: 7 文件变化 → +3 符号 · ~12 符号 · -1 符号 · 2 rename(alias 已记) · 1.1s
```

`--json`：`{ repo, branch, files_changed, symbols: {added,updated,removed}, renames: [{from,to}], duration_ms }`

**错误**：repo 未登记 → 退 2 提示 init；索引中途单文件解析失败 → 该文件标 Error 继续（出现在摘要里），整体退 0。

### 3.2 `penguin rebuild [path]` —— 全量重建（修复动词）

**用途**：推倒重来的显式动词——丢弃该 repo 的**解析衍生数据**（符号/versions/parser 边/FTS/实体缓存/files_index）后全量重扫重建。用于：怀疑索引坏了、语言 grammar 升级后、`doctor` 建议重建时。

**旗标**：`--all`（所有已登记 repo，逐个执行）、`--no-wait`（同上）

**行为**：

1. 定位 repo + 获取索引任务锁
2. 单事务删除该 repo 的解析衍生数据——**账本与其物化视图（events/aliases/手工边/AI 断言）一概不动**（不可再生知识与解析数据的边界，spec §2.2.4）
3. 全量扫描重建（同 init 的首建流程）
4. 结束跑一次 `consistencyCheck` 并打印摘要

**输出**（人类）：

```text
✓ fpms-provider 全量重建: 412 文件 · 3,801 符号 · 9,214 边 · 6.8s
  账本数据未受影响 (1,042 行 · 物化一致)
```

`--json`：`{ repo, files, symbols, edges, duration_ms, ledger: {seq, materialized_seq} }`

**错误**：同 index。**注**：`rebuild` 不重放账本（物化视图本来就不属于解析衍生数据、未被删除）；需要「删库级」重建时直接删 `knowledge.db` 后跑任意命令触发三源重建。

### 3.3 索引任务锁（index/rebuild/app watcher 共用）

同一 **repo + 分支 + checkout 目录** 只允许一个活跃索引任务：

- app watcher 正在索引同一作用域 → CLI **缺省等待**（stderr：`等待 Penguin app 的索引任务完成…`），锁释放后继续
- `--no-wait` → 跳过并退 **4**（`--json` 输出 `{ skipped: true, reason: "index_job_locked", holder: "app" }`）
- 锁持有进程崩溃 → 残留锁按 mtime 超时回收（同账本锁策略）
- 行为确定性：等待/跳过/失败三种结果都显式可见，绝不静默启动第二个索引任务

---

## 4. `penguin search <query>`

**用途**：统一检索（= MCP `knowledge_search`）：标题 → FTS → 图邻居，笔记+符号+实体混合返回。

**旗标**：`--type note|symbol|entity`（可逗号多值）、`--repo`、`--workspace`、`--branch`、`--tag <t>`、`--limit`、`--include-sensitive`（需 app 内已解锁敏感区，否则忽略并警告）

**行为**：调 `knowledge-core` 的统一检索；敏感页默认排除（`sensitive=1` 或 `mcp_access=denied`，只显示「N 个敏感结果被隐藏」计数）。

**输出**（人类，按分数排序）：

```text
1. [symbol] GetLoginURL — fpms-provider/src/login.ts:42  [parser·EXTRACTED main@abc123 fresh]
2. [note]   Brazil GameURL Issue — cases/brazil-gameurl-issue.md  「providerId 2043 returns empty [gameURL]…」
3. [entity] trace:3d0e36a6…  被 2 篇笔记提及
   (1 个敏感结果被隐藏)
```

`--json`：`{ hits: [{node_id, node_type, title, path?, snippet?, score, provenance:{...}}], hidden_sensitive: 1 }`

**错误**：query 为空 → 退 1。零结果 → 退 0，输出空列表。

---

## 5. `penguin node <id|name>`

**用途**：单节点详情（= MCP `get_node`）：正文/签名 + 版本列表 + alias 历史 + 邻居摘要。

**旗标**：`--branch`（符号：只看该分支版本）、`--raw`（笔记：输出原始 Markdown 正文）

**行为**：

1. 解析目标：先按 node id（`node_` 前缀）→ 再 `resolveIdentity()`（identity → alias 回退）→ 再标题模糊匹配
2. 多候选 → 列出候选表（含 identity_key 和类型）退 1，**不瞎猜**
3. 符号：输出 kind/signature/file:line（当前或指定分支的 version）、全部分支的 version 表（fresh/stale + commit）、alias 历史、callers/callees 计数、关联笔记
4. 笔记：输出 frontmatter 摘要、backlinks 计数、正文（敏感页要求 `--include-sensitive` 且已解锁，否则只给「敏感页」占位）

**输出**（人类，符号例）：

```text
GetLoginURL  (function)  repo:fpms-provider
  main@abc123      src/login.ts:42-88   fresh    (req: LoginReq) => LoginRes
  feat/new-login   src/auth/login.ts:51 snapshot 实现不同(hash≠)
  曾用名: UserService.login (rename, 2026-06-30)
  callers: 7 · calls: 4 · 关联笔记: 2 (penguin backlinks 查看)
```

**错误**：找不到 → 退 1，提示最接近的 3 个候选。

---

## 6. `penguin callers <symbol>` / 7. `penguin calls <symbol>`

**用途**：谁调用它 / 它调用谁（= `explore_graph mode=who_calls|calls_of`）。

**旗标**：`--branch`、`--depth <n>`（传递闭包深度，缺省 1）、`--limit`

**行为**：目标解析同 `penguin node`（含 alias 回退、多候选列表）；沿该分支的 `calls` 边（EXTRACTED 与 INFERRED 分开展示，INFERRED 标 `?` 和 confidence）。

**输出**（人类）：

```text
callers of GetLoginURL (main@abc123):
  handleLogin        src/routes/login.ts:23   [EXTRACTED]
  retryLoginFlow     src/jobs/retry.ts:88     [EXTRACTED]
  dispatchGameEntry  src/game/entry.ts:14     [INFERRED? 0.7 多候选取最优]
```

`--json`：`{ symbol, branch, direction: "callers"|"calls", hits: [{node_id, title, file, line, method, confidence}] }`

**错误**：符号在指定分支无 version → 报 gone + last_seen 分支，退 1。

---

## 8. `penguin impact <symbol>`

**用途**：爆炸半径（= `explore_graph mode=impact`）：反向可达符号集 + 关联笔记/case。

**旗标**：`--branch`、`--depth <n>`（缺省 3）、`--limit`（缺省 50）

**行为**：从目标沿 `calls`/`imports` 反向 BFS（该分支作用域）；同时列出经 wikilink/entity 关联到受影响符号的笔记（case 优先）。超出 limit 明示「已截断，共 N」——**不静默截断**。

**输出**（人类）：

```text
impact of GetLoginURL (main@abc123, depth≤3):
  直接: 7 符号 · 二级: 23 · 三级: 41  (显示前 50 / 共 71)
  ├─ handleLogin → LoginRouter → AppServer
  └─ …
  关联笔记: Brazil GameURL Issue (case) · providerId (knowledge)
```

**错误**：同 callers。

---

## 9. `penguin backlinks <node>`

**用途**：谁链接了它（= `explore_graph mode=backlinks`）——含笔记 wikilink、frontmatter 关系、实体提及、手工边。

**旗标**：`--limit`

**输出**（人类）：

```text
backlinks of providerId:
  [wikilink]  Brazil GameURL Issue (cases/brazil-gameurl-issue.md)  [user·ASSERTED]
  [mention]   fpms-log-snippet (inbox/…)  未链接提及，第 12 行
  [frontmatter] GetLoginURL 的 related 字段
```

敏感来源的 backlink 默认只显示「1 个敏感关联页」占位。

---

## 10. `penguin path <a> <b>`

**用途**：两节点最短路径（= `explore_graph mode=path`）。

**旗标**：`--branch`（路径中的代码边取该分支）、`--max-hops <n>`（缺省 6）

**行为**：双端解析（同 node 的解析规则）→ 无向 BFS（笔记边 + 该分支代码边混走）→ 输出一条最短路径及每跳的边类型/provenance。找不到路径 → 输出「不连通（≤N 跳内）」退 0。

**输出**（人类）：

```text
Brazil GameURL Issue → GetLoginURL (3 跳):
  Brazil GameURL Issue —[wikilink·user]→ providerId —[entity_mention]→ fpms-provider —[defines·parser]→ GetLoginURL
```

---

## 11. `penguin recent [--since <t>]`

**用途**：最近重要变化（= `explore_graph mode=recent_changes`）——查 events 物化表，不是 git log。

**旗标**：`--since <ISO日期|7d|2w>`（缺省 7d）、`--repo`、`--workspace`、`--type <event_type>`（可多值）、`--limit`

**行为**：按 ts 倒序过滤 events；聚合高频低值事件（连续的 index_started/finished 折叠成一行）；origin/method 区分展示（解析器事件 vs 用户/AI 断言）。

**输出**（人类）：

```text
最近 7 天 (fpms-provider):
  07-07  rename: UserService.login → GetLoginURL (alias 已记)   [system·EXTRACTED]
  07-06  手工链接: Brazil GameURL Issue → GetLoginURL           [user·ASSERTED]
  07-05  AI 建议边被拒绝: providerId ↔ platformId                [ai·INFERRED 0.4]
  (折叠 31 次例行索引事件，--type index 查看)
```

---

## 12. `penguin compare <symbol> <branch_a> <branch_b>`

**用途**：同一符号跨分支差异（= MCP `compare_branches`）。

**行为**：

1. 解析符号 → join `symbol_versions` 取两分支的 version
2. `content_hash` 相同 → 秒答「无差异」（不读文件）
3. 不同 → 输出两版签名/位置/span 对照 + 从检出文件读出实现做统一 diff（该分支未检出则只给元数据对照并注明「内容需检出后对比」）
4. 一侧无 version → 报「分支 X 上不存在（last_seen: …）」

**输出**（人类）：

```text
GetLoginURL: main@abc123 ↔ feat/new-login@def456
  签名: (req: LoginReq) => LoginRes  →  (req: LoginReq, opts?: LoginOpts) => Promise<LoginRes>
  位置: src/login.ts:42  →  src/auth/login.ts:51 (文件移动)
  实现: 不同 (hash≠) —— diff 如下 / 或「feat/new-login 未检出，无法给出内容 diff」
```

**退出码补充**：无差异 → 0；有差异 → 0（差异不是错误；脚本用 `--json` 的 `identical` 字段判断）。

---

## 13. `penguin note <new|append|link>`

**用途**：写笔记（= MCP `write_note` 三个 action）。**所有写操作先账本后物化（§2.2 铁律），CLI 与 app 并发安全（账本锁）。**

### 13.1 `penguin note new <title>`

旗标：`--type inbox|case|knowledge|repo`（缺省 inbox）、`--tags a,b`、`--body <text>`（缺省读 stdin；终端交互时打开 `$EDITOR`）
行为：按 vault 蓝图规则生成 frontmatter（id/type/created…）→ 写 `~/.penguin/vault/<区>/<slug>.md` → 索引该文件 → 正文里的 `[[链接]]` 照常解析
输出：`✓ 创建 inbox/2026-07-07-quick-note.md (node_xxx)`
错误：同名文件已存在 → slug 加序号，不覆盖；**不允许** `--type credential`（敏感页只能在 app 内创建），退 1

### 13.2 `penguin note append <page> <text>`

旗标：`--section <heading>`（追加到指定标题下，缺省文末）
行为：解析 page（路径/标题/node id）→ 追加 Markdown → 重索引。敏感页拒绝（app 内操作），退 1
输出：`✓ 追加 3 行到 cases/brazil-gameurl-issue.md`

### 13.3 `penguin note link <from> <to>`

旗标：`--type wikilink|related`（缺省 wikilink 语义的手工边）
行为：双端解析 → `recordKnowledge({type:"manual_edge_created", origin:"user", method:"ASSERTED", …})` → 物化。**这是 CLI 上唯一的直接图写入，且只允许 note 参与的边**（from 或 to 至少一端是笔记）——纯符号↔符号的手工边不开放（spec §8.1 write_note 收窄决定）
输出：`✓ Brazil GameURL Issue —wikilink→ GetLoginURL (账本 seq 1042)`
错误：两端都不是笔记 → 退 1 提示该限制

---

## 14. `penguin doctor`

**用途**：环境 + 知识库自检（人类排障入口）。

**行为**（逐项检查，全部只读除了自动修复项）：

```text
✓ knowledge.db 存在 · schema v1
✓ 账本 1,042 行 · checksum 全部有效 · 无截断
✓ 一致性: materialized_seq 1042 = ledger seq 1042
✓ vault 路径可读写 (~/.penguin/vault) · 在 iCloud 同步下
⚠ vault 不在任何 git/同步管理下 → 建议备份（spec §9）
✓ repos: 3 个已登记 · 2 synced · 1 stale
⚠ fpms-provider 落后 2 commits → 运行 penguin index
✓ 残留锁: 无
✓ MCP 接线: claude_desktop ✓ · claude_code ✓ · codex ✗ (penguin install 修复)
```

`--fix`：自动执行安全修复（补 replay、清 stale 锁、重建缺失 FTS）；不安全项只提示。
退出码：全绿 0；有 ⚠ 3；有 ✗（不可自动修复）1。

---

## 15. `penguin install`

**用途**：交互式 TUI 安装器（clack 风格）——接入 PATH、选择 AI provider 接 MCP、可选安装同伴工具。

**行为**（交互模式，TTY 下）：

1. 定位 app 内捆绑的 CLI 入口（Tauri resources，同 MCP server 的 bundled path 探测逻辑），软链 `/usr/local/bin/penguin`（无权限 → 提示 sudo 或输出手动命令；已存在且指向自己 → 幂等跳过）
2. **AI provider 多选**（探测已安装的 agent，已接线的预勾选）：

```text
  ◆ 把 Penguin MCP 接入哪些 AI？
  │  ◉ Claude Code        （已探测到 ~/.claude.json）
  │  ◉ Codex              （已探测到 ~/.codex/config.toml）
  │  ◯ Claude Desktop     （未安装）
  │  更多 provider 后续版本加入
```

   接线复用现有 `src-tauri/src/mcp.rs` 逻辑：合并进各家配置、不覆盖其他 server。**首发 provider：Claude Code、Codex**；Claude Desktop 探测到即列出。
3. **同伴工具可选安装**（外部工具，非依赖——D3 不变；走各自官方安装器，装完即独立于 Penguin）：

```text
  ◆ 顺手装点同伴工具？（可跳过）
  │  ◯ codegraph            开发期给 AI 的代码索引（curl 官方脚本）
  │  ◯ graphify             文档/语料知识图（uv tool install）
  │  ◯ understand-anything  AI 架构导览 skills（plugin marketplace）
```

   每项显示将执行的安装命令，确认后才跑；失败单项报告不中断其余。
4. 报告汇总

**非交互**：`--yes` 全默认（PATH + 已探测到的 agent 全接，不装同伴工具）；`--agents claude-code,codex` 显式指定；CI/非 TTY 自动走非交互。

**输出**：

```text
✓ CLI: /usr/local/bin/penguin → …/Penguin.app/…/knowledge-cli/index.js
✓ MCP: claude_code 已接 · codex 本次补上
✓ 同伴工具: codegraph 已安装 (v1.2.0) · 其余跳过
```

**错误**：找不到捆绑资源（开发模式走 workspace fallback）→ 退 2；同伴工具安装失败 → 单项 ⚠ 报告，整体按其余结果定。

---

## 16. `penguin help [command]` / `--version`

**用途**：CLI 的门面。三种触达方式语义相同：`penguin help`、裸敲 `penguin`、`penguin <cmd> --help`（= `penguin help <cmd>`）。

**`penguin help`（总览）**——按场景分组，不按字母序（用户按「我想干什么」找命令）：

```text
  penguin — 你和你的 AI agents 共用的工程知识库

  索引
    init [path]        登记 repo + 首次索引
    index [path]       增量索引（改完代码后跑；app 开着时自动）
    rebuild [path]     全量重建（修复用）
    status             索引状态一览
    doctor [--fix]     自检与修复

  查询
    search <query>     统一检索（笔记+符号+实体）
    node <id|name>     节点详情（版本/曾用名/关联）
    callers <symbol>   谁调用它          calls <symbol>    它调用谁
    impact <symbol>    改动爆炸半径      backlinks <node>  谁链接了它
    path <a> <b>       两点关系路径      recent [--since]  最近重要变化
    compare <sym> <b1> <b2>   同一符号跨分支差异

  笔记
    note new|append|link      建页 / 追加 / 建链

  系统
    install            接入 PATH + MCP    help [command]    本帮助

  全局旗标: --json  --branch <b>  --repo <r>  --quiet
  详细: penguin help <command>
```

**`penguin help <command>`（单命令）**：用途一句话 + 用法 + 全部旗标 + 2~3 个真实示例 + 退出码——内容即本文档对应章节的浓缩，实现上从同一份命令元数据生成（描述文案单一来源，help 与文档不漂移）。

**行为细节**：

- 输出到 stdout（用户主动求助，不是错误）、退 0；**用错命令时**打印的简短用法提示走 stderr、退 1
- 未知命令：did-you-mean（编辑距离）+ `penguin help` 提示，退 1；冻结命令（why/replay/scar…）走 §17 的引导话术
- 语言：跟随 `LANG`/`PENGUIN_LANG`（zh → 中文描述，其余英文）——与 app 双语一致
- `penguin --version` / `-v`：输出 CLI 版本 + knowledge-core 版本 + knowledge.db schema 版本，一行；`--json` 给结构化三元组
- clack 风格渲染（§0.4 同一套视觉），非 TTY 降级纯文本

## 17. V1 明确不做（引导话术）

用户敲了冻结命令时给一句话引导而非裸报错：

```text
$ penguin why GetLoginURL
'why' 还没实现（需要意图捕获层，规划中）。近似替代：
  penguin node GetLoginURL     看符号详情与关联笔记
  penguin backlinks GetLoginURL  看哪些 case/笔记提到它
```

同样处理：`replay` `scar` `graveyard` `catchup` `impact <自然语言>`（V1 impact 只收符号名）等。未知命令 → 标准「did you mean」+ 命令列表。
