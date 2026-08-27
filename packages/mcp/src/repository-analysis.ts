import {
  packageDependencies,
  search,
  type KnowledgeStore,
} from "@penguin/knowledge-core";

export type AnalysisFocus = "auto" | "dependency" | "logging" | "calls" | "architecture";

export interface RepositoryAnalysisOptions {
  query: string;
  repo?: string;
  focus?: AnalysisFocus;
  limit?: number;
}

export interface RepositoryAnalysis {
  focus: Exclude<AnalysisFocus, "auto">;
  verifiedFacts: string[];
  inferences: string[];
  gaps: string[];
  evidence: unknown[];
  nextTools: string[];
}

export function selectAnalysisFocus(query: string, requested: AnalysisFocus = "auto"): Exclude<AnalysisFocus, "auto"> {
  if (requested !== "auto") return requested;
  if (/depend|package|npm|pnpm|lockfile/i.test(query)) return "dependency";
  if (/log|stdout|pino|sls|logtail|otel/i.test(query)) return "logging";
  if (/call|caller|invoke|route/i.test(query)) return "calls";
  return "architecture";
}

export function analyzeRepository(store: KnowledgeStore, options: RepositoryAnalysisOptions): RepositoryAnalysis {
  const focus = selectAnalysisFocus(options.query, options.focus ?? "auto");
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const verifiedFacts: string[] = [];
  const inferences: string[] = [];
  const gaps: string[] = [];
  const evidence: unknown[] = [];

  if (focus === "dependency") {
    const subject = options.repo ?? options.query;
    const result = packageDependencies(store, {
      subject,
      direction: "dependencies",
      transitive: true,
      maxDepth: 5,
      limit,
    });
    evidence.push(result);
    if (result.status === "subject_not_found") {
      gaps.push(`No indexed package subject matched "${subject}"; this is not proof that the package is absent.`);
    } else if (result.status === "subject_ambiguous") {
      gaps.push(`Package subject "${subject}" matched multiple indexed services; specify an exact identity before trusting dependencies.`);
    } else {
      for (const node of result.nodes) {
        verifiedFacts.push(`${subject} depends on ${node.title} at graph depth ${node.depth}.`);
      }
      if (result.truncated) gaps.push("Dependency graph traversal was bounded by maxDepth or limit.");
    }
    gaps.push("Deployment/runtime dependencies outside indexed manifests are not verified.");
    return { focus, verifiedFacts, inferences, gaps, evidence, nextTools: ["package_dependencies", "dependency_path"] };
  }

  const hits = search(store, options.query, { repo: options.repo, limit });
  evidence.push(...hits);
  for (const hit of hits) verifiedFacts.push(`Indexed ${hit.nodeType} match: ${hit.title} (${hit.identityKey}).`);
  if (hits.length === 0) gaps.push("No indexed symbol or note matched; empty search is not proof of absence.");

  if (focus === "logging") {
    verifiedFacts.push("Only logging components present in the indexed code/notes can be verified locally.");
    gaps.push("stdout → Logtail → SLS is outside the local repository evidence unless deployment configuration is indexed.");
    gaps.push("PROD logs, CPMS data, and runtime delivery are not verified; use Aliyun SLS or the relevant backend observability tools.");
    inferences.push("A local logger-to-stdout chain may explain application emission, but it does not prove external ingestion or retention.");
    return { focus, verifiedFacts, inferences, gaps, evidence, nextTools: ["knowledge_search", "explore_graph", "aliyun SLS trace search"] };
  }
  if (focus === "calls") {
    gaps.push("Static graph results may miss DI, HTTP, reflection, and dynamic dispatch; empty edges are not proof of no runtime call.");
    return { focus, verifiedFacts, inferences, gaps, evidence, nextTools: ["knowledge_explore", "explore_graph", "Aliyun SLS"] };
  }
  gaps.push("Architecture view is limited to indexed repositories, branches, symbols, notes, and edges.");
  return { focus, verifiedFacts, inferences, gaps, evidence, nextTools: ["get_architecture", "find_communities", "index_status"] };
}
