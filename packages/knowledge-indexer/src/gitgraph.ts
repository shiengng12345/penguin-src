import { execFileSync } from "node:child_process";
import type { KnowledgeStore } from "@penguin/knowledge-core";

export interface GitGraphResult {
  commits: number;
  tags: number;
  edges: number;
}

// Read git commit/tag topology into the graph (§11: on-demand, no history copy —
// bounded to the most recent maxCommits). Uses `git log`/`for-each-ref` (git is
// present wherever a repo is; the always-on HEAD watch is the no-CLI path, §4.8).
// commit nodes: identity `commit:<sha>`; tag nodes: `tag:<name>`.
// edges: commit --parent--> parent (edge_type 'merge' when the commit has ≥2
// parents), tag --tagged--> commit. All parser-derived (rebuildable) → direct,
// idempotent INSERT OR IGNORE writes keyed on deterministic ids.
export function indexGitObjects(input: {
  store: KnowledgeStore;
  rootPath: string;
  maxCommits?: number;
}): GitGraphResult {
  const { store, rootPath } = input;
  const max = input.maxCommits ?? 300;
  const US = "\x1f";

  let logOut: string;
  try {
    logOut = execFileSync(
      "git",
      ["-C", rootPath, "log", `--max-count=${max}`, `--pretty=format:%H${US}%P${US}%an${US}%aI${US}%s`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return { commits: 0, tags: 0, edges: 0 }; // no git / not a repo / empty → skip
  }

  const insertEdge = store.db.prepare(
    `INSERT OR IGNORE INTO edges (id, src, dst, raw_target, edge_type, branch_id, origin, method, confidence, provenance, status)
     VALUES (@id, @src, @dst, @raw_target, @edge_type, NULL, 'parser', 'EXTRACTED', 1.0, '{}', 'active')`,
  );

  let commits = 0;
  let edges = 0;
  const commitNodeBySha = new Map<string, string>();

  const tx = store.db.transaction(() => {
    for (const line of logOut.split("\n")) {
      if (!line.trim()) continue;
      const [sha, parentsRaw, author, dateISO, subject] = line.split(US);
      const parents = parentsRaw ? parentsRaw.trim().split(/\s+/).filter(Boolean) : [];
      const nodeId = store.upsertNode({
        nodeType: "commit",
        identityKey: `commit:${sha}`,
        title: `${sha.slice(0, 7)} ${subject ?? ""}`.trim(),
        meta: { author, date: dateISO, parents, merge: parents.length > 1 },
      });
      commitNodeBySha.set(sha, nodeId);
      commits += 1;
    }
    // parent edges (both endpoints must be indexed commits in this window)
    for (const line of logOut.split("\n")) {
      if (!line.trim()) continue;
      const [sha, parentsRaw] = line.split(US);
      const src = commitNodeBySha.get(sha);
      if (!src) continue;
      const parents = parentsRaw ? parentsRaw.trim().split(/\s+/).filter(Boolean) : [];
      for (const psha of parents) {
        const dst = commitNodeBySha.get(psha);
        if (!dst) continue; // parent outside the window → skip (bounded)
        insertEdge.run({
          id: `edge_commit_${sha}_${psha}`,
          src,
          dst,
          raw_target: psha,
          edge_type: parents.length > 1 ? "merge" : "parent",
        });
        edges += 1;
      }
    }
  });
  tx();

  // tags → tag nodes + tagged edges
  let tags = 0;
  try {
    const tagOut = execFileSync(
      "git",
      ["-C", rootPath, "for-each-ref", `--format=%(refname:short)${US}%(objectname)${US}%(*objectname)`, "refs/tags"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    const tagTx = store.db.transaction(() => {
      for (const line of tagOut.split("\n")) {
        if (!line.trim()) continue;
        const [name, obj, deref] = line.split(US);
        const commitSha = deref && deref.trim() ? deref.trim() : obj?.trim();
        const tagNode = store.upsertNode({ nodeType: "tag", identityKey: `tag:${name}`, title: name });
        tags += 1;
        const dst = commitSha ? commitNodeBySha.get(commitSha) : undefined;
        if (dst) {
          insertEdge.run({
            id: `edge_tag_${name}_${commitSha}`,
            src: tagNode,
            dst,
            raw_target: commitSha,
            edge_type: "tagged",
          });
          edges += 1;
        }
      }
    });
    tagTx();
  } catch {
    // no tags / git failure → commits already captured
  }

  return { commits, tags, edges };
}
