export type EdgeProofKind = "ast_exact" | "type_resolution" | "lsp_resolution" | "framework_registration" | "runtime_observation" | "framework_convention" | "heuristic";
export interface EdgeProofInput { method?: string | null; provenance?: unknown; }
export interface EdgeTrust { status: "verified" | "candidate"; proof: EdgeProofKind; explanation: string; }

/** One trust gate for every graph surface. Parser EXTRACTED is AST-backed;
 * inferred/heuristic/framework-convention evidence cannot silently become a
 * verified affected edge. */
export function classifyEdgeTrust(input: EdgeProofInput): EdgeTrust {
  const provenance = typeof input.provenance === "string" ? (() => { try { return JSON.parse(input.provenance) as Record<string, unknown>; } catch { return {}; } })() : (input.provenance as Record<string, unknown> | undefined) ?? {};
  if (input.method === "INFERRED" || provenance.proof === "heuristic" || provenance.frameworkConvention === true) {
    return { status: "candidate", proof: provenance.frameworkConvention === true ? "framework_convention" : "heuristic", explanation: "candidate evidence requires a concrete registration/type/runtime proof" };
  }
  const proof = (provenance.proof as EdgeProofKind | undefined) ?? (provenance.runtimeObservation ? "runtime_observation" : provenance.typeResolved ? "type_resolution" : provenance.lspResolved ? "lsp_resolution" : provenance.frameworkRegistration ? "framework_registration" : "ast_exact");
  return { status: "verified", proof, explanation: `verified by ${proof}` };
}
