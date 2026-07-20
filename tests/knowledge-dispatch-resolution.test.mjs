import assert from "node:assert/strict";
import test from "node:test";
import { applyRuntimeDispatchObservation, resolveDispatch, resolveFrameworkDispatch, ResolutionProviderChain } from "../packages/knowledge-core/dist/index.js";

const impl = (name, framework = "generic") => ({ identityKey: `repo::src/${name}.ts::${name}::handle`, framework });

test("resolution providers use exact parser priority", async () => {
  const chain = new ResolutionProviderChain({ timeoutMs: 50 });
  const seen = [];
  for (const [id, kind, target] of [["lsp", "configured_lsp", "lsp"], ["parser", "parser_local_exact", "parser"]]) {
    chain.register({ id, kind, configHash: "v1", supports: () => true, async resolve(request) { seen.push(id); return { status: "verified", providerId: id, providerKind: kind, targets: [{ identityKey: target }], explanation: "ok", contextFingerprint: request.contextFingerprint, parserConfigHash: request.parserConfigHash, providerConfigHash: "v1" }; } });
  }
  const result = await chain.resolve({ language: "typescript", symbol: "handle", contextFingerprint: "ctx", parserConfigHash: "parser" });
  assert.equal(result.targets[0].identityKey, "parser");
  assert.deepEqual(seen, ["parser"]);
});

test("interface dispatch distinguishes verified and candidate targets", () => {
  const request = { revisionId: "rev-1", method: "handle", implementations: [impl("A"), impl("B")] };
  assert.equal(resolveDispatch({ ...request, resolvedType: "A" }).status, "verified");
  assert.equal(resolveDispatch(request).status, "candidate");
});

test("DI and runtime observations stay revision/environment scoped", () => {
  const resolution = resolveDispatch({ revisionId: "rev-1", environment: "staging", method: "handle", dependencyToken: "PAYMENTS", implementations: [], providers: [{ ...impl("PaymentA", "nestjs"), providerToken: "PAYMENTS" }, { ...impl("Other"), providerToken: "OTHER" }] });
  assert.equal(resolution.status, "verified");
  const observed = applyRuntimeDispatchObservation(resolution, { revisionId: "rev-1", environment: "staging", targetIdentityKey: resolution.targets[0].identityKey, observedAt: "2026-07-18T00:00:00Z" });
  assert.equal(observed.hopType, "runtime_observation");
  assert.equal(applyRuntimeDispatchObservation(observed, { revisionId: "rev-2", environment: "staging", targetIdentityKey: resolution.targets[0].identityKey, observedAt: "2026-07-18T00:00:00Z" }).hopType, "runtime_observation");
});

test("built-in framework adapters preserve framework-specific dispatch boundaries", () => {
  for (const framework of ["nestjs", "spring"]) {
    const target = { ...impl(`${framework}Provider`, framework), providerToken: "SERVICE" };
    const result = resolveFrameworkDispatch({ revisionId: "rev-1", method: "handle", dependencyToken: "SERVICE", implementations: [], providers: [target] });
    assert.equal(result.status, "verified");
    assert.equal(result.targets[0].framework, framework);
  }
  for (const framework of ["go", "rust"]) {
    const result = resolveFrameworkDispatch({ revisionId: "rev-1", method: "handle", implementations: [impl(`${framework}Impl`, framework)] });
    assert.equal(result.status, "verified");
    assert.equal(result.targets[0].framework, framework);
  }
});
