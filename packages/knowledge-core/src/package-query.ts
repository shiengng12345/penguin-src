import type { KnowledgeStore } from "./store.js";

export type DependencyDirection = "dependencies" | "dependents" | "both";

export interface PackageDependencyNode {
  nodeId: string;
  title: string;
  identityKey: string;
  repoId: string | null;
  depth: number;
  evidence: Record<string, unknown>;
}

export interface PackageDependencyQueryResult {
  status: "ok" | "subject_not_found" | "subject_ambiguous";
  subject: string;
  nodes: PackageDependencyNode[];
  truncated: boolean;
  candidates?: PackageDependencyCandidate[];
}

export interface PackageDependencyCandidate {
  nodeId: string;
  title: string;
  identityKey: string;
  repoId: string | null;
}

export interface DependencyPathResult {
  status: "found" | "subject_not_found" | "subject_ambiguous" | "no_path";
  from: string;
  to: string;
  path: PackageDependencyNode[];
  truncated: boolean;
  fromCandidates?: PackageDependencyCandidate[];
  toCandidates?: PackageDependencyCandidate[];
}

interface PackageRow {
  id: string;
  title: string;
  identity_key: string;
  repo_id: string | null;
}

interface EdgeRow {
  id: string;
  src: string;
  dst: string;
  provenance: string;
}

const MAX_DEPTH = 32;
const MAX_LIMIT = 500;

function boundedNumber(value: number, fallback: number, max: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : fallback;
}

function resolvePackage(store: KnowledgeStore, subject: string): PackageRow[] {
  const exactId = store.db.prepare(
    `SELECT id, title, identity_key, repo_id
       FROM nodes
      WHERE node_type = 'service' AND id = ?
      LIMIT 1`,
  ).get(subject) as PackageRow | undefined;
  if (exactId) return [exactId];

  const exactIdentity = store.db.prepare(
    `SELECT id, title, identity_key, repo_id
       FROM nodes
      WHERE node_type = 'service' AND identity_key = ?
      ORDER BY id`,
  ).all(subject) as PackageRow[];
  if (exactIdentity.length > 0) return exactIdentity;

  return store.db.prepare(
    `SELECT id, title, identity_key, repo_id
       FROM nodes
      WHERE node_type = 'service' AND title = ?
      ORDER BY identity_key`,
  ).all(subject) as PackageRow[];
}

function resolveRepoPackage(store: KnowledgeStore, subject: string): PackageRow[] {
  return store.db.prepare(
    `SELECT n.id, n.title, n.identity_key, n.repo_id
     FROM nodes n JOIN repos r ON r.id = n.repo_id
     WHERE n.node_type = 'service' AND r.name = ?
     ORDER BY n.identity_key`,
  ).all(subject) as PackageRow[];
}

function resolveSubject(store: KnowledgeStore, subject: string): PackageRow[] {
  const packages = resolvePackage(store, subject);
  return packages.length > 0 ? packages : resolveRepoPackage(store, subject);
}

function candidates(rows: PackageRow[]): PackageDependencyCandidate[] {
  return rows.map((row) => ({
    nodeId: row.id,
    title: row.title,
    identityKey: row.identity_key,
    repoId: row.repo_id,
  }));
}

function parseEvidence(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return { parseError: "edge provenance is not valid JSON" };
  }
}

function edgesFor(store: KnowledgeStore, nodeId: string, direction: "dependencies" | "dependents"): EdgeRow[] {
  if (direction === "dependencies") {
    return store.db.prepare(
      `SELECT id, src, dst, provenance FROM edges
       WHERE src = ? AND dst IS NOT NULL AND edge_type = 'depends_on' AND status = 'active'
       ORDER BY id`,
    ).all(nodeId) as EdgeRow[];
  }
  return store.db.prepare(
    `SELECT id, src, dst, provenance FROM edges
     WHERE dst = ? AND edge_type = 'depends_on' AND status = 'active'
     ORDER BY id`,
  ).all(nodeId) as EdgeRow[];
}

function nodeForEdge(store: KnowledgeStore, edge: EdgeRow, direction: "dependencies" | "dependents"): PackageRow | null {
  return store.db.prepare(
    `SELECT id, title, identity_key, repo_id FROM nodes WHERE id = ? LIMIT 1`,
  ).get(direction === "dependencies" ? edge.dst : edge.src) as PackageRow | undefined ?? null;
}

function directions(direction: DependencyDirection): Array<"dependencies" | "dependents"> {
  return direction === "both" ? ["dependencies", "dependents"] : [direction];
}

export function packageDependencies(
  store: KnowledgeStore,
  options: {
    subject: string;
    direction: DependencyDirection;
    transitive: boolean;
    maxDepth: number;
    limit: number;
  },
): PackageDependencyQueryResult {
  const subjects = resolveSubject(store, options.subject);
  if (subjects.length === 0) {
    return { status: "subject_not_found", subject: options.subject, nodes: [], truncated: false };
  }
  if (subjects.length > 1) {
    return { status: "subject_ambiguous", subject: options.subject, nodes: [], truncated: false, candidates: candidates(subjects) };
  }
  const subject = subjects[0];

  const maxDepth = boundedNumber(options.maxDepth, 5, MAX_DEPTH);
  const limit = boundedNumber(options.limit, 100, MAX_LIMIT);
  const queue: Array<{ node: PackageRow; depth: number }> = [{ node: subject, depth: 0 }];
  const visited = new Set([subject.id]);
  const nodes: PackageDependencyNode[] = [];
  let truncated = false;

  while (queue.length > 0 && nodes.length < limit) {
    const current = queue.shift()!;
    for (const direction of directions(options.direction)) {
      for (const edge of edgesFor(store, current.node.id, direction)) {
        const next = nodeForEdge(store, edge, direction);
        if (!next || visited.has(next.id)) continue;
        visited.add(next.id);
        const depth = current.depth + 1;
        nodes.push({
          nodeId: next.id,
          title: next.title,
          identityKey: next.identity_key,
          repoId: next.repo_id,
          depth,
          evidence: { edgeId: edge.id, ...parseEvidence(edge.provenance) },
        });
        if (nodes.length >= limit) {
          truncated = true;
          break;
        }
        if (!options.transitive) continue;
        if (depth < maxDepth) {
          queue.push({ node: next, depth });
        } else if (directions(options.direction).some((nextDirection) => edgesFor(store, next.id, nextDirection).length > 0)) {
          truncated = true;
        }
      }
      if (nodes.length >= limit) break;
    }
  }

  if (queue.length > 0) truncated = true;
  return { status: "ok", subject: options.subject, nodes, truncated };
}

export function dependencyPath(
  store: KnowledgeStore,
  options: { from: string; to: string; maxDepth: number },
): DependencyPathResult {
  const fromRows = resolveSubject(store, options.from);
  const toRows = resolveSubject(store, options.to);
  if (fromRows.length !== 1 || toRows.length !== 1) {
    const ambiguous = fromRows.length > 1 || toRows.length > 1;
    return {
      status: ambiguous ? "subject_ambiguous" : "subject_not_found",
      from: options.from,
      to: options.to,
      path: [],
      truncated: false,
      ...(fromRows.length > 1 ? { fromCandidates: candidates(fromRows) } : {}),
      ...(toRows.length > 1 ? { toCandidates: candidates(toRows) } : {}),
    };
  }
  const from = fromRows[0];
  const to = toRows[0];
  if (!from || !to) {
    return { status: "subject_not_found", from: options.from, to: options.to, path: [], truncated: false };
  }
  if (from.id === to.id) {
    return {
      status: "found",
      from: options.from,
      to: options.to,
      path: [{ nodeId: from.id, title: from.title, identityKey: from.identity_key, repoId: from.repo_id, depth: 0, evidence: {} }],
      truncated: false,
    };
  }

  const maxDepth = boundedNumber(options.maxDepth, 8, MAX_DEPTH);
  const queue: Array<{ node: PackageRow; depth: number }> = [{ node: from, depth: 0 }];
  const visited = new Set([from.id]);
  const parent = new Map<string, { node: PackageRow; edge: EdgeRow; depth: number }>();
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of edgesFor(store, current.node.id, "dependencies")) {
      const next = nodeForEdge(store, edge, "dependencies");
      if (!next || visited.has(next.id)) continue;
      visited.add(next.id);
      const depth = current.depth + 1;
      parent.set(next.id, { node: current.node, edge, depth });
      if (next.id === to.id) {
        const path: PackageDependencyNode[] = [{
          nodeId: to.id,
          title: to.title,
          identityKey: to.identity_key,
          repoId: to.repo_id,
          depth,
          evidence: { edgeId: edge.id, ...parseEvidence(edge.provenance) },
        }];
        let currentId = next.id;
        while (currentId !== from.id) {
          const link = parent.get(currentId)!;
          path.push({
            nodeId: link.node.id,
            title: link.node.title,
            identityKey: link.node.identity_key,
            repoId: link.node.repo_id,
            depth: link.depth - 1,
            evidence: { edgeId: link.edge.id, ...parseEvidence(link.edge.provenance) },
          });
          currentId = link.node.id;
        }
        path.reverse();
        return { status: "found", from: options.from, to: options.to, path, truncated: false };
      }
      if (depth < maxDepth) queue.push({ node: next, depth });
      else if (edgesFor(store, next.id, "dependencies").length > 0) truncated = true;
    }
  }

  return { status: "no_path", from: options.from, to: options.to, path: [], truncated };
}
