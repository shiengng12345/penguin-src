# Penguin 发布前人工 UAT 清单

> 状态：等待产品所有者人工执行。自动化测试通过不代表可发布。
>
> 发布硬门槛：本清单全部通过后，产品所有者仍须明确提供版本号并明确授权发布；否则不得 commit、push、tag、publish 或 release。

## 0. 测试记录

- 测试人：________________
- 日期 / 时间：________________
- macOS 版本：________________
- Penguin 构建 / commit：________________
- Node 版本：________________
- Claude Code 版本：________________
- Codex 版本：________________
- 总结：`PASS / FAIL / BLOCKED`
- 截图或日志目录：`.codex/uat-evidence/YYYY-MM-DD/`

每项都记录 `PASS / FAIL / BLOCKED`。失败时保留：完整命令、stdout/stderr、截图、所用 repo/branch/commit；不要只写“不能用”。

## 1. 发布边界确认

- [ ] 当前测试的是计划发布的本地构建，并记录其 commit。
- [ ] 尚未创建或推送新 tag。
- [ ] 尚未触发 GitHub Release。
- [ ] 没有把静态 oracle 的 100% 误写成运行时、部署版本、reflection、field/Mongo/log literal 的 100%。

## 2. CLI 基础路径

在新终端中执行，确保不是只继承旧 shell 的 PATH：

```bash
penguin --version
penguin status --compact --json
penguin search closeAccount --json
penguin context BpAccountClosureService.closeAccount --json
penguin flow grpc::FrontendRgAccountService.closeaccount --json
```

- [ ] `penguin` 可直接解析，不需要进入 Pengvi repo。
- [ ] compact status 可解析为 JSON，repo freshness/branch 信息可理解，无未解释 error。
- [ ] `closeAccount` 搜索不出现 stale/fresh 成对重复，命中项带可用 snippet。
- [ ] context 返回 source、callers/callees/routes/tests 中实际存在的部分；空结果带诊断，不伪装成成功。
- [ ] flow 能从 Frontend RG endpoint 进入 Auth handler，并继续到后续业务链。

## 3. 四个发布级 Golden

### G1：DI caller

```bash
penguin callers updateAccountStatus --json
```

- [ ] 结果包含 `BpAccountClosureService.closeAccount`。
- [ ] 结果对应 fresh identity，而不是旧 stale 短 identity。

### G2：Auth → Risk 后端跨仓

```bash
penguin flow RiskControlClientGrpc.closeAccount --json
```

- [ ] 链路包含 Auth client 调用。
- [ ] 链路跨到 `ResponsibleGamingInternalService.CloseAccount` endpoint / handler。
- [ ] 可继续到 Risk business/repository chain；若要声称“落库字段/collection 精确写点”，必须另有运行时或 field-site 证据。

### G3：Frontend → Auth 后端

```bash
penguin flow grpc::FrontendRgAccountService.closeaccount --json
```

- [ ] endpoint 不是死胡同。
- [ ] 一跳可达 Auth controller method。
- [ ] 后续 service/repository 链与源码一致。

### G4：搜索质量

```bash
penguin search closeAccount --json
```

- [ ] 同一 symbol 不出现两套 identity 的重复结果。
- [ ] 每个可解引用 symbol 有 node id / identity 和非空 snippet。
- [ ] rank/diagnostics 字段不会误导为业务置信度。

## 4. Claude Code：canonical MCP 与 Hook 生命周期

开始前保存 `~/.claude/settings.json` 的副本或 diff；不要删除第三方配置。Claude Code 测试必须在重启后的新 session 中完成。

### 4.1 默认关闭

- [ ] 首次打开 AI 集成页时，`SessionStart` 与 `UserPromptSubmit` 默认均未选中。
- [ ] 只点“一键配置 AI 集成”不会因默认 `false,false` 删除现有 hooks。
- [ ] Claude Code 只出现 canonical `penguin` MCP；不出现 `pengvi` duplicate server。

### 4.2 SessionStart

- [ ] 只勾选 `SessionStart compact status`，点“应用 Hook 设置”。
- [ ] UI 明确反馈已更新或已是最新。
- [ ] 重启 Claude Code，新 session 注入 bounded compact status。
- [ ] 输出有长度边界，Penguin 不可用时不会阻塞 session。

### 4.3 UserPromptSubmit

- [ ] 勾选 `UserPromptSubmit bounded context`，点“应用 Hook 设置”。
- [ ] 在 Claude Code 提问：`请查看 BpAccountClosureService.closeAccount 的 callers 和 flow`。
- [ ] prompt hook 注入相关、有限长度的 Penguin context，不注入整库噪音。
- [ ] Penguin 超时/不可用时 fail-open，不阻止正常提问。

### 4.4 撤销且保留第三方 hooks

- [ ] 先确认 `~/.claude/settings.json` 中存在 RTK、CodeGraph 或其他第三方 hook（若本机原本有）。
- [ ] 取消两项，点“应用 Hook 设置”。
- [ ] UI 显示 `Penguin hooks 已移除` 或 `已是关闭状态`。
- [ ] settings JSON 仍合法，原文件权限未改变。
- [ ] 仅带 `--managed-by=penguin` 的 commands 被删除；RTK、CodeGraph、Graphify 及其他第三方 hooks 完整保留。
- [ ] 不残留 `settings.json.penguin.tmp`。
- [ ] 再点一次仍为幂等，无额外 diff。

### 4.5 Claude Code MCP 实测

在新 session 提示 Claude Code：

```text
只使用 canonical penguin MCP，不使用 grep/CodeGraph/Graphify：
1. 找出谁调用 updateAccountStatus；
2. 给出 FrontendRgAccountService.closeaccount 到 Auth handler 的 flow；
3. 给出 RiskControlClientGrpc.closeAccount 到 Risk handler 的跨仓 flow；
4. 搜索 closeAccount 并检查重复与 snippet。
```

- [ ] 四项与 CLI 结果语义一致。
- [ ] tool 列表没有 `pengvi` duplicate。
- [ ] 空结果能区分“真无结果”与“索引/解析覆盖不足”。

## 5. Codex：canonical MCP 与 AGENTS.md

- [ ] Codex 配置中只挂载 canonical `penguin` MCP，不挂载 `pengvi` duplicate。
- [ ] managed `AGENTS.md` 中有 Penguin Knowledge 指引，且不覆盖用户已有指引。
- [ ] 没有把 Claude Code 专属 hook 能力伪装成 Codex hook。
- [ ] 重启 Codex 后，以与 4.5 相同的四项提示测试；结果与 CLI/Claude Code 语义一致。
- [ ] Penguin MCP 不可用时，Codex 能看到明确错误/诊断，并可按指引退回 CLI；不会静默给出假链路。

## 6. Wiki / Desktop UI

- [ ] 正常已有索引：Wiki 能打开，Indexed repositories、Context、Graph 均可用。
- [ ] repo graph、service map、symbol context 可切换，返回按钮首次打开 symbol 后可用。
- [ ] Graph 的整洁/力导向/3D 与节点类型过滤不会产生 dangling edge 或页面崩溃。
- [ ] AI 集成逐项反馈 CLI、MCP、guidance 的成功/跳过/失败，不显示 blanket success。
- [ ] 两个 Hook checkbox、独立“应用 Hook 设置”和“两项均关闭时移除 Penguin hooks”提示清晰可见。
- [ ] 索引进度、手动刷新、自动刷新、per-repo watch 与 bulk watch 符合权限和持久化预期。
- [ ] fresh onboarding 只在隔离测试 profile / 测试机验证；不得为测试而删除真实 `~/.penguin` 数据。

## 7. 失败注入与数据安全

- [ ] Claude settings 含非法 JSON 时，应用 hooks 明确失败，原文件内容不被覆盖。
- [ ] Claude settings 为 `0600` 时，应用/移除后仍为 `0600`。
- [ ] 重复应用同一设置没有额外写入或重复 hook。
- [ ] Penguin CLI/MCP 超时或 index 不存在时，agent hook fail-open；UI 给出可行动诊断。
- [ ] 对用户已有 Claude/Codex 配置只做 managed merge，不清空未知字段。

## 8. 当前能力边界（不得假 PASS）

以下不是本次 GREEN gate 的完整能力；需要对应 adapter/runtime 证据后才能宣称支持：

- field read/write sites（例如所有 `accountStatus` 写点）；
- Mongo collection 一等节点及完整 readers/writers/indexes；
- log literal → enclosing method；
- 部署 image → commit → symbol 的运行时映射；
- reflection/dynamic runtime dispatch 的全量覆盖。

- [ ] 对外说明与产品 UI 没有把这些边界包装成“每一种场景 100%”。

## 9. UAT 结论与发布授权（由产品所有者填写）

- UAT 结论：`PASS / FAIL / BLOCKED`
- 未通过项：________________
- 计划发布版本：________________
- 是否明确授权 commit/push/tag/release：`是 / 否`
- 授权原文：________________

只有以下三项同时成立才进入发布流程：

1. UAT=`PASS`；
2. 已给出明确版本号；
3. 已明确授权发布。

