import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITIES, capabilityHash, listMcpRegistrations } from "@penguin/knowledge-contracts";
import type { SurfaceRegistration } from "@penguin/knowledge-contracts";
import { reconcileCorpus, type CorpusCanonicalProjection } from "./corpus-reconciliation.js";
import type { KnowledgeStore } from "./store.js";
import { openRevisionView } from "./revision-view.js";
import { resolveRevisionContext, type RevisionContext } from "./revision.js";

export interface OnboardingDocument {
  markdown: string;
  revisionHash: string;
  capabilityHash: string;
  repoIds: string[];
  reconciliation: CorpusCanonicalProjection | null;
}

export interface OnboardingOptions {
  mcpRegistrations?: readonly SurfaceRegistration[];
  registrations?: readonly SurfaceRegistration[];
}

type RegistrationInput = readonly SurfaceRegistration[] | OnboardingOptions;

function implementedRegistrations(input: RegistrationInput): readonly SurfaceRegistration[] {
  if (Array.isArray(input)) {
    return input.filter((registration: SurfaceRegistration) => registration.status === "implemented");
  }
  const options = input as OnboardingOptions;
  const registrations = options.mcpRegistrations ?? options.registrations ?? listMcpRegistrations();
  return registrations.filter((registration: SurfaceRegistration) => registration.status === "implemented");
}

function toolCall(
  registrations: readonly SurfaceRegistration[],
  capabilityId: string,
  remediation: string,
  exampleArgs = "...",
): string {
  const registration = registrations.find((candidate) => candidate.capabilityId === capabilityId);
  return registration
    ? "`" + registration.wireName + "(" + exampleArgs + ")`"
    : `未注册或未实现 ${capabilityId}；${remediation}`;
}

function hashRevisions(store: KnowledgeStore, repoIds: string[]): string {
  const rows = (repoIds.length
    ? store.db.prepare(`SELECT repo_id, id, commit_sha FROM revision_snapshots WHERE repo_id IN (${repoIds.map(() => "?").join(",")}) ORDER BY repo_id, id`).all(...repoIds)
    : store.db.prepare("SELECT repo_id, id, commit_sha FROM revision_snapshots ORDER BY repo_id, id").all()) as Array<{ repo_id: string; id: string; commit_sha: string | null }>;
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function currentRevision(store: KnowledgeStore, repoId: string): RevisionContext | null {
  const result = resolveRevisionContext(store, { repoId });
  return result.status === "resolved" ? result.context : null;
}

function packageScripts(rootPath: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(join(rootPath, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    return raw.scripts ?? {};
  } catch {
    return {};
  }
}

function technologyAndChecks(rootPath: string): { technology: string; commands: string[] } {
  const hasCargo = existsSync(join(rootPath, "Cargo.toml"));
  const hasPackage = existsSync(join(rootPath, "package.json"));
  if (hasCargo && !hasPackage) return { technology: "Rust/Cargo", commands: ["cargo check", "cargo test"] };
  if (hasCargo && hasPackage) return { technology: "Rust/Cargo + Node workspace", commands: ["cargo check", "cargo test"] };
  if (hasPackage) {
    const scripts = packageScripts(rootPath);
    const packageManager = existsSync(join(rootPath, "pnpm-lock.yaml")) ? "pnpm" : "npm";
    const commands = [
      scripts.test ? `${packageManager} test` : null,
      scripts.typecheck ? `${packageManager} run typecheck` : null,
    ].filter((command): command is string => Boolean(command));
    return { technology: packageManager === "pnpm" ? "Node/pnpm workspace" : "Node/npm project", commands };
  }
  return { technology: "未识别（请先检查仓库 manifest）", commands: [] };
}

export function buildOnboardingDocument(
  store: KnowledgeStore,
  repoId?: string,
  registrationInput: RegistrationInput = listMcpRegistrations(),
): OnboardingDocument {
  const repos = (store.db.prepare(repoId ? "SELECT id,name,root_path FROM repos WHERE id=?" : "SELECT id,name,root_path FROM repos ORDER BY name").all(...(repoId ? [repoId] : [])) as Array<{id:string;name:string;root_path:string}>);
  const repoIds = repos.map((repo) => repo.id);
  const revisions = hashRevisions(store, repoIds);
  const capabilities = capabilityHash(CAPABILITIES);
  const registrations = implementedRegistrations(registrationInput);
  const scoped = repoId ? " WHERE repo_id=?" : "";
  const args = repoId ? [repoId] : [];
  const selectedRevision = repoId ? currentRevision(store, repoId) : null;
  const selectedView = selectedRevision ? openRevisionView(store, selectedRevision) : null;
  const reconciliation = selectedRevision?.branchId && repoId
    ? reconcileCorpus({
        store,
        scope: {
          repoId,
          branchId: selectedRevision.branchId,
          snapshotId: selectedRevision.snapshotId,
        },
      }).canonical
    : null;
  const files = reconciliation?.files.queryable ?? null;
  const symbols = reconciliation?.symbols.queryable ?? null;
  const hubs = store.db.prepare(`SELECT n.title, n.repo_id AS repoId, COUNT(e.id) AS degree FROM nodes n JOIN edges e ON (e.src=n.id OR e.dst=n.id)${repoId ? " WHERE n.repo_id=? AND " : " WHERE "}(n.node_type <> 'symbol' OR NOT EXISTS (SELECT 1 FROM symbol_versions spec_sv WHERE spec_sv.node_id=n.id AND (spec_sv.file_path LIKE '%.spec.ts' OR spec_sv.file_path LIKE '%.test.ts' OR spec_sv.file_path LIKE '%/__tests__/%'))) GROUP BY n.id ORDER BY degree DESC LIMIT 8`).all(...args) as Array<{ title: string; repoId: string | null; degree: number }>;
  const endpointIds = selectedView ? new Set(selectedView.symbolVersions().filter((row) => row.kind === "endpoint").map((row) => row.nodeId)) : null;
  if (selectedView && endpointIds && repoId) {
    const effectiveFiles = new Set(selectedView.listFiles().map((row) => row.filePath));
    const memberships = store.db.prepare("SELECT endpoint_id AS endpointId,file_path AS filePath FROM endpoint_memberships WHERE repo_id=?").all(repoId) as Array<{ endpointId: string; filePath: string }>;
    for (const membership of memberships) if (effectiveFiles.has(membership.filePath)) endpointIds.add(membership.endpointId);
  }
  const endpoints = endpointIds
    ? (endpointIds.size ? store.db.prepare(`SELECT DISTINCT title FROM nodes WHERE node_type='endpoint' AND id IN (${[...endpointIds].map(() => "?").join(",")}) ORDER BY title LIMIT 20`).all(...endpointIds) : []) as Array<{ title: string }>
    : store.db.prepare(`SELECT DISTINCT n.title FROM nodes n WHERE n.node_type='endpoint'${repoId ? " AND (n.repo_id=? OR EXISTS (SELECT 1 FROM endpoint_memberships em WHERE em.endpoint_id=n.id AND em.repo_id=?))" : ""} ORDER BY n.title LIMIT 20`).all(...(repoId ? [repoId, repoId] : [])) as Array<{ title: string }>;
  const endpointCount = reconciliation?.endpoints.queryable ?? null;
  const repoSelector = repoId && repos[0] ? repos[0].name : "<repo>";
  const semanticScopeKey = repoId ? `repo:${repoId}` : "repo:<repo-id>";
  const technology = repoId && repos[0] ? technologyAndChecks(repos[0].root_path) : { technology: "按选定仓库确认", commands: [] };
  const flowTool = toolCall(registrations, "knowledge.flow", "先读取 live MCP registrations，再选择当前可调用的流程工具");
  const coverageTool = toolCall(registrations, "knowledge.coverage", "先读取 live MCP registrations 并检查 coverage 能力是否可用");
  const architectureTool = toolCall(registrations, "knowledge.architecture", "先读取 live MCP registrations，再检查当前架构查询能力");
  const searchArgs = JSON.stringify({
    query: "<symbol-or-route>",
    mode: "lexical",
    scope: {
      revisions: [{
        repoId: repoId ?? "<repo-id>",
        snapshotId: selectedRevision?.snapshotId ?? "<snapshot-id>",
      }],
    },
    options: { semantic: "off" },
    page: { limit: 20 },
  });
  const firstRoundTools = [
    ["knowledge.index_status", "先确认当前索引状态", "..."],
    ["knowledge.coverage", "先检查 coverage 能力是否可用", "..."],
    ["knowledge.semantic_status", "先确认 semantic generation 是否 active", JSON.stringify({ scopeKey: semanticScopeKey })],
    ["knowledge.search", "改用当前 manifest 中已实现的搜索工具", searchArgs],
    ["knowledge.explore", "改用当前 manifest 中已实现的 explore 工具", "..."],
    ["knowledge.affected", "改用当前 manifest 中已实现的 affected 工具", "..."],
    ["knowledge.get_node", "先保存稳定 nodeId，再使用当前 manifest 中已实现的节点工具", "..."],
  ].map(([capabilityId, remediation, exampleArgs]) => toolCall(registrations, capabilityId, remediation, exampleArgs));
  const implementedToolLines = registrations.length
    ? registrations.map((registration) => "- `" + registration.wireName + "(...)` — " + registration.capabilityId)
    : ["- 当前没有已实现的 MCP tool；先检查 live capability manifest 并按 remediation 处理"];
  const lines = [
    "# Penguin Onboarding", "",
    `<!-- penguin:onboarding revision-hash=${revisions} capability-hash=${capabilities} -->`, "",
    "## 1. 系统边界", ...repos.map((repo) => `- ${repo.name}: ${repo.root_path}`), "",
    "## 2. 索引概况", `- 已索引文件：${files ?? "unknown"}`, `- 当前 revision symbols：${symbols ?? "unknown"}`, `- 当前 revision endpoints：${endpointCount ?? "unknown"}`, ...(selectedRevision ? [`- revision：${selectedRevision.snapshotId} (${selectedRevision.commitSha})`] : ["- revision：未能解析精确 snapshot，以下仅为仓库级下界"]), "",
    "## 3. 主要 actor 和术语", "- 术语来自已索引的 service、endpoint、entity 和 notes。", "",
    "## 4. 关键入口", ...(endpoints.length ? endpoints.map((e) => `- ${e.title}`) : ["- 当前 revision 未发现已索引 endpoint（不是全仓库不存在）"]), "",
    "## 5. 关键请求/事件流程", `- MCP-only 会话调用 ${flowTool} 查看已验证流程；若结果为 partial，必须再调用 ${coverageTool} 检查 coverage gaps。`, "",
    "## 6. 高连接节点", ...(hubs.length ? hubs.map((h) => `- ${h.title} — degree ${h.degree}`) : ["- 无可用 hub 数据"]), "",
    "## 7. 技术栈和验证命令", `- 技术栈：${technology.technology}`, ...(technology.commands.length ? technology.commands.map((command) => `- \`${command}\``) : ["- 没有从 manifest 发现可验证命令"]), "",
    "## 8. 数据和状态", `- 调用 ${architectureTool} 查看当前索引概况。`, "",
    "## 9. MCP-only 新会话第一轮检查（可直接调用）",
    ...firstRoundTools.map((tool, index) => `- ${tool}${index === 2 ? " — scopeKey 使用 status 返回的稳定 `repo:<repoId>`；先确认语义 generation 是否 active，不可用时继续使用 graph/lexical。" : ""}`),
    `- 下一页沿用同一 query/scope/options，只把 page 改为 \`{\"page\":{\"limit\":20,\"cursor\":\"<nextCursor>\"}}\`；游标来自上页的 \`nextCursor\`。`,
    "- 每次命中后保存稳定 `nodeId` / `identityKey`；继续查询时优先调用上面 manifest 选出的节点工具，不要重新猜名称。",
    "- MCP 客户端不需要 shell/CLI。所有 negative、partial、lower_bound、stale 结果都必须先检查 `coverage`、`freshness` 和 `proofStatus`。", "",
    "## 10. Owner 本机可选 CLI（非 MCP 用户前置条件）", "- `penguin status --json`", "- `penguin coverage --repo <repo> --json`", "- 仅本机开发时运行上面从 manifest 检出的验证命令。", "",
    "## 11. 常见改动的 blast radius", `- MCP-only 会话调用 \`knowledge_affected({\"file\":\"<repo-relative-file>\",\"repo\":${JSON.stringify(repoSelector)}})\`。`, "",
    "## 12. 已知风险与 evidence gaps", "- 未索引或 coverage failed 的文件不能用于否定性结论。", "- endpoint 数量仅代表当前 revision 的 canonical inventory，不把 client/test occurrence 当成 handler。", "- Penguin 是静态知识层；动态 dispatch、reflection、外部服务和运行时配置仍需源码/运行时验证。", "",
    "## 13. 推荐阅读顺序", "- Status → Coverage → Semantic Status → Scoped Search → Stable nodeId → Explore → Affected → Source Review", "",
    "## 14. 当前已实现 MCP wire names", ...implementedToolLines, "",
  ];
  return { markdown: lines.join("\n"), revisionHash: revisions, capabilityHash: capabilities, repoIds, reconciliation };
}

export function buildOnboarding(store: KnowledgeStore, repoId?: string): string {
  return buildOnboardingDocument(store, repoId).markdown;
}
