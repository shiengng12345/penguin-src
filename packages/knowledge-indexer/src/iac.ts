export type IacKind = "docker_stage" | "service" | "deployment" | "ingress" | "config" | "secret_ref" | "terraform_resource" | "workflow_job" | "helm_value" | "port" | "volume";
export interface IacFact { kind: IacKind; name: string; status: "verified" | "candidate"; evidence: "explicit_locator" | "name_heuristic"; startLine: number; locator: { filePath: string; startLine: number }; relation?: "depends_on" | "references" | "exposes" | "mounts" | "runs"; }

function add(out: IacFact[], filePath: string, fact: Omit<IacFact, "locator" | "evidence">): void { out.push({ ...fact, evidence: fact.status === "verified" ? "explicit_locator" : "name_heuristic", locator: { filePath, startLine: fact.startLine } }); }

export interface DeploymentBlastRadiusResult { verified: IacFact[]; candidates: IacFact[]; }

/** Exact IaC locators are verified; fuzzy/name matches remain candidates. */
export function deploymentBlastRadius(facts: IacFact[], target: string): DeploymentBlastRadiusResult {
  const needle = target.trim().toLowerCase();
  const verified = facts.filter((fact) => fact.status === "verified" && fact.evidence === "explicit_locator" && fact.name.toLowerCase() === needle);
  const candidates = facts.filter((fact) => !verified.includes(fact) && (fact.status === "candidate" || fact.name.toLowerCase().includes(needle) || needle.includes(fact.name.toLowerCase())));
  return { verified, candidates };
}

/** Extract deployment facts without ever persisting secret values. Names and
 * key locators are safe; values on password/token/secret lines are ignored. */
export function extractIacFacts(filePath: string, source: string): IacFact[] {
  const out: IacFact[] = [];
  const docker = /(?:^|\/)(?:Dockerfile(?:\.[^/]+)?|dockerfile)$/i.test(filePath);
  const compose = /(?:^|\/)(?:docker-compose|compose)(?:\.[^/]+)?\.ya?ml$/i.test(filePath);
  const k8s = /(?:deployment|service|ingress|configmap|secret|statefulset|daemonset)\.ya?ml$/i.test(filePath) || /k8s|kubernetes/i.test(filePath);
  const terraform = /\.(?:tf|tfvars)$/i.test(filePath);
  const workflow = /(?:^|\/)\.github\/workflows\/.*\.ya?ml$/i.test(filePath);
  const helm = /(?:^|\/)charts?\/|templates\//i.test(filePath) || /values\.ya?ml$/i.test(filePath);
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, "");
    const startLine = index + 1;
    if (docker) {
      let match = /^\s*FROM\s+([^\s]+)(?:\s+AS\s+([^\s]+))?/i.exec(line);
      if (match) add(out, filePath, { kind: "docker_stage", name: match[2] ?? match[1], status: "verified", startLine, relation: "runs" });
      match = /^\s*EXPOSE\s+([^\s]+)/i.exec(line);
      if (match) add(out, filePath, { kind: "port", name: match[1], status: "verified", startLine, relation: "exposes" });
      if (/^\s*(?:ENTRYPOINT|CMD)\b/i.test(line)) add(out, filePath, { kind: "docker_stage", name: line.trim().split(/\s+/)[0], status: "verified", startLine, relation: "runs" });
    }
    if (compose) {
      let match = /^\s{2}([A-Za-z0-9_.-]+):\s*$/u.exec(line);
      if (match) add(out, filePath, { kind: "service", name: match[1], status: "verified", startLine });
      match = /^\s*-\s*([A-Za-z0-9_.-]+)(?::\d+)?/u.exec(line);
      if (match && /depends_on|services/i.test(source.split(/\r?\n/).slice(Math.max(0, index - 3), index + 1).join("\n"))) add(out, filePath, { kind: "service", name: match[1], status: "verified", startLine, relation: "depends_on" });
      match = /^\s*-\s*["']?([^"']+)["']?\s*$/u.exec(line);
      if (match && /volumes:/i.test(source.split(/\r?\n/).slice(Math.max(0, index - 4), index).join("\n"))) add(out, filePath, { kind: "volume", name: match[1], status: "verified", startLine, relation: "mounts" });
    }
    if (k8s) {
      let match = /^\s*kind:\s*([A-Za-z0-9]+)/u.exec(line);
      if (match) add(out, filePath, { kind: match[1].toLowerCase() === "service" ? "service" : match[1].toLowerCase() === "ingress" ? "ingress" : match[1].toLowerCase() === "secret" ? "secret_ref" : match[1].toLowerCase() === "configmap" ? "config" : "deployment", name: match[1], status: "verified", startLine });
      match = /^\s*(?:name|secretName|configMap):\s*([A-Za-z0-9_.${}-]+)/u.exec(line);
      if (match) add(out, filePath, { kind: /secret/i.test(line) ? "secret_ref" : "config", name: match[1], status: match[1].includes("${") ? "candidate" : "verified", startLine, relation: "references" });
    }
    if (terraform) {
      const match = /^\s*(resource|module|data)\s+"([^"]+)"\s+"([^"]+)"/u.exec(line);
      if (match) add(out, filePath, { kind: "terraform_resource", name: `${match[2]}.${match[3]}`, status: "verified", startLine });
    }
    if (workflow) {
      const match = /^\s{2}([A-Za-z0-9_.-]+):\s*$/u.exec(line);
      if (match) add(out, filePath, { kind: "workflow_job", name: match[1], status: "verified", startLine });
    }
    if (helm) {
      for (const match of line.matchAll(/\.Values\.([A-Za-z0-9_.-]+)/g)) add(out, filePath, { kind: "helm_value", name: match[1], status: "candidate", startLine, relation: "references" });
    }
    if (/\b(?:password|passwd|token|secret|private[_-]?key)\s*:/i.test(raw)) {
      const key = /^\s*([A-Za-z0-9_.-]+)\s*:/u.exec(raw)?.[1] ?? "secret";
      add(out, filePath, { kind: "secret_ref", name: key, status: "verified", startLine, relation: "references" });
    }
  }
  return out;
}
