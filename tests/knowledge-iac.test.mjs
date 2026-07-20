import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentBlastRadius, extractIacFacts } from "../packages/knowledge-indexer/dist/index.js";

test("IaC extraction keeps deployment locators and never stores secret values", () => {
  const facts = extractIacFacts("deploy/k8s/deployment.yaml", [
    "kind: Deployment",
    "metadata:",
    "  name: api",
    "secretKeyRef:",
    "  name: api-secrets",
    "  key: DATABASE_URL",
    "password: do-not-store-this-value",
  ].join("\n"));
  assert.ok(facts.some((fact) => fact.kind === "deployment"));
  assert.ok(facts.some((fact) => fact.kind === "secret_ref" && fact.name === "api-secrets"));
  assert.ok(facts.some((fact) => fact.kind === "secret_ref" && fact.name === "password"));
  assert.ok(!facts.some((fact) => fact.name.includes("do-not-store")));
});

test("deployment blast radius separates explicit references from name heuristics", () => {
  const facts = extractIacFacts("deploy/compose.yaml", [
    "services:",
    "  api:",
    "    depends_on:",
    "      - postgres",
    "    image: api:latest",
    "    environment:",
    "      API_NAME: api",
  ].join("\n"));
  const result = deploymentBlastRadius(facts, "postgres");
  assert.ok(result.verified.some((fact) => fact.name === "postgres" && fact.evidence === "explicit_locator"));
  const candidate = deploymentBlastRadius([{ ...facts[0], name: "api-postgres", status: "candidate", evidence: "name_heuristic" }], "postgres");
  assert.equal(candidate.verified.length, 0);
  assert.equal(candidate.candidates.length, 1);
});
