import assert from "node:assert/strict";
import { test } from "node:test";
import { createRemoteEmbeddingProvider } from "../packages/knowledge-core/dist/index.js";

test("remote embeddings require explicit HTTPS allow-list and exfiltration acknowledgement", async () => {
  assert.throws(() => createRemoteEmbeddingProvider({ id: "remote", modelId: "m", endpoint: "http://embed.example.com/v1", dimensions: 2, maxTokens: 128, allowedHosts: ["embed.example.com"], acknowledgeCodeExfiltration: true }), /ALLOWLIST/);
  assert.throws(() => createRemoteEmbeddingProvider({ id: "remote", modelId: "m", endpoint: "https://embed.example.com/v1", dimensions: 2, maxTokens: 128, allowedHosts: [], acknowledgeCodeExfiltration: true }), /ALLOWLIST/);
  assert.throws(() => createRemoteEmbeddingProvider({ id: "remote", modelId: "m", endpoint: "https://embed.example.com/v1", dimensions: 2, maxTokens: 128, allowedHosts: ["embed.example.com"], acknowledgeCodeExfiltration: false }), /ACK/);
  const provider = createRemoteEmbeddingProvider({ id: "remote", modelId: "m", endpoint: "https://embed.example.com/v1", dimensions: 2, maxTokens: 128, allowedHosts: ["embed.example.com"], acknowledgeCodeExfiltration: true, fetcher: async () => ({ ok: true, status: 200, json: async () => ({ embeddings: [[0.1, 0.2]] }) }) });
  const vectors = await provider.embed(["synthetic source"]);
  assert.equal(vectors[0].length, 2);
  assert.match(provider.dataExfiltrationWarning, /source text/);
});
