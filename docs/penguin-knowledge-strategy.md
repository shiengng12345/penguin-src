# Penguin Knowledge — 最终战略与设计 (Branch-aware Engineering Memory Engine)

> **实施状态：已被 `docs/superpowers/plans/2026-07-17-penguin-knowledge-v2-universal-retrieval.md` supersede。** 本文保留为历史战略背景；实施时以 Master Plan 的 contract、测试、schema、CLI/MCP/Wiki parity 与验收门槛为准。外部 indexer 仅可作为迁移期 oracle，Penguin release correctness 不得依赖 adapter fallback。

> 日期：2026-07-09
> 综合来源：DeepSeek + Codex 独立评审 + `understand_anything_graphify_penguin_strategy.md`
> 状态：已完成 P1–P3 图谱底座(typed 边 / file·route·entity 节点 / import 收窄解析 / git 仓库名);
> 本文定稿「分支模型」与后续路线,并对标 Understand-Anything / Graphify / CodeGraph。

---

## 0. 北极星

**Penguin = branch-aware 工程记忆引擎;主产品是「AI 写代码前的 Context Pack」,不是图。**
图谱是底座,不是卖点。竞品帮你「看懂」或「查图」;Penguin 让 AI **记住系统为什么这样设计,并且永不搞错分支**。

> Understand-Anything 帮人看懂代码;Graphify 帮 AI 查项目图;
> **Penguin 让 AI 记住代码背后的工程真相,且永不搞错分支。**

---

## 1. 五方对比:Penguin vs Understand-Anything / Graphify / CodeGraph / codebase-memory-mcp

| 维度 | Understand-Anything | Graphify | CodeGraph | codebase-memory-mcp | **Penguin(现状+规划)** |
|---|---|---|---|---|---|
| **一句话定位** | 代码理解 Dashboard + AI 解释器 | 多模态知识图谱生成器 | AI agent 本地代码结构索引器 | 高性能 MCP-first 代码智能后端 | **分支感知的工程记忆引擎** |
| **代码解析** | LLM/multi-agent | 本地 tree-sitter | 本地 SQLite 索引 | 本地 tree-sitter + **hybrid LSP/类型解析** | ✅ 本地 tree-sitter + import 收窄 |
| **输入范围** | code/docs/KB | 极广:code/PDF/图/视频/SQL/IaC | code | **code(155+ 语言)** | code + note;多模态不做 |
| **存储形态** | 一次性 json | 一次性 json/html/md | 本地 SQLite | 本地 SQLite + **可共享 `graph.db.zst`** | ✅ 事件溯源 SQLite(可重建/长期) |
| **Branch 感知** | ❌ | ❌ | ❌ | ❌(能 detect changes,不建模 symbol version) | ✅ **头号差异化** |
| **Note↔Code(why)** | 🟡 分析 docs | 🟡 抽 WHY 注释 | ❌ | 🟡 **ADR**(不完整) | ✅ fusion;规划 typed 笔记 |
| **Confidence 标记** | ❌ | ✅ EXTRACTED/INFERRED | 🟡 | 🟡(dead code 带 risk) | ✅ origin+method+confidence,歧义丢弃 |
| **Error/Incident** | ❌ | 🟡 抽文档 | ❌ | 🟡 ADR only | ✅ error 实体;规划事故生命周期 |
| **AI Context Pack** | 🟡 chat | 🟡 REPORT.md | 🟡 explore | 🟡 提供 tools 让 AI 自查 | ✅ **主产品**:一键打包给 AI |
| **查询接口** | dashboard | query/path/explain+hooks | MCP explore | **MCP-first**(trace/impact/architecture) | ✅ CLI+MCP+UI 共享层 |
| **跨服务/跨 repo** | ❌ | 🟡 | 🟡 | ✅ **成熟**(HTTP/gRPC/GraphQL/tRPC/pub-sub) | 🟡 gRPC 已建、recall 待调 |
| **典型语义边** | file/func/dep | 调用/社区/god node | 调用/dispatch | 调用/import/route/community/cross-service | ✅ calls/references/imports/defines/tests/handles/invokes/throws/uses+git |
| **产品形态** | Web dashboard | CLI+skill+静态产物 | CLI/MCP | **单 binary** + MCP + 3D graph UI | ✅ Tauri 桌面 + CLI + MCP |
| **最强场景** | 新人 onboarding | AI 用图替代 grep | agent 结构索引 | agent 极快查结构、跨服务、多语言 | **AI 改代码前拿带分支/踩坑史的最小上下文** |

**结论**:四个对手都**没把 branch-aware、长期工程记忆、Context Pack、error/decision 生命周期**当核心——这是 Penguin 的空位。`codebase-memory-mcp` 是其中**底层最强的**(单 binary、155 语言、hybrid LSP、成熟跨服务)——所以**不跟它拼 indexer**;吸收它的优点,在它(和其它引擎)之上做工程记忆产品层。详见 §9。

---

## 2. Branch 模型(核心决策)

### 2.1 现状与问题
- `symbol_versions` 为 `UNIQUE(node_id, branch_id)` → **每分支全量拷贝** symbol_version + 边。
- **未建模** git fork / merge-base / 未合并 commit;分支是彼此独立的快照。
- **真 bug(Codex 发现)**:`query.ts` 的 `who_calls / calls_of / backlinks / graphNeighborhood` **查边时不带 `branch_id`**。现在没炸只因每 repo 只索引 1 分支;**一旦同 repo 索引多分支,答案会串**。
- **语义 bug**:分支视图应对着 **merge-base** 解析,而非当前 main,否则 main 新 commit 会漏进老分支。

### 2.2 终局架构(DeepSeek + Codex 一致)
```
content-addressed 事实：symbol_impls(content_hash 去重) / edge_facts
  + 分支覆盖：branch_symbol_deltas / branch_edge_deltas (op = add|modify|delete)
  + git 拓扑：commits / commit_parents / branch_bases(merge_base_sha, ahead, behind)
分支视图 = base 全量 − 分支删除 + 分支增改;未改文件继承 base
解析锚定 merge-base commit;lookup 查「base+overlay」合并视图
```
- **边**:仍按文件 `replaceFileEdges` 重算(现管线已如此),写成 edge_facts + 分支 delta;变更文件 + import 依赖者重算,不做全局调用图重算。
- **可选**:`effective_branch_symbols/edges` 作热分支的物化缓存。

### 2.3 分期落地(采纳 Codex 的顺序:先对后省)
- **Phase A — 正确性(现在做,便宜,修真 bug)**
  1. 所有图查询强制 `branch_id`(缺失即 fail-closed)。
  2. 加 git 拓扑表 + `branch_bases`(merge-base / ahead / behind)。
  3. freshness 元数据:对比 head / merge-base / 脏工作区 / 文件 hash / 索引时间;Context Pack 打印 `{branch, head, merge_base, indexed_commit, stale 原因}`。
- **Phase B — 省存储(延后)**:content-addressed + delta 表 + 物化视图。
  **触发条件**:单 repo 活跃分支 >5–10、或 DB 体积/索引时间明显、或跨分支 diff 成刚需。
  现状 5 repo 各 1 分支,**存储未爆,不迁**。

---

## 3. 总路线(按价值排序)

**已完成(P1–P3)**:typed 边(calls/references/imports/defines/tests/handles/throws/uses)+ file/route/entity 节点 + import 收窄解析(消灭假枢纽)+ git 仓库名。连通率 46%→92%,570 测试 568 通过。

| # | 事项 | 说明 |
|---|---|---|
| **1** | **Branch 正确性(Phase A)** | 修「多分支串答」bug + git 拓扑 + merge-base + freshness。小而必做 |
| **2** | **AI Context Pack** | 按分支视图打包:代码+调用链+route+test+error+note+风险+勿改清单。**主产品** |
| **3** | **Note-Why 层产品化** | typed 笔记(Decision/Incident/Compliance/Bug)+ status/owner + 连 branch/commit/PR/symbol |
| **4** | **Error/Incident memory** | error→root cause→fix→retest→PR;AI 可查历史踩坑 |
| **5** | **Flow Explorer(轻量)** | 线性渲染 Route→Service→DB→Event(数据已在图里) |

**明确延后/砍掉**:存储 delta 化(Phase B)、多模态(视频/音频)、persona/onboarding tour、god nodes/communities、大图 dashboard、team sync。

---

## 4. 评审共识与分歧记录

- **共识**:终局都是 content-addressed + branch overlay + 显式 git 拓扑;merge-base 锚定;边按文件重算 delta;每个回答标 branch/commit/freshness。Strategy 文档方向对,但别一次全上;error/incident memory 应**提前**(开发者最买账);砍多模态与「Memory OS」大愿景。
- **分歧(顺序)**:DeepSeek 主张「现在就迁存储」;Codex 主张「先修正确性,存储延后」。**本方案采纳 Codex**——当前痛点是正确性(会串分支),不是空间。
- **Codex 独有贡献**:发现查询未按 branch 过滤的真 bug + merge-base 锚定语义;这是最高优先修复项。

---

## 5. `/understand`(Understand-Anything)机制 vs Penguin

`/understand` 是一个 **Claude Code skill**——让 **AI 自己**跑 7 阶段流水线(SCAN→BATCH→**ANALYZE(LLM 子agent 读文件写 nodes/edges)**→分层→导览→校验→SAVE),产出一次性 `knowledge-graph.json`(13 节点/26 边)+ dashboard。

| | `/understand` | **Penguin** |
|---|---|---|
| 谁建图 | **LLM 建**(可能编造边、烧 token、不可复现) | **tree-sitter 确定性建**(精确、便宜、可复现) |
| 形态 | 一次性 json + dashboard,会腐烂 | 常驻 SQLite,增量/可重建/可查 |
| 谁用 | AI 跑一遍给人看 | AI 随时查(MCP),写代码前用 |
| Branch | ❌(worktree 强制重定向 main) | ✅ 分支感知 |

**取舍**:借鉴它的**呈现层**(更丰富节点类型 table/endpoint/config、分层 layers、导览 tour、i18n),但用**确定性方式**做;**LLM 只用于摘要,绝不用于建图**(它做对但用错了地方)。坚持我们的护城河:分支感知 + 确定性 + 常驻 + Context Pack。

---

## 6. 能力边界:静态能拿什么、什么需运行时/LLM

`penguin index`(纯 tree-sitter,**无 AI**)能确定性拿到的 = **代码里写死的结构(事实)**:

| 想知道 | 静态能拿? |
|---|---|
| API flow(Route→Controller→Service→Repo→DB) | ✅ 靠 handles+calls+references 边追完整链 |
| 会抛哪些 error 类型 | ✅ 静态 `throw new XError`(throws 边) |
| 请求/响应 DTO 结构(shape) | ✅ references 边 → DTO 是 symbol,可读字段/源码 |
| 可能的状态码 + 错误响应(`@HttpCode`/`HttpException(x,403)`/`throw ...Exception`) | 🟡 静态可提取,**需加一个 HTTP 契约抽取器**(做法同 route/entity) |
| env/config 使用点、测试覆盖 | ✅ uses / tests 边 |
| **真实 JSON 响应值 / 实际发生的 error / 实际状态码** | ❌ 运行时才有 |
| **纯英文「这段代码干嘛」摘要** | ❌ 需 LLM |
| **动态派发 / DI / feature flag 真实路径** | 🟡 DI 大半静态可解(构造器类型);纯动态需运行时/推断 |

**结论**:一个 API 的**契约级 response**(shape + 可能状态码 + 可能 error)静态就能给全;只有「跑起来实际返回什么」拿不到。

---

## 7. 四层知识模型(每层标来源 + 可信度)

拿不到的那几项,靠分层补——**关键差异化:Penguin 本身是 API 客户端,运行时真相本来就经手它**。

| 层 | 来源 | 拿什么 | 可信度 | 优化方案 |
|---|---|---|---|---|
| **① 静态事实** | tree-sitter | flow / 声明 error / DTO shape / env / test | 事实(EXTRACTED) | 已有;加 HTTP 契约抽取器 |
| **② 运行时观测** | REST/gRPC 调用 + 请求历史 + error_log | **真实响应体 / 实际状态码 / 实际 error**,按 env·branch 累积 | 观测样本 | **回灌**:`response_samples(route, method, status, 脱敏 body, env, branch, ts)` 连 route 节点 |
| **③ 人的 why** | 笔记(fusion) | 为什么这样设计、业务规则、踩坑 | 人工 | 已有;补 typed 笔记 + 生命周期 |
| **④ LLM 摘要** | DeepSeek(懒生成+缓存) | 「这段干嘛」1 行解释 | AI 生成 | 打开/进 Context Pack 才生成,按 content_hash 失效;**只摘要不建图** |

**动态派发/DI 单独处理**:构造器注入 → 静态 `depends_on` 边;provider 绑定 → 加 module-provider 抽取器;纯动态 → AI 推断成 `suggested` 边(走已有建议流,人工 accept/reject,永不自动信)+ 笔记补充。

**运行时通道是最大护城河**:Understand-Anything / Graphify / CodeGraph 都没有运行时数据;Penguin 的 REST/gRPC 客户端天然经手真实响应与错误,回灌进图后能回答「这个 API 实际返回过什么、报过什么错」——静态工具永远做不到。

---

## 8. codebase-memory-mcp:值得抄的 + build-vs-integrate 决策

`codebase-memory-mcp`(DeusData)是目前底层最强的 MCP-first 代码智能后端。**不跟它拼 indexer**;吸收优点 + 在其上做产品层。

### 8.1 值得抄(按价值)
| 抄什么 | 具体 | 现状 |
|---|---|---|
| **单 binary、零依赖安装** | 用户无需 node/pnpm/docker;"install and forget" | ❌ = D13 打包,提到高优先 |
| **`affected <diff>`(git diff→影响)** | PR diff → 改了哪些符号 / 影响哪些调用链·测试·风险 | 🟡 有 git 拓扑+impact,差入口。PR review 神器 |
| **architecture 一键总览** | 一调用返回 语言/packages/入口/routes/hotspots/layers | 🟡 有 repoGraph hubs,包装成工具 |
| **community detection(隐藏模块)** | 按调用密度聚类找 business flow(非文件夹) | ❌ 可抄 Leiden,映射到 business domain |
| **hybrid LSP/类型解析** | 比纯 tree-sitter 更准的调用解析 | 🟡 已有 import 收窄;后续可加 TS type-checker |
| **成熟跨服务多协议** | HTTP/gRPC/GraphQL/tRPC/Socket.IO/pub-sub | ⚠️ 我们 gRPC 已建但 recall 低(见 §8.4) |
| **团队共享 artifact** `graph.db.zst` | 团队不用各自 full index | ❌ = §8.3 双索引 |
| **dead code(带 confidence)** | 无入边符号=疑似死代码,标 confidence 避 DI 误判 | ❌ 数据现成,包装成 query |

**最该马上抄的 3 个**:① 单 binary 安装 ② `affected <diff>` ③ architecture 一键总览。

### 8.2 build-vs-integrate(决策:自研为主 + adapter 兜底)【已批准】
- **自研为主**:你们是 TS/NestJS/gRPC/Mongoose 栈,我们的确定性 indexer 已覆盖且 **branch-aware(它没有)**+ 贴着你们栈定制(routes/entities/跨 repo gRPC/Mongoose)。不落后。
- **留 adapter 接口**:Penguin Core 能吸收**外部图**(codebase-memory-mcp / CodeGraph / Graphify)补足**多语言/高精度/成熟跨服务**,不重写记忆层。便宜的保险。

### 8.3 separate + main full index【已批准】
- **per-repo 索引**(现状)+ **main/全量索引**(跨所有微服务的统一图,给跨服务查询用)。
- 打包成可共享 `.penguin/graph.db.zst`,团队共享,不用各自重建。

### 8.4 命令写入并校验 CLAUDE.md/AGENTS.md【已批准】
- `penguin init/index/setup` **都要**确保 `CLAUDE.md`/`AGENTS.md`(及 `.cursor/rules`/`.codex`)里写死指令:**"改代码前先 `penguin context` 拿 Context Pack、别直接 grep"**。
- 解决"装了 MCP 但 agent 不主动用"的问题;提供 preflight,并检测 stale context。
- ⚠️ 现实校验:实测跨服务 **invokes recall 低**(auth 514 处 ClientGrpc → 仅 1 条 invokes)。消费端 `getService` 写法比样本复杂,需调抽取器贴真实写法(字段初始化/onModuleInit/变量名),或此场景接 codebase-memory-mcp。

### 8.5 多 provider AI 路由(BYOK)【已批准】
- 产品层支持 OpenAI/Anthropic/Gemini/DeepSeek/Kimi/Qwen/Ollama/OpenRouter,BYOK。
- 按任务路由:复杂 coding→Claude/GPT;低成本摘要→DeepSeek/Qwen;长上下文→Gemini/Kimi;本地隐私→Ollama。

---

## 9. 下一步
从 **Phase 1(Branch 正确性)** 开工:① 查询强制 branch 过滤 → ② git 拓扑 + branch_bases → ③ Context Pack freshness 标注。存储 delta 化留到分支变多再做。

后续增量(不阻塞 Phase 1):HTTP 契约抽取器(§6)→ response_samples 运行时回灌(§7 ②)→ LLM 摘要懒生成(§7 ④)→ §8 的 affected/architecture/community/dead-code 工具 + 双索引 + init 写 CLAUDE.md + AI 路由。**并修跨服务 invokes recall(§8.4)**。
