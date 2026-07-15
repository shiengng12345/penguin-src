简体中文 | 图谱工具能力手册 + Penguin 命令生态（完整版）

# 图谱工具能力手册 + Penguin 命令生态

> 本文是**自包含完整版**：前半是四个图谱工具（Obsidian / codegraph / graphify / Understand-Anything）的能力与命令；后半把原规划**全文搬入**——命令生态、`penguin init` 设计、SQLite 存储设计。
>
> **命名拍板（2026-07-07）**：命令生态的 `zoo` 字眼全部改为 `penguin`（`penguin init`、`penguin_why`、`.penguin/penguin.db`……）。产品名仍是 **Zoo Party**、游戏世界层仍是 **Zoo World**（R4 不变）。已存在的实物（`zoo-context`、`zoo-gate` 二进制、`zoo-core` crate、`data/zoo-party.sqlite3`）**实际改名另行处理**，本文提到它们时保留现名以免对不上现实。
> ⚠️ 注意重名：你工作环境已有 `penguin` / `pengvi` 两个 MCP server（snsoft gRPC 调试用），Zoo Party 的 Penguin MCP 正式接线前要定名区分。
>
> 原文出处：[command-ecosystem.md](../vision/command-ecosystem.md)（❄️ 已冻结·北极星）与 [knowledge-engine.md](knowledge-engine.md)。原文件保持不动，本文为搬入整合版；两边如有出入以原文为准、回来修这里。

---



# 第一部分：四个图谱工具



## 0. 一句话分工


| 工具                      | 大白话定位                                          | 输入                          | 产出                                            | 建图花不花 LLM token |
| ----------------------- | ---------------------------------------------- | --------------------------- | --------------------------------------------- | --------------- |
| **Obsidian**            | 人看笔记的"参照物"——Zoo Party knowledge-hub 就是照着它的形态做的 | `.md` 笔记                    | 双链笔记 + 图视图（App，不是 CLI）                        | 不花（纯本地 App）     |
| **codegraph**           | 给 **AI 编码用**的代码符号级索引："这个函数谁在调、改了会炸哪"           | 纯代码（30+ 语言）                 | `.codegraph/` SQLite 图库 + MCP 工具              | 不花（纯静态解析）       |
| **graphify**            | 把**文档/语料**（也能吃代码、PDF、视频）榨成知识图 + 可视化报告          | 代码 + 文档 + PDF/图片/视频/YouTube | `graphify-out/`（HTML 可视化 + MD 报告 + JSON 图）    | 代码不花；文档/媒体走 LLM |
| **Understand-Anything** | 让 AI **读一遍代码库讲给人听**：架构导览、上手指南、业务域流程图           | 代码 + markdown wiki          | `.understand-anything/` JSON 图 + 网页 dashboard | 花得多（整条流水线跑 LLM） |


打个比方：**codegraph 是代码的"户口本"**（谁跟谁什么关系，秒查）；**graphify 是资料室的"索引卡片墙"**（一屋子文档浓缩成一面墙的卡片和线）；**Understand-Anything 是请了个导游**（带你逛一遍项目，讲人话，但导游按小时收费）；**Obsidian 是你自己的笔记本**（前三个是工具，这个是我们产品要长成的样子）。

---

j

## 1. Obsidian —— knowledge-hub 的对标物

**是什么**：本地优先的 Markdown 双链笔记 App。没有 CLI，不进 registry——它对 Zoo Party 的意义是**能力清单 = 我们 knowledge-hub 的对标线**（[knowledge-hub.md](../modules/knowledge-hub.md) 明确写了"Obsidian 式"）。

**核心能力**（也就是我们对标/兼容的点）：

- **Vault**：一个文件夹就是全部，文件为真相——和我们 AR4"文件为真相、DB 为索引"同源。
- `[[双链]]` **+ 反链面板**：Sprint 22 已做兼容（frontmatter UUID 身份）。
- **Graph View**：全库关系图 + 局部图——Sprint 24 的 React canvas 图视图对标这里。
- **插件生态**：Dataview（把笔记当数据库查）、Canvas（白板）、Templates、Daily Notes——这是它护城河，也是我们 registry/skill_pack 思路的参照。
- **Obsidian URI**：`obsidian://open?vault=X&file=Y` 外部唤起——如果以后想"Zoo Party 里点一下跳到 Obsidian 打开某笔记"，走这个协议即可。

**和我们的关系**：不接入、不依赖，只保证 `.md` 双向兼容——Zoo Party 的笔记随时能丢进 Obsidian 打开，反之亦然。graphify 还能直接**导出 Obsidian vault**（见下），等于第三方工具也认这个格式当通用出口。

---



## 2. codegraph（[colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)）—— 代码户口本

**是什么**：把整个代码库静态解析成本地 SQLite 符号图（函数/类/调用边/文件），AI 编码时一次查询拿到"源码 + 调用链 + 影响面"，不用来回 grep + 读文件。纯本地、零 LLM 成本、30+ 语言（含 Rust/TS，正好覆盖我们 crates + apps）。MIT，活跃维护。

**本仓现状**：✅ **已接入在用**。`.codegraph/codegraph.db`（约 5MB）+ 文件监听 daemon 自动增量同步 + MCP（`codegraph_explore`）已连到 Claude Code。本机 v1.1.6（上游已出 v1.2.0，可 `codegraph upgrade`）。

**常用命令**：

```bash
codegraph init [path]        # 初始化 + 建初始索引（本仓已做）
codegraph sync               # 增量同步（daemon 在跑，一般不用手动）
codegraph status             # 索引状态 / 统计
codegraph query <搜索词>      # 搜符号
codegraph explore <问题>      # 一把查：相关源码 + 调用路径（= MCP 工具的 CLI 版）
codegraph node <符号|文件>    # 单个符号的源码 + 上下游
codegraph callers <符号>      # 谁调用它
codegraph callees <符号>      # 它调用谁
codegraph impact <符号>       # 改它会波及哪些代码（爆炸半径）
codegraph affected [文件...]  # 改动波及哪些测试文件
codegraph daemon             # 管理后台监听进程
codegraph upgrade            # 升级
```

大多数 `--json` 可选，方便程序消费。

**注意**：匿名遥测默认开（`codegraph telemetry off` 可关）；>1MB 单文件跳过；小仓收益低（我们这个体量正合适）。

---



## 3. graphify（[Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify)）—— 资料室索引卡片墙

**是什么**：Python 工具，把一个目录（代码、Markdown、PDF、图片、视频、YouTube 链接、SQL schema……）榨成一张可查询的知识图：节点 + 边 + Leiden 社区聚类，产出交互式 HTML、Markdown 报告（**自带 Obsidian 式** `[[wikilink]]`）、JSON 图。代码走 tree-sitter 纯本地零成本；文档/媒体走你配置的 LLM 后端做语义抽取。每条边都标 `EXTRACTED`（原文明确写了）还是 `INFERRED`（AI 推断的）——这跟我们 AR5"事实 vs AI 推断分开"是同一个思想。MIT，非常活跃（昨天刚发 v0.9.8）。

**本仓现状**：✅ **已跑过一轮**（2026-07-04，针对 docs 语料 176 文件 ≈14.6 万词）：`graphify-out/` 里有 GRAPH_REPORT.md（1511 节点 · 2305 边 · 159 社区）、graph.html、graph.json。基于 commit `81c0d689`，**现在已过期**——文档改过之后要 `graphify update .` 刷新（免 API 费）。本机 v0.9.5（上游 v0.9.8）。

**常用命令**：

```bash
/graphify .                          # （skill 形式）全量建图
graphify update .                    # 只重抽变过的文件，零 LLM 成本 —— 日常刷新用这个
graphify query "auth 和 database 怎么连起来的?"   # 自然语言查图
graphify path "节点A" "节点B"          # 两个节点间最短路径
graphify explain "某概念"              # 单节点大白话解释 + 邻居
graphify cluster-only . --resolution 1.5   # 重跑社区聚类
graphify merge-graphs a.json b.json  # 合并多仓图（跨仓一张图）
graphify global add graph.json --as zoo-party   # 登记进全局图（~/.graphify/global-graph.json）
graphify add <论文/视频 URL>          # 把外部资料拉进语料并入图
graphify export callflow-html        # Mermaid 架构/调用流 HTML
graphify hook install                # git post-commit 自动重建
graphify benchmark                   # 算这张图省了多少 token
```

**MCP 形态**（可选，暂未接）：`python -m graphify.serve graphify-out/graph.json`，提供 `query_graph / get_node / get_neighbors / shortest_path` 等工具。

**注意**：文档/PDF/图片会发给你配置的云端 LLM（代码不出本地）；>5000 节点的 graph.html 浏览器可能打不开（用 JSON + CLI 查）；还能**导出成 Obsidian vault / markdown wiki / GraphML / Cypher（Neo4j）**——出口格式很全。

---



## 4. Understand-Anything（[Egonex-AI/Understand-Anything](https://github.com/Egonex-AI/Understand-Anything)）—— 按小时收费的导游

**是什么**：不是独立 CLI，而是一套装进 Claude Code 的 **skills（slash 命令）**。tree-sitter 静态解析打底 + 多 agent LLM 流水线（6 个专职 agent、每批 20–30 文件并行），产出：交互式网页 dashboard、按依赖顺序的架构导览、业务域流程图、diff 影响分析、新人上手指南。支持中文输出（`--language zh`）。原作者 Lum1104，现由 Egonex-AI 维护，MIT。

**本仓现状**：⚠️ **已安装、未真正跑完**。skills 已装到 `~/.claude/skills/`（当时是 `npx skills add Lum1104/Understand-Anything`，即旧仓名；现在官方推荐 `/plugin marketplace add Egonex-AI/Understand-Anything`）。本仓 `.understand-anything/` 只有空的 `intermediate/` 和 `tmp/`——**还没有生成 knowledge-graph.json**，等于导游请了还没开团。

**命令**（都是 Claude Code 里的斜杠命令，不是 shell 命令）：

```
/understand                    # 全库分析建图（重跑时增量）
/understand apps/desktop       # 只分析某个子目录
/understand --language zh      # 中文输出
/understand --auto-update      # 装 post-commit 钩子自动更新
/understand-dashboard          # 打开网页可视化
/understand-chat <问题>         # 基于知识图问答
/understand-diff               # 分析当前改动/PR 的影响面
/understand-explain <文件>      # 深挖某个文件/函数/模块
/understand-onboard            # 生成上手指南
/understand-domain             # 抽业务域 + 流程图
/understand-knowledge <wiki目录> # 分析 markdown wiki（认 [[wikilink]]）
```

**注意**：首次全量分析**很吃 token**（语义层全靠宿主 LLM 跑，跟 codegraph/graphify 的零成本建图不同）——要跑就挑着范围跑（比如先 `/understand apps/desktop --language zh`）；产物建议提交 git，但 `intermediate/` 和 `diff-overlay.json` 不提交；无 MCP server 形态。

---



## 5. 四者怎么配合（对 Zoo Party 的意义）

**不重复、三层各管一摊：**

1. **代码层（实时）→ codegraph**：AI 写代码时的日常索引，已在用，继续用。对应 knowledge-hub 的"自动代码图 L1/L2"是我们**自己产品内**要做的功能，codegraph 是**开发期给 AI 用**的工具——两回事，不冲突（Sprint 25 的 zoo-context `--graph` 也是自己的，不依赖 codegraph）。
2. **文档/知识层（半实时）→ graphify**：docs/ 语料的全景图，`graphify update .` 低成本刷新。它的 `EXTRACTED/INFERRED` 边标签、社区聚类、Obsidian 导出，对我们设计 knowledge-hub 的 edge type/confidence（AR5）是现成的参考实现。
3. **讲解层（按需、贵）→ Understand-Anything**：不日常跑；在"要一份人话架构导览/上手文档/业务域图"时点一次，比如给某个模块做 `/understand-explain` 或全库 `/understand-onboard`。
4. **Obsidian**：不是工具是**标尺**——knowledge-hub 的 `.md` + `[[双链]]` + 图视图做到"丢进 Obsidian 能无损打开"就算合格。

**registry 归类（F5）**：codegraph → `external_tool`（已接入，[tool-candidates.md](tool-candidates.md) 已更新）；graphify → `external_tool`（已试用）；Understand-Anything → `skill_pack`（已装未跑）；Obsidian → 不入册，对标物。

**维护提醒**：

- graphify 的图基于 `81c0d689`，文档一动就旧——想常新就 `graphify hook install`。
- 两个工具都有可用升级：`codegraph upgrade`（1.1.6→1.2.0）、`uv tool install graphifyy`（0.9.5→0.9.8）。

---



# 第二部分：Penguin 命令生态（原规划全文，zoo→penguin）

> 原状态保留：**❄️ 已冻结（frozen）· 北极星/参考，非近期承诺。** 捕获阶段共 ~115 命令；经 2026-07-01 全项目复盘（RV12）决定：先不排期、先不取舍、不作为 backlog，等 [inventions.md](../vision/inventions.md) 附录 C 的捕获实验出结果再谈优先级。**近期首发集候选**（仅当地基验证通过后）：`why/explain/search/catchup/doctor/review/graph/status`。
> 目标：给 Zoo Party 一套 `git`/`docker`/`gh`/`claude` 级别、但走得更远的命令生态；在 Claude Code / Codex CLI / Cursor / VS Code / 终端 / MCP 里都像原生。



## 6. 设计原则（命令怎么长）

1. **一个动词一件事**（Rich Hickey：简单）。命令是**动词**（why/impact/replay），不是名词（graph/history）。
2. **四面一体**：每个命令同时以四种形态存在，一套语义：

  | 面     | 形态                                          | 例                           |
  | ----- | ------------------------------------------- | --------------------------- |
  | CLI   | `penguin <verb> [args]`                     | `penguin why auth.login`    |
  | Slash | `/penguin <verb> [args]`（Claude Code/Codex） | `/penguin why auth.login`   |
  | MCP   | `penguin_<verb>(...)`                       | `penguin_why("auth.login")` |
  | 桌面    | 一个视图/动作（世界里点建筑或右键节点）                        | "为什么"面板                     |

3. **反套路**：**不**把 `penguin grep / penguin log / penguin diff` 当头牌（那些 IDE/大模型已够用）。头牌是 `why / impact / replay / scar / catchup / graveyard`——问"代码没写的东西"。
4. **零配置**：没有 `--build-index / --embed / --generate-graph` 这种参数（用户永不手动建索引）。命令只管问，引擎在后台自己是最新的。
5. **每条输出带出处**（AR5）：结果一律附 `来源 / 置信度 / 新旧(staleness) / 在哪个 commit 成立`。**事实**和 **AI 推断**分开标，绝不混。
6. **全局旗标**（几乎所有命令通用）：
  - `--as-of <commit|date|tag>` 时间旅行（"2024 年时的样子"）
  - `--branch <b>` 指定分支知识
  - `--why` 附带原因链
  - `--explain` 大白话模式（给人看）
  - `--json` 机器可读（给 AI/脚本）
  - `--confidence <min>` 只要高可信度结果
7. **成熟度标签**（记录用，先不决定）：`🟢P1 本地可做` · `🟡P2` · `🔮 依赖尚未建成的捕获层（意图/假设/AI指纹）` · `⚪ 长期/团队级`。



## 7. 旗舰命令（全 6 段规格）——"我希望这存在"的核心

> 这 15 个是生态的灵魂。其余按类目在第 8 节紧凑登记。



### ⭐ `penguin why <thing>` — 为什么存在（不是它做什么）

- **目的**：解释某段代码/规则/配置**为什么存在**——意图、拍板人、解决的需求、当时约束。
- **用法**：`penguin why payment/refund.ts:calcFee` · `/penguin why fail-closed` · `penguin_why("FaceIndex.checkStatus")`
- **预期输出**：
  ```
  为什么 checkStatus 是 fail-closed？
  → 因为风控要求：轮询期身份未确认时默认拒绝（意图，来源：2026-06 与 Claude 的对话，置信度 0.9）
  → 拍板：ADR-14（决策）｜引入：PR #88｜作者：you
  → 在 commit def456 起成立；至今有效
  ```
- **AI 用例**：AI 改这段前先 `penguin_why` 拿到意图，避免改掉一个"看起来多余、其实是合规要求"的判断。
- **为什么存在**：代码只写了 WHAT，WHY 只在人脑/对话里。这是 Zoo Party 的命根子命令。
- **改进工作流**：把"翻 git+Slack+问老人半小时"压缩成一行、几秒。



### ⭐ `penguin impact <change>` / `penguin simulate <change>` — 业务级影响（不是文件 diff）

- **目的**：写代码前，预演一个改动会牵连哪些**业务流、合规、历史事故**，而不只是哪些文件。
- **用法**：`penguin impact "删除 redis:session:*"` · `penguin simulate "把 refund 改成异步"`
- **预期输出**：代码层 7 处调用 ／ 业务流"提现""风控复核"受影响 ／ 触及 KYC 规则 R-12 ／ 先例：类似改动 2024-11 致 P0(#3)。
- **AI 用例**：AI 自动选"业务影响最小"的实现路径；交付门用它算 Blast Radius。
- **为什么存在**：真正的爆炸半径是业务级的，`git diff` 只给文件级。
- **改进工作流**：把"改完上线才发现踩了合规/牵了别的流"提前到动手前。



### ⭐ `penguin replay <feature>` — 重播一个功能的一生

- **目的**：把某功能"需求→讨论→决策→实现→评审→上线→事故→修复→今天"像放电影一样播出来。
- **用法**：`penguin replay forgot-password` · `/penguin replay payment`
- **预期输出**：一条可播放时间线（每步带 PR/ADR/commit/作者/事故链接）。
- **AI 用例**：新 AI 接手时一键"补完整个功能的来龙去脉"，不必重扫历史。
- **为什么存在**：每段软件都有故事，今天没有工具能重播它。
- **改进工作流**：新人/新 AI 几秒看懂"这东西为什么长这样、经历过什么"。



### ⭐ `penguin catchup [--since <date>]` — 我不在的时候发生了什么（重要的）

- **目的**：你离开 N 天回来，给你一份"**只挑重要的**"变化摘要——不是 commit 流水，是**含义级 + 决策级 + 事故级**的大事。
- **用法**：`penguin catchup --since "上周一"` · `/penguin catchup`
- **预期输出**：`3 件大事：① refund 计费规则含义变了(PR#91,ADR-16) ② 新增合规规则 R-15 ③ payment 出过一次 P1 已修`。忽略 40 个格式化/重构 commit。
- **AI 用例**：AI 会话开始先 `penguin_catchup` 载入"自上次以来的项目变化"，不再"每次从头来"。
- **为什么存在**：`git log` 给你 500 条噪音；你要的是"有意义的变化"。
- **改进工作流**：直接治用户痛点#1（每个新 session AI 又从头来）。



### ⭐ `penguin scar <region>` — 这块代码流过什么血 + 护栏

- **目的**：显示某代码区域的事故史，以及从事故里长出来的**疤痕规则**。
- **用法**：`penguin scar payment/calc.ts` · `penguin_scar("payout/*")`
- **预期输出**：`2024-11 P0：无灰度直发导致…（复盘#3）→ 疤痕规则：改此区域必须 feature flag + 灰度`。
- **AI 用例**：AI 编辑前 `penguin_scar` 拿到疤痕规则当硬约束；交付门违反即红灯。
- **为什么存在**：事故复盘写完就进坟，痛苦没变成预防。
- **改进工作流**：让"同一个坑不踩第二次"变成默认。



### ⭐ `penguin consensus <thing>` / `penguin ambiguity` — AI 们理解一致吗（歧义传感器）

- **目的**：因为所有 AI 都连 Zoo Party，检测不同 AI 对同一段代码的**理解分歧**，分歧高=文档债/命名误导热点。
- **用法**：`penguin consensus reconcile()` · `penguin ambiguity --top 10`
- **预期输出**：`reconcile() 歧义度 0.8：Claude 说是状态机 / Codex 说是 parser → 建议补一句 WHY`。
- **AI 用例**：把多模型分歧当"不确定性估计"，指出该补文档/意图的地方。
- **为什么存在**：模糊性从来没被度量；只有"共享大脑"能采到这个信号。
- **成熟度**：🔮 依赖 AI 理解指纹回传（Codex 提醒：先证明信号强过噪音；Phase 1 仅自家 AgentProvider 实验）。



### ⭐ `penguin graveyard` / `penguin tried <approach>` — 试过且放弃的路（负知识）

- **目的**：记住被否决/回滚的方案及**为什么放弃**，防止重蹈覆辙。
- **用法**：`penguin tried "用 Kafka 替换这里"` · `/penguin graveyard`
- **预期输出**：`⚰️ 2023-04 试过 Kafka，3 周后回滚——跨区延迟+运维成本（PR#412+回滚commit+当时对话）`。
- **AI 用例**：AI 提方案前先查墓地，命中就自动避开已被否的路。
- **为什么存在**：git 只留"最终发生的"，回滚的教训被淹没。
- **改进工作流**：团队/你自己不再反复重提被否过的方案。



### ⭐ `penguin busfactor` — 只有一个人（或没人）懂的高危区

- **目的**：标出"知识集中在单点"的代码——bus-factor=1，人一走就黑箱。
- **用法**：`penguin busfactor --risk high`
- **预期输出**：`payout/settle.ts：唯一理解者=you，近 1 年无他人改动，无文档，无测试 → 高危`。
- **AI 用例**：优先让 AI 给这些区域补 WHY/文档/测试。
- **为什么存在**：知识流失风险今天不可见，直到人走了才爆。
- **改进工作流**：主动消除"项目里的定时炸弹"。



### ⭐ `penguin forget <fact>` — 有原则地遗忘（不是删除）

- **目的**：把一条过时/错误的知识标为**失效**（下沉、不再自信端出），而非物理删除（历史仍可查）。
- **用法**：`penguin forget "webhook 一定幂等"` → 触发假设召回
- **预期输出**：`已标失效。认知召回：17 处基于此假设（9 代码/3 决策/2 文档/3 记忆），按风险排序复核？`
- **AI 用例**：所有连接的 AI 立即停用被作废的假设，防止错误信念继续毒化。
- **为什么存在**：难的不是记住，是有原则地忘（Hickey 挑战）。无限记忆=污染。
- **成熟度**：🔮 假设召回依赖 `based_on_assumption` 边的捕获（Codex 提醒：靠意图捕获先产料）。



### ⭐ `penguin challenge <decision|code>` — 红队：主动挑战一个决策/实现

- **目的**：让 Zoo Party（+另一个 AI）**站在反方**攻击一个现有决策/实现，暴露隐患。
- **用法**：`penguin challenge ADR-7` · `penguin challenge payment/calc.ts`
- **预期输出**：`ADR-7『用 Redis 扛 X QPS』：前提『X≥50k』已不成立（当前 8k）→ 决策可能过时，建议复议`。
- **AI 用例**：接第二个 AI 做对抗复审（second opinion），不是自我表扬。
- **为什么存在**：僵尸决策没人敢动；需要有人主动反驳。
- **改进工作流**：架构不腐烂——决策被持续质检。



### ⭐ `penguin trace <requirement>` — 需求 → 代码 → 部署 → 生产 全链

- **目的**：一条需求从提出到落地到上线到生产表现的完整追溯。
- **用法**：`penguin trace REQ-Legitimuz` · `penguin_requirement("KYC-poll")`
- **预期输出**：需求 → ADR-14 → PR#88 → commit → 部署 v2.3 → 生产（1 次相关事故）。
- **AI 用例**：AI 判断"这个需求实现全了吗、漏了哪条验收"。
- **为什么存在**：需求和代码今天是断的（Jira 一头、git 另一头）。
- **改进工作流**：可行性/覆盖度一目了然（接 dogfood [P1] 需求）。



### ⭐ `penguin drift` — 设计意图 vs 现实实现的偏离

- **目的**：检测"当初的架构决定"和"代码现在实际长的样子"之间的漂移。
- **用法**：`penguin drift --area payment`
- **预期输出**：`ADR-9 说 payment 不得直连 DB，但 calc.ts 现在直连了（commit abc，PR#77）→ 架构漂移`。
- **AI 用例**：AI 重构时优先修复漂移点，让代码回到设计意图。
- **为什么存在**：架构文档和代码各自演化，慢慢对不上。
- **改进工作流**：架构腐烂可见、可治。



### ⭐ `penguin unknown` — 项目里的知识黑洞

- **目的**：列出"**没人知道为什么**"的区域——没意图、没文档、没作者线索、AI 也说不清。
- **用法**：`penguin unknown --top 20`
- **预期输出**：按"重要度×无知度"排序的黑洞清单。
- **AI 用例**：把"补齐这些黑洞"变成可执行任务队列喂给 AI。
- **为什么存在**：你不知道你不知道什么；这命令把"未知"变得可见。
- **改进工作流**：系统性消灭项目盲区。



### ⭐ `penguin living-spec <feature>` / `penguin staleness` — 活规格 / 过期文档自检

- **目的**：规格/文档从"代码+意图"持续生成并**与现实比对**，发现分歧就报（甚至自修）。
- **用法**：`penguin living-spec forgot-password` · `penguin staleness --fix`
- **预期输出**：`README 说 login 用 session，代码已改 JWT（PR#91）→ 文档过期，建议更新（附草稿）`。
- **AI 用例**：AI 生成的文档不再腐烂；分歧路由给人确认（不自动改事实）。
- **为什么存在**：文档天生会烂，没工具让它自愈。
- **改进工作流**：文档第一次能"永远对得上代码"。



### ⭐ `penguin teach <topic>` / `penguin quiz` — 项目主动教你 / 考你

- **目的**：项目用**真实决策和历史**自适应地教你（苏格拉底式），并用真问题检验你的理解。
- **用法**：`penguin teach payment-flow` · `penguin quiz --area risk`
- **预期输出**：分层讲解 + "为什么当初不用 X？"这类真实决策问答。
- **AI 用例**：新人/新 AI 上手时，项目自己当老师。
- **为什么存在**：onboarding 文档是死的；知识应该会教。
- **改进工作流**：接手一个陌生模块从"几天"到"几小时"。



## 8. 全类目命令登记（紧凑表，含旗舰引用）

> 格式：`命令` — 干嘛（杀手锏）｜成熟度。旗舰已在上面展开，这里只列名保持类目完整。



### 📚 Knowledge 知识


| 命令                        | 干嘛                    | 熟     |
| ------------------------- | --------------------- | ----- |
| `penguin why` ⭐           | 为什么存在                 | 🔮/🟢 |
| `penguin explain <thing>` | 大白话解释某文件/函数/模块        | 🟢    |
| `penguin search <q>`      | 五级检索（元数据→FTS→向量→图→源码） | 🟢    |
| `penguin ask <question>`  | 自然语言问项目（对图不对源码）       | 🟢    |
| `penguin recall <topic>`  | 调取相关记忆包               | 🟢    |
| `penguin summary <path>`  | 生成/更新摘要               | 🟢    |
| `penguin glossary`        | 自动抽取的项目术语表            | 🟡    |
| `penguin assume <symbol>` | 这段代码基于哪些假设            | 🔮    |
| `penguin unknown` ⭐       | 知识黑洞清单                | 🟢    |




### 🏛 Architecture 架构


| 命令                                      | 干嘛           | 熟   |
| --------------------------------------- | ------------ | --- |
| `penguin architecture` / `penguin arch` | 活的架构图        | 🟢  |
| `penguin layers`                        | 分层视图         | 🟢  |
| `penguin boundaries`                    | 模块边界 + 越界违规  | 🟡  |
| `penguin cycles`                        | 循环依赖         | 🟢  |
| `penguin drift` ⭐                       | 设计意图 vs 现实漂移 | 🟡  |
| `penguin seams`                         | 可安全下刀的改造接缝   | 🟡  |
| `penguin boundaries-check`              | CI 用：越界即失败   | 🟡  |




### 💼 Business 业务


| 命令                             | 干嘛             | 熟   |
| ------------------------------ | -------------- | --- |
| `penguin business <feature>`   | 业务视角看功能        | 🟡  |
| `penguin flow <name>`          | 业务流            | 🟡  |
| `penguin journey <name>`       | 用户旅程           | ⚪   |
| `penguin rule <business-rule>` | 某业务规则在哪实现、变过几次 | 🟡  |
| `penguin compliance <region>`  | 触及哪些国家/合规规则    | ⚪   |
| `penguin domain`               | 业务域地图          | 🟡  |




### 🕰 History / Time 历史与时间


| 命令                           | 干嘛                   | 熟   |
| ---------------------------- | -------------------- | --- |
| `penguin replay <feature>` ⭐ | 重播一生                 | 🟡  |
| `penguin timeline <thing>`   | 语义时间线（只看含义变更）        | 🟡  |
| `penguin asof <commit|date>` | 时间旅行（也可全局 `--as-of`） | 🟢  |
| `penguin since <date>`       | 自某时以来知识变化            | 🟢  |
| `penguin born <symbol>`      | 何时、因何诞生              | 🟢  |
| `penguin evolve <symbol>`    | 含义级演化史               | 🟡  |
| `penguin whowrote <symbol>`  | 谁+为什么（不只 blame）      | 🟢  |
| `penguin catchup` ⭐          | 我不在时的大事              | 🟢  |




### 🧠 Memory 记忆


| 命令                            | 干嘛                     | 熟   |
| ----------------------------- | ---------------------- | --- |
| `penguin memory`              | 查看/管理 AI 记忆            | 🟢  |
| `penguin remember <fact>`     | 手动存一条（进草稿箱 AR7）        | 🟢  |
| `penguin forget <fact>` ⭐     | 有原则地遗忘/失效              | 🔮  |
| `penguin inbox`               | 记忆草稿箱                  | 🟢  |
| `penguin promote`             | 草稿转正（混合策略）             | 🟢  |
| `penguin pin <fact> <symbol>` | 把 WHY 钉到代码             | 🟡  |
| `penguin pack <q>`            | 生成限量 Memory Pack（给 AI） | 🟢  |




### 🤖 AI


| 命令                            | 干嘛                 | 熟   |
| ----------------------------- | ------------------ | --- |
| `penguin agents`              | 列出动物/AI 连接         | 🟢  |
| `penguin connect <ai>`        | 接入一个 AI            | 🟢  |
| `penguin route <task>`        | 给任务选最合适 AI/模型（含成本） | 🟡  |
| `penguin brief <ai> <task>`   | 给某 AI 打包"它需知道的一切"  | 🟢  |
| `penguin handoff`             | 上下文交接给另一 AI（不丢记忆）  | 🟡  |
| `penguin consensus <thing>` ⭐ | AI 理解是否一致          | 🔮  |
| `penguin ambiguity` ⭐         | 歧义热点（文档债）          | 🔮  |
| `penguin secondopinion`       | 让另一 AI 复审          | 🟡  |




### 🕸 Graph 图


| 命令                                            | 干嘛                                            | 熟   |
| --------------------------------------------- | --------------------------------------------- | --- |
| `penguin graph <node>`                        | 图视图                                           | 🟢  |
| `penguin neighbors <node>`                    | 邻居                                            | 🟢  |
| `penguin path <a> <b>`                        | 两点关系路径                                        | 🟢  |
| `penguin calls <fn>` / `penguin callers <fn>` | 调用/被调                                         | 🟢  |
| `penguin depends <node>`                      | 依赖                                            | 🟢  |
| `penguin view <type>`                         | 切视图（table/timeline/sequence/mindmap/deptree…） | 🟡  |




### 🩺 Project Health 健康


| 命令                    | 干嘛                  | 熟   |
| --------------------- | ------------------- | --- |
| `penguin doctor`      | 项目体检（含知识状态）         | 🟢  |
| `penguin vitals`      | 生命体征（复杂度/知识薄弱区实时）   | 🟡  |
| `penguin busfactor` ⭐ | 单点知识高危区             | 🟡  |
| `penguin debt`        | 技术债地图（带来源+利息估计）     | 🟡  |
| `penguin rot`         | 知识腐烂（过期摘要/失效决策/死架构） | 🟡  |
| `penguin hotspots`    | 高频改动×高复杂度           | 🟢  |
| `penguin orphans`     | 死代码/死 API           | 🟢  |
| `penguin fragile`     | 脆弱区（易炸+历史事故多）       | 🟡  |




### 📋 Requirements 需求


| 命令                               | 干嘛            | 熟   |
| -------------------------------- | ------------- | --- |
| `penguin requirement <id>`       | 需求→实现映射       | 🟡  |
| `penguin trace <requirement>` ⭐  | 需求到生产全链       | 🟡  |
| `penguin coverage <requirement>` | 实现多少/漏了啥      | 🟡  |
| `penguin contradict`             | 互相矛盾的需求       | 🔮  |
| `penguin unimplemented`          | 有需求没代码/有代码没需求 | 🟡  |




### 🔥 Production / Incidents 生产与事故


| 命令                            | 干嘛              | 熟   |
| ----------------------------- | --------------- | --- |
| `penguin incidents`           | 事故列表（连到代码）      | 🟡  |
| `penguin scar <region>` ⭐     | 流过什么血+疤痕规则      | 🟡  |
| `penguin postmortem <id>`     | 复盘（自动关联根因）      | 🟡  |
| `penguin risk <change>`       | 这改动生产上多危险（基于历史） | 🟡  |
| `penguin guardrails <region>` | 从事故长出的护栏规则      | 🟡  |




### 🚀 Deployment 部署


| 命令                              | 干嘛             | 熟   |
| ------------------------------- | -------------- | --- |
| `penguin deploys`               | 部署史            | ⚪   |
| `penguin whatshipped <version>` | 某版本到底上了什么（含义级） | 🟡  |
| `penguin rollback-history`      | 回滚史（→墓地）       | 🟡  |
| `penguin release-notes`         | 自动生成/校对发布说明    | 🟡  |




### ✅ Review 评审（交付门）


| 命令                        | 干嘛                     | 熟   |
| ------------------------- | ---------------------- | --- |
| `penguin review` ⭐        | 交付门审查（C1–56+影响+大白话）    | 🟢  |
| `penguin gate`            | 交付门状态（红/绿灯）            | 🟢  |
| `penguin explain-diff`    | 用大白话+业务影响解释改动          | 🟢  |
| `penguin challenge <x>` ⭐ | 红队挑战决策/实现              | 🟡  |
| `penguin rules`           | 当前生效的规则（R/AR/C + 项目专属） | 🟢  |




### 👥 Team 团队


| 命令                       | 干嘛          | 熟   |
| ------------------------ | ----------- | --- |
| `penguin who <topic>`    | 谁最懂这块       | 🟡  |
| `penguin style <person>` | 某人编码/评审风格画像 | ⚪   |
| `penguin consistency`    | 团队风格/模式一致性  | ⚪   |
| `penguin onboard <area>` | 生成针对性上手路径   | 🟡  |




### 📖 Documentation 文档


| 命令                                | 干嘛          | 熟   |
| --------------------------------- | ----------- | --- |
| `penguin docs`                    | 文档中心        | 🟡  |
| `penguin docgen <path>`           | 生成文档        | 🟡  |
| `penguin staleness` ⭐             | 过期文档检测+自修   | 🟡  |
| `penguin living-spec <feature>` ⭐ | 活规格         | 🔮  |
| `penguin diagram <thing>`         | 生成架构/时序/流程图 | 🟡  |




### 🎓 Learning 学习


| 命令                        | 干嘛        | 熟   |
| ------------------------- | --------- | --- |
| `penguin teach <topic>` ⭐ | 项目教你      | 🟡  |
| `penguin quiz` ⭐          | 用真实决策考你   | 🟡  |
| `penguin tour`            | 引导游览      | 🟢  |
| `penguin digest`          | 每日/每周知识摘要 | 🟡  |




### ⚰️ Graveyard 负知识


| 命令                           | 干嘛            | 熟   |
| ---------------------------- | ------------- | --- |
| `penguin graveyard` ⭐        | 死路/被否方案       | 🟡  |
| `penguin tried <approach>` ⭐ | 我们试过 X 吗、结果如何 | 🟡  |
| `penguin rejected`           | 被否决的决策/PR     | 🟡  |




### 🔮 Simulation 反事实（先模拟未来）


| 命令                            | 干嘛                  | 熟   |
| ----------------------------- | ------------------- | --- |
| `penguin simulate <change>` ⭐ | 反事实模拟               | 🟡  |
| `penguin whatif <change>`     | 同上别名                | 🟡  |
| `penguin safedelete <thing>`  | 删这个安全吗（代码+业务+合规+事故） | 🟡  |
| `penguin predict <change>`    | 预测风险/影响             | 🔮  |




### ⚙️ System / Meta 系统


| 命令                                  | 干嘛                                   | 熟   |
| ----------------------------------- | ------------------------------------ | --- |
| `penguin init` / `penguin scan`     | 登记项目+建库（自动）                          | 🟢  |
| `penguin status`                    | 知识状态（Building/Synced/Stale）          | 🟢  |
| `penguin watch`                     | 实时同步状态                               | 🟢  |
| `penguin project add/list/rm`       | 项目 CRUD（不硬编码路径）                      | 🟢  |
| `penguin sync`                      | 手动触发一次增量                             | 🟢  |
| `penguin export` / `penguin import` | 知识导出/导入（永不丢）                         | 🟡  |
| `penguin mcp`                       | 启动/管理 Zoo Party 的 Penguin MCP server | 🟢  |
| `penguin config`                    | 配置（TOML 真相源）                         | 🟢  |
| `penguin doctor`                    | 环境+知识自检                              | 🟢  |




## 9. MCP 工具面（给 AI 用的形态）

CLI 命令一一映射为 `penguin_*()` MCP 工具，AI 优先调它们而不是裸扫仓库（口径：**优先查带 provenance 的 Zoo Party，再按需回源验证**——非"禁止读源码"，采纳 Codex 修正）。核心集：
`penguin_why` · `penguin_explain` · `penguin_search` · `penguin_impact` · `penguin_replay` · `penguin_catchup` · `penguin_scar` · `penguin_graveyard` · `penguin_trace` · `penguin_memory` · `penguin_pack` · `penguin_graph` · `penguin_business` · `penguin_decision` · `penguin_requirement` · `penguin_consensus`(实验) · `penguin_review`。

每个 MCP 返回结构化 JSON，**必带** `source / confidence / staleness / valid_at_commit`（AR5）。

## 10. 桌面 UI 对应（每条命令都有）

- CLI 是"打字入口"，桌面是"点/看入口"，MCP 是"AI 入口"，三者同一语义。
- 桌面形态举例：`penguin why`=右键节点"为什么"面板；`penguin replay`=时间线播放器；`penguin doctor`=公司健康度仪表；`penguin graveyard`=Zoo World 里的"墓园"建筑；`penguin review`=交付门红绿灯屏。
- Zoo World 融入：很多命令在世界层有**建筑/动物**入口（世界即导航，A2/E5）。



## 11. 待办（先记，不决定）

- [ ] 命令去重/取舍（现 ~110 条，肯定要砍）
- [ ] 定 Phase 1 首发命令集（建议锚定旗舰里 🟢 的：why/explain/search/catchup/doctor/review/graph/status）
- [ ] 动词命名最终定调（why/impact/replay 已很稳；**CLI 前缀已定 penguin，2026-07-07**）
- [ ] `🔮` 类命令依赖的捕获层设计（意图/假设/AI指纹）——按 Codex 顺序，先地基后发明
- [ ] 用户后续追加的命令继续往本文堆

---



# 第三部分：参考实现对照 + `penguin init` 设计（原附录 A 全文）

> 来源：用户指定读两个开源参考——
>
> - CodeGraph：[https://github.com/colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)
> - Understand-Anything：[https://github.com/Egonex-AI/Understand-Anything](https://github.com/Egonex-AI/Understand-Anything)
> 结论：两者合起来正好验证了我们的设计——**CodeGraph 做"活的引擎"，Understand-Anything 做"语义富矿"**；Zoo Party = 两者相加 + 我们独有的（非代码知识 / 分支·commit 时间旅行 / 向量检索）。关联 F4（现成工具优先评估作 adapter）。



## 12. 两个参考的强项 / 短板


|      | **CodeGraph**                                                                                        | **Understand-Anything (UA)**                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| init | `codegraph install`（把 MCP 接进各 agent）+ `codegraph init`（建 `.codegraph/` + 全量图，一步）                     | `/understand`（slash，6-agent LLM 管线）                                                           |
| 存储   | **SQLite + FTS5**，符号+边，**无 embedding**                                                               | `.understand-anything/knowledge-graph.json`（**可 git 提交、队友免跑管线**）+ config.json                 |
| 更新   | **FSEvents/inotify 实时监听 + 2s 防抖自动同步（默认开）** + 后台 daemon                                               | 增量为默认；`--auto-update`=post-commit hook（**非实时**）                                               |
| 防陈旧  | **3 层**：watcher + MCP 响应贴 staleness 横幅 + 重连对账(size/mtime/hash)                                       | tree-sitter 指纹做确定性变更检测                                                                        |
| 命令   | init/index/sync/status/query/explore/node/callers/callees/**impact**/**affected**/watch/serve/daemon | /understand · -dashboard · -chat · -diff · -explain · **-onboard** · **-domain** · -knowledge |
| 强项   | 实时·确定性·便宜·100% 本地·MCP 原生·blast-radius                                                                | LLM 语义（摘要/标签/分层/导览/onboarding/业务域）+ 可分享图                                                      |
| 短板   | 无语义、无向量、无历史/时间旅行、只懂代码                                                                                | token 贵、**不实时**、JSON 不扩展(10MB+要 git-lfs)、无向量                                                  |


**两者都没有的（= Zoo Party 护城河）**：分支/commit 时间旅行 · 向量语义检索 · **非代码知识（WHY/决策/事故/墓地）** · 每条边 provenance(AR5) · AI 记忆草稿箱(AR7)。

## 13. 关键架构一课：引擎劈两层（自动又不卡）

CodeGraph 便宜所以能**实时常开**；UA 每次跑 LLM 所以**只能 commit 时跑**、烧 token。→ Zoo Party 的定调：

- **结构层（便宜·常开·确定性）**：tree-sitter 符号/边/FTS，像 CodeGraph 一样 FSEvents 实时增量，每次存盘即跟上。
- **语义层（贵·惰性·增量）**：LLM 摘要/WHY/标签/业务域 + 向量 embedding，**不在每次击键跑**，空闲后台低优先、只补变化部分。

UA 把两层混在一个 LLM 管线里→又慢又贵；我们分开，才同时满足"全自动 + 不牺牲性能"。

## 14. `penguin init` 设计（抄好的 + 补它们没有的）

**分两级（学 CodeGraph，比它更零配置）：**

1. `penguin install`（一次性·机器级）：自动探测 Claude Code / Codex / Cursor / VS Code，把 **Penguin MCP 接进去**，不建索引。（= `codegraph install`）
2. `penguin init [path]`（每项目·一步）：登记项目（名字+路径，**不硬编码**）+ 起首建。**桌面 app 里打开/登记项目即自动 init**，`penguin init` 只是 CLI/headless 入口 → 真正"打开就懂、零按钮"。

`penguin init` **干的事（探测比两参考都多）：**

- 建 `.penguin/`：`penguin.db`（SQLite：关系表 + FTS5 + **sqlite-vec**）+ 可选 `penguin.toml`（配置·文件为真相 AR4/D3）+ 可选 `penguin.snapshot`（**可 git 提交、换机/队友免重建**——偷 UA 最好的点）
- 探测 git repo / **当前分支 / 当前 commit**（两参考皆无 → 时间旅行地基 E8）
- 探测语言 / 包管理器
- **结构层秒建**（tree-sitter）→ 状态先 Synced 可用；**语义层 + 向量后台慢补**（第 13 节两层）
- 顺手接**本地非代码源**（AI 对话历史 / `.md`·ADR）——两参考皆不碰

**默认常开（学 CodeGraph 全套）：** `penguin watch` 默认开（FSEvents + 防抖 + 每项目后台 daemon，`penguin daemon(s)` 管理）；**staleness 横幅**（响应内贴"⚠️可能略旧"）；**重连对账**（hash 补齐错过的改动）。

## 15. Steal-list（直接抄，已验证可行）

- 🟢 `penguin install` 自动接 MCP 进各 agent（CG）
- 🟢 FSEvents + 防抖 + 后台 daemon + 自动同步默认开（CG）
- 🟢 staleness 横幅 + 重连对账（CG）
- 🟢 干净动词 CLI + `impact` / `affected`(受影响测试)（CG）
- 🟢 可 git 提交的**分享快照** `penguin.snapshot`，换机/队友免重建（UA）
- 🟢 LLM 语义层：摘要 / 分层 / `onboard` / `domain`（UA）



## 16. Beyond-list（超越两者，Zoo Party 独有）

- 🔵 **按 blob SHA 内容寻址**（比 CG 的 size/mtime+hash 强：跨分支天然去重，E8）
- 🔵 **分支/commit 时间旅行** `--as-of`（两者皆无）
- 🔵 **sqlite-vec 语义检索**（两者皆无）
- 🔵 **非代码知识** why/decision/scar/graveyard（CG 只懂代码、UA 只懂代码结构）
- 🔵 每条边 **provenance + 置信度**（AR5）、AI 记忆**草稿箱**（AR7）



## 17. 命令映射（把参考的好命令并入本生态）


| 参考命令                             | Penguin 对应                            | 备注                                          |
| -------------------------------- | ------------------------------------- | ------------------------------------------- |
| `codegraph install`              | `penguin install`                     | 新增（原生态漏了机器级 MCP 接线，补上）                      |
| `codegraph init`                 | `penguin init`                        | 已有                                          |
| `codegraph sync`                 | `penguin sync`                        | 已有                                          |
| `codegraph status`               | `penguin status`                      | 已有                                          |
| `codegraph explore`              | `penguin search` / `penguin_search`   | 已有                                          |
| `codegraph node/callers/callees` | `penguin neighbors/callers/calls`     | 已有                                          |
| `codegraph impact`               | `penguin impact` ⭐                    | 已有；我们扩到业务级                                  |
| `codegraph affected`             | `penguin affected`                    | **新增登记**：改动波及哪些测试（喂交付门）                     |
| `codegraph watch/daemon`         | `penguin watch` / `penguin daemon(s)` | 已有/**补 daemon**                             |
| UA `/understand-onboard`         | `penguin onboard`                     | 已有                                          |
| UA `/understand-domain`          | `penguin business`/`penguin domain`   | 已有                                          |
| UA `/understand-dashboard`       | `penguin dashboard`（桌面即是）             | 桌面 UI 对应                                    |
| UA 可提交 JSON 图                    | `penguin export`/`penguin snapshot`   | 已有 export；**补** `penguin snapshot` **分享文件** |


> **新增待记命令**：`penguin install`、`penguin affected`、`penguin snapshot`、`penguin daemon(s)`、`penguin dashboard`。（先记，不决定）

> **需求收集阶段：暂不开发。以上为参考调研产物，继续追加。**

---



# 第四部分：SQLite 存储设计（分库 + 表 + 检索，原 knowledge-engine §7–§9）



## 18. SQLite 分库总图（各管一摊，都守 AR4"删了可重建"）


| 库                             | 谁的                                               | 装什么                                                                | 状态                                         |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------ |
| `data/zoo-party.sqlite3`      | Zoo Party App 本体（zoo-core rusqlite）              | App 运行期数据（gitignore）                                               | ✅ 已存在（24KB）                                |
| `.penguin/penguin.db`（每项目）    | 知识引擎（规划）                                         | 关系表 + FTS5 + sqlite-vec，藏 `SearchIndex` trait 后，可迁 Postgres        | 📋 规划（`penguin init` 建）                    |
| `~/.penguin/context-index.db` | semantic-recall MVP（zoo-context `--build-index`） | Ollama embedding 向量缓存，头部记 schema_version + 模型名，模型不匹配拒绝用（fail-fast） | 📋 规划（未建；原文写 `~/.zoo/`，随改名迁 `~/.penguin/`） |
| `.codegraph/codegraph.db`     | 第三方 codegraph 工具自己的                              | 它的符号图——开发期工具，不是产品的一部分                                              | ✅ 已存在（5MB）                                 |


共同铁律 AR4：**文件为真相、DB 只是索引**——任何一个库删了都能从代码 + `.md` 重建，绝不是第二个真相源。

## 19. 知识引擎表设计（Phase 1 = SQLite 单文件，按 PostgreSQL 能力设计）

> 免运维；将来换 PG = 换 adapter 不返工（C2/AR6）。所有访问经 repository trait（C2/AR6/C27-29），业务层无裸 SQL（C32 参数化）。UUID 主键 / UTC 时间 / JSON 结构化，**核心关系模型不用 SQLite 专有特性**。


| 表                         | 作用                                                                                              | 关键列                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `repos`                   | 用户登记的项目（**CRUD，不硬编码**）                                                                          | `id, name, root_path, vcs, default_branch, remote_url`                                           |
| `commits`                 | commit 元数据                                                                                      | `repo_id, commit_sha(PK), parent_shas(JSON), authored_at(UTC), message`                          |
| `branches`                | 分支指针                                                                                            | `repo_id, name, head_commit_sha, last_indexed_commit`                                            |
| `commit_trees`            | 轻量快照清单                                                                                          | `repo_id, commit_sha, path, blob_sha`（也可按需从 `git ls-tree` 现算+缓存）                                 |
| `blobs`                   | **内容寻址解析缓存**（去重核心）                                                                              | `blob_sha(PK), lang, size, parsed_at, ast_digest`                                                |
| `symbols`                 | 一份内容里的符号                                                                                        | `id, blob_sha, kind, name, signature, span(JSON)`                                                |
| `nodes`                   | 统一图节点（E1：file/symbol/api/table/redis-key/kafka-topic/proto-msg/note/flow/requirement/decision…） | `id, repo_id, node_type, identity_key, current_blob_sha`                                         |
| `edges`                   | 统一图边（E1）                                                                                        | `id, repo_id, src, dst, type, source, confidence, staleness, valid_from_commit, valid_to_commit` |
| `notes_index`             | `.md` 笔记的索引（真相在文件，AR4/E2）                                                                       | `note_uuid, path, frontmatter(JSON)`                                                             |
| `memory_inbox` / `memory` | AI 记忆草稿/正式（E4/AR7）                                                                              | 见 knowledge-hub                                                                                  |




## 20. 加速索引（FTS5 + 向量）—— 仍守 AR6

FTS5 和 sqlite-vec 是 SQLite 专有的，看似撞 AR6。化解办法：**把它们关进一个** `SearchIndex` **repository trait 后面**，业务层只调 `search_text()` / `search_semantic()`，不直接碰 FTS5/vec 语法。迁 Postgres 时换实现即可：


| 能力    | Phase 1（SQLite 实现）                       | 迁 Postgres 时（换 adapter） |
| ----- | ---------------------------------------- | ----------------------- |
| 全文检索  | FTS5 虚表 `fts_symbols/fts_notes/fts_docs` | `tsvector` + GIN        |
| 语义/向量 | `sqlite-vec`（`vec_embeddings`）           | `pgvector`              |


> 这样 AR6 不破：核心关系模型零 SQLite 专有特性；FTS/向量是**可重建的加速索引**，藏在 trait 后，有等价的 PG 方案。索引丢了能从源码+笔记重建（AR4）。
> 引擎参数（切分支是否自动重建、排除目录、embedding 模型名等）走项目级 TOML 真相源（`penguin.toml`），DB 只缓存（AR4/D3）。



## 21. 增量 Embedding（本地优先，真离线）

- **模型**：用 **Ollama 跑本地 embedding 模型**（如 `nomic-embed-text` / `bge-small`）——全程不出网、无 API key、真离线（E6，2026-06-30 已批：提前进 Phase 1）。
- **增量**：只对"新增/改动的 node（符号/笔记/文档 chunk）"算 embedding，存进 `sqlite-vec`。改一个文件 ≠ 重嵌全库。
- **粒度**：函数/类级 + 笔记级 + 文档段落级，三种 chunk。
- **后台低优先**：embedding 排在解析之后、低优先批量跑，不抢前台。算不过来时先保证元数据/FTS/图可用（优雅降级）。



## 22. 查询顺序：先查知识、查不到才读源码（五级检索）

`Retriever` 按固定顺序走，产出**固定 token 预算**的 Memory Pack（top-k + 摘要 + source/confidence/last_verified）：

1. **SQLite 元数据**（精确：按名找文件/符号/路由）
2. **FTS5 全文**（关键词）
3. **sqlite-vec 语义**（按意思找）
4. **知识图遍历**（邻居/调用链/Blast Radius）
5. **才去读源码**（兜底）

> 大白话：**先翻户口本（元数据）→ 搜关键词（FTS）→ 按意思找（向量）→ 顺关系网走（图）→ 实在没有才翻源码。** 越靠前越快越省 token；读源码是最后手段。
> Memory Pack 每条多带 `last_commit_sha / stale_at_commit / blast_radius_symbols / fresh_in_commits`，让 delivery-gate 能判断"这个签名是不是过期了"。



## 23. Penguin MCP server：Zoo Party 当"知识自来水管"

Zoo Party 自己当 MCP server（生产者），把知识开放出去，任何 MCP 客户端（Claude/Codex/Gemini/Cursor/Kimi）连上来查（对 F1 是补充不冲突：F1 说的是不重复造 MCP host/client）：

- **形态**：本地 MCP server（stdio 给 CLI 类；本地 socket/HTTP 给 IDE 类如 Cursor）。
- **暴露的工具**（示例）：`search_knowledge(query, repo, branch?)`（五级检索回 Memory Pack）· `get_symbol(name|id)` · `who_calls(symbol)` / `get_call_path(a,b)` · `blast_radius(changed_symbols)`（喂 delivery-gate 复用）· `get_flow(name)` · `time_travel(query, at_commit|at_time)`。
- **规矩**：AI **能从 Zoo Party 问到的，就不直接扫仓库**；凭证经 Vault（AR3）；第三方接入经 registry 信任边界（AR8）。
- ⚠️ **命名待办**：与工作环境现有 `penguin`/`pengvi` MCP（snsoft gRPC）重名，接线前定最终 server 名。



## 24. 性能 / 内存 / 优雅降级


| 维度            | 做法                                                                |
| ------------- | ----------------------------------------------------------------- |
| **跨分支去重**     | 按 blob SHA 解析+缓存——单一最大优化，切分支≈`git diff` 成本                        |
| **增量**        | 脏队列 + content hash 挡空改动 + 符号级 diff                                |
| **不抢前台**      | 解析/embedding 在有界 worker pool 后台跑，低优先级；前台查询永远优先                    |
| **内存**        | 热 AST/图切片走 LRU 内存缓存，冷数据落 SQLite；commit 清单按需从 `git ls-tree` 现算+缓存  |
| **SQLite 调优** | WAL 模式 + mmap；FTS5/vec 单独表，不拖累关系查询                                |
| **图视图**       | 节点上限 + 按 edge type 过滤（E5，1k 节点性能 spike，RISKS #5）                  |
| **优雅降级**      | 索引落后 → 出"陈旧横幅"并照常用，**绝不卡住 delivery-gate**；解析失败 → 该文件标 Error，不拖垮全库 |


