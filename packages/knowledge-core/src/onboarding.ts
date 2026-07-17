import { createHash } from "node:crypto";
import { CAPABILITIES, capabilityHash } from "@penguin/knowledge-contracts";
import type { KnowledgeStore } from "./store.js";

export interface OnboardingDocument {
  markdown: string;
  revisionHash: string;
  capabilityHash: string;
  repoIds: string[];
}

function hashRevisions(store: KnowledgeStore, repoIds: string[]): string {
  const rows = (repoIds.length
    ? store.db.prepare(`SELECT repo_id, id, commit_sha FROM revision_snapshots WHERE repo_id IN (${repoIds.map(() => "?").join(",")}) ORDER BY repo_id, id`).all(...repoIds)
    : store.db.prepare("SELECT repo_id, id, commit_sha FROM revision_snapshots ORDER BY repo_id, id").all()) as Array<{ repo_id: string; id: string; commit_sha: string | null }>;
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function buildOnboardingDocument(store: KnowledgeStore, repoId?: string): OnboardingDocument {
  const repos = (store.db.prepare(repoId ? "SELECT id,name,root_path FROM repos WHERE id=?" : "SELECT id,name,root_path FROM repos ORDER BY name").all(...(repoId ? [repoId] : [])) as Array<{id:string;name:string;root_path:string}>);
  const repoIds = repos.map((repo) => repo.id);
  const revisions = hashRevisions(store, repoIds);
  const capabilities = capabilityHash(CAPABILITIES);
  const lines = [
    "# Penguin Onboarding", "",
    `<!-- penguin:onboarding revision-hash=${revisions} capability-hash=${capabilities} -->`, "",
    "## 1. 系统边界", ...repos.map((repo) => `- ${repo.name}: ${repo.root_path}`), "",
    "## 2. 主要 actor 和术语", "- 术语来自已索引的 service、endpoint、entity 和 notes。", "",
    "## 3. 关键请求/事件流程", "- 使用 `penguin flow <endpoint>` 查看已验证的线性流程。", "",
    "## 4. 数据和状态", "- 使用 `penguin architecture` 查看当前索引概况。", "",
    "## 5. 本地运行与测试入口", "- `penguin status`", "- `pnpm run typecheck`", "",
    "## 6. 常见改动的 blast radius", "- 使用 `penguin affected <file>`。", "",
    "## 7. 已知风险与 evidence gaps", "- 未索引或 coverage failed 的文件不能用于否定性结论。", "",
    "## 8. 推荐阅读顺序", "- Search → Context → Graph → Evidence", "",
  ];
  return { markdown: lines.join("\n"), revisionHash: revisions, capabilityHash: capabilities, repoIds };
}

export function buildOnboarding(store: KnowledgeStore, repoId?: string): string {
  return buildOnboardingDocument(store, repoId).markdown;
}
