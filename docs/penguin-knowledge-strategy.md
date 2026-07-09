# Penguin Knowledge — 最终战略与设计 (Branch-aware Engineering Memory Engine)

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

## 1. 四方对比:Penguin vs Understand-Anything / Graphify / CodeGraph

| 维度 | Understand-Anything | Graphify | CodeGraph | **Penguin(现状+规划)** |
|---|---|---|---|---|
| **一句话定位** | 代码理解 Dashboard + AI 解释器 | 多模态知识图谱生成器(AI skill) | AI agent 的本地代码结构索引器 | **分支感知的工程记忆引擎** |
| **代码解析** | LLM/multi-agent pipeline | 本地 tree-sitter(code 不发 LLM) | 本地 SQLite 索引 | ✅ 本地 tree-sitter,确定性,code 不发 LLM |
| **输入范围** | code/docs/KB | 极广:code/PDF/图/视频/音频/SQL/IaC | code | code + note;多模态**明确不做** |
| **存储形态** | `knowledge-graph.json`(一次性) | `graph.json/html/md`(一次性) | 本地 SQLite | ✅ 事件溯源 SQLite(可重建/可恢复/长期) |
| **Branch 感知** | ❌ 非核心 | ❌ 分析当前目录 | ❌ | ✅ **头号差异化**:repo→branch→commit→symbol_version,跨分支 diff |
| **Note↔Code(why 层)** | 🟡 能分析 docs | 🟡 抽 WHY/NOTE 注释 | ❌ | ✅ fusion 双向链接;规划 typed 笔记 + 生命周期 |
| **Confidence 标记** | ❌ | ✅ EXTRACTED/INFERRED/AMBIGUOUS | 🟡 | ✅ 边带 origin+method+confidence;歧义直接丢弃 |
| **Error/Incident 记忆** | ❌ | 🟡 抽 error 文档 | ❌ | ✅ error 实体已有;规划事故生命周期(root cause/fix/retest/PR) |
| **AI Context Pack** | 🟡 chat/explain | 🟡 GRAPH_REPORT.md | 🟡 explore 工具 | ✅ **主产品**:branch+代码+调用链+route+test+error+note+风险,一键给 AI |
| **查询接口** | dashboard/chat | query/path/explain + hooks | MCP explore | ✅ CLI + MCP + UI 共享查询层;规划 `penguin_explore` |
| **典型语义边** | file/func/dep | 调用/引用/社区/god node | 调用/dispatch | ✅ calls/references/imports/defines/tests/handles/throws/uses + git 拓扑 |
| **产品形态** | Web dashboard | CLI + assistant skill + 静态产物 | CLI/MCP | ✅ Tauri 桌面 app + CLI + MCP |
| **最强场景** | 新人 onboarding、可视化理解 | 让 AI 用图替代 grep、项目资料整体图 | AI coding agent 本地结构索引 | **AI 改代码前拿到带分支/踩坑史的最小上下文** |

**结论**:三者都**没把 branch-aware、长期工程记忆、Context Pack、error/decision 生命周期**当核心——这正是 Penguin 的空位。Penguin 该**吸收**它们的优点(Graphify 的 confidence 标记与 assistant hooks、Understand-Anything 的 domain/flow 视图与 i18n、CodeGraph 的本地 SQLite + MCP + staleness),但**不复制**它们的形态(一次性图 / 大 dashboard / 多模态)。

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

## 5. 下一步
从 **Phase 1(Branch 正确性)** 开工:① 查询强制 branch 过滤 → ② git 拓扑 + branch_bases → ③ Context Pack freshness 标注。存储 delta 化留到分支变多再做。
