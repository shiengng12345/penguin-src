import assert from "node:assert/strict";
import { test } from "node:test";
import { ResolutionProviderChain } from "../packages/knowledge-core/dist/index.js";

const request = { language: "typescript", symbol: "lookup", contextFingerprint: "ctx-1", parserConfigHash: "parser-1" };

test("resolution providers fall through optional unavailable providers without blocking ingestion", async () => {
  const chain = new ResolutionProviderChain({ timeoutMs: 20 });
  let fallbackCalls = 0;
  chain.register({
    id: "lsp-unavailable", kind: "configured_lsp", configHash: "lsp-1", supports: () => true,
    resolve: async () => { await new Promise((resolve) => setTimeout(resolve, 100)); throw new Error("LSP_NOT_RUNNING"); },
  });
  chain.register({
    id: "parser", kind: "parser_local_exact", configHash: "parser-1", supports: () => true,
    resolve: async (input) => { fallbackCalls += 1; return { status: "verified", providerId: "parser", providerKind: "parser_local_exact", targets: [{ identityKey: `fixture::${input.symbol}` }], explanation: "AST exact", contextFingerprint: input.contextFingerprint, parserConfigHash: input.parserConfigHash, providerConfigHash: "parser-1" }; },
  });
  const result = await chain.resolve(request);
  assert.equal(result.status, "verified");
  assert.equal(result.providerId, "parser");
  assert.equal(fallbackCalls, 1);
});

test("provider cache is bound to parser/config fingerprints and invalidates on provider change", async () => {
  const chain = new ResolutionProviderChain();
  let calls = 0;
  const provider = { id: "parser", kind: "parser_local_exact", configHash: "v1", supports: () => true, resolve: async (input) => { calls += 1; return { status: "verified", providerId: "parser", providerKind: "parser_local_exact", targets: [{ identityKey: input.symbol }], explanation: "AST exact", contextFingerprint: input.contextFingerprint, parserConfigHash: input.parserConfigHash, providerConfigHash: "v1" }; } };
  chain.register(provider);
  await chain.resolve(request);
  await chain.resolve(request);
  assert.equal(calls, 1);
  await chain.resolve({ ...request, parserConfigHash: "parser-2" });
  assert.equal(calls, 2);
  chain.invalidateProvider("parser");
  await chain.resolve(request);
  assert.equal(calls, 3);
});

