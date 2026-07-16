# Penguin MCP Repository Analysis Design

## Goal

让 Penguin MCP 在目标仓库未执行 `pnpm i` 时仍能索引和解释仓库依赖，并能区分仓库事实、代码推断和部署侧缺失证据。

## Scope

本次包含三部分：

1. 扩展依赖索引，读取 `package.json` 和可用的 `pnpm-lock.yaml`，不依赖目标仓库的 `node_modules`。
2. 增加 `package_dependencies` 和 `dependency_path` 两个只读知识工具。
3. 增加 `analyze_repository` 统一入口，按依赖、日志、调用关系或架构问题组合已有知识工具，并返回证据完整度。

本次不包含：

- 自动执行 `pnpm i`、npm 安装或网络下载。
- 默认扫描目标仓库的 `node_modules`、`.env`、`.git` 或编译产物。
- 从仓库内容推断 Logtail、SLS、Fluent Bit 等外部部署链路。

敏感数据策略：MCP 工具的 `include_sensitive` 默认值为 `true`，可由调用方显式传入 `false` 触发脱敏。即使允许敏感数据，结果仍受 `limit`/分页和响应大小边界约束；`analyze_repository` 不会因为该开关自动执行 live call、replay 或状态变更操作。

## Current Boundary

当前 `packages/knowledge-indexer/src/walk.ts` 排除 `node_modules`，`package-detect.ts` 直接读取 `package.json`，但只保存 `@snsoft/*` 依赖名称；现有 MCP 的 `search_methods` 只查 `~/.penguin` 下安装的 RPC/SDK 方法。

因此新实现必须以清单文件为事实源：

- `package.json`：直接依赖、声明版本范围和依赖类型。
- `pnpm-lock.yaml`：存在时提供解析后的精确版本和传递依赖。
- 已索引依赖仓库：可作为额外源码证据，但不能替代缺失的 lockfile。

没有 lockfile 时，工具只报告可确认的直接依赖，并在 `gaps` 中说明传递链不完整。

## Data Model

将包依赖从 `string[]` 扩展为带来源的记录：

```ts
interface DependencySpec {
  name: string;
  specifier: string | null;
  scope: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";
  resolvedVersion?: string;
  source: "package.json" | "pnpm-lock.yaml" | "indexed_dependency_repo";
}
```

现有 `depends_on` 图边继续保留，依赖元数据写入 `provenance`。不要把 lockfile 解析结果伪装成源码调用边。

每次依赖查询都返回：

```ts
interface EvidenceState {
  complete: boolean;
  sources: string[];
  gaps: string[];
}
```

## MCP Tools

### `package_dependencies`

查询包或仓库的直接/传递依赖。

```json
{
  "subject": "fpms-nt-auth-player",
  "direction": "dependencies",
  "transitive": true,
  "maxDepth": 5,
  "limit": 100
}
```

返回节点、边、声明版本、解析版本、来源和 `evidence`。

### `dependency_path`

在 `depends_on` 图中查找两个主体之间的有界路径。

```json
{
  "from": "fpms-nt-auth-player",
  "to": "pino",
  "maxDepth": 8
}
```

找不到路径时必须区分：没有路径、主体不存在、索引不完整，不能统一返回空数组。

### `analyze_repository`

统一的只读分析入口：

```json
{
  "query": "auth 日志最终怎么进入 SLS",
  "repo": "auth",
  "focus": "auto",
  "limit": 50
}
```

`focus` 支持 `auto`、`dependency`、`logging`、`calls`、`architecture`。`auto` 只做确定性的关键词分类，并在结果中返回实际选择的 focus。

输出固定分层：

```json
{
  "focus": "logging",
  "verifiedFacts": [],
  "inferences": [],
  "gaps": [],
  "evidence": [],
  "nextTools": []
}
```

日志分析只能把 `nestjs-logger → console-override → pino → stdout` 标为已验证，除非部署配置也被索引，否则 `stdout → Logtail → SLS` 必须进入 `gaps`。

## Execution Flow

```text
package.json / pnpm-lock.yaml
        ↓
dependency metadata + depends_on edges
        ↓
package_dependencies / dependency_path
        ↓
analyze_repository
        ↓
verifiedFacts + gaps + evidence
```

现有 `search_methods`、`knowledge_search`、`explore_graph` 保持原职责，不通过模糊重命名解决范围问题。

## Safety and Failure Handling

- 所有新工具只读，不安装依赖，不访问网络。
- `include_sensitive=true` 时可返回完整 headers、token、request history 和 saved request body；`false` 时必须脱敏。
- `analyze_repository` 永远不自动调用 `call_method`、replay 或 PROD；live/state-changing 行为必须由调用方显式选择。
- 缺失 `package.json`、lockfile 或依赖节点时返回结构化 `gaps`。
- 查询有 `maxDepth`、`limit` 上限，避免大图遍历拖垮 MCP。
- 不读取 `.env`、凭证、`.git`、`node_modules` 和二进制文件。
- 结果必须携带来源文件和行号或图边标识；没有证据的内容只能归入 `inferences` 或 `gaps`。

## Testing

新增测试覆盖：

1. 没有 `node_modules` 时，`package.json` 仍能生成直接依赖。
2. 有 `pnpm-lock.yaml` 时能返回解析版本和传递依赖。
3. 没有 lockfile 时 `complete=false`，并返回明确 gap。
4. `package_dependencies` 支持 direct/transitive、方向和深度限制。
5. `dependency_path` 区分未找到主体、无路径和索引不完整。
6. `analyze_repository` 对依赖和日志问题返回正确 focus，并不会把外部 SLS 链路标成事实。
7. 现有知识 MCP 工具测试和 MCP bundle build 继续通过。

## Acceptance Criteria

- 一个只包含 `package.json` 和 `pnpm-lock.yaml`、没有 `node_modules` 的 fixture 能完成依赖索引。
- MCP 能从该 fixture 查询直接依赖、精确版本和可确认的传递路径。
- 对缺失 lockfile 的 fixture，MCP 明确报告不完整，不猜测传递依赖。
- `search_methods("log")` 的原有行为不改变。
- `analyze_repository` 的结果始终区分事实、推断、证据和缺口。
