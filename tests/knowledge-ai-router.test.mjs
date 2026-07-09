import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProvider, aiComplete } from "../packages/knowledge-cli/dist/ai.js";

test("resolveProvider defaults to deepseek and honors overrides", () => {
  const d = resolveProvider({ apiKey: "k" });
  assert.equal(d.provider, "deepseek");
  assert.equal(d.baseUrl, "https://api.deepseek.com/v1");
  const o = resolveProvider({ provider: "openai", model: "gpt-x", apiKey: "k" });
  assert.equal(o.provider, "openai");
  assert.equal(o.model, "gpt-x");
  // unknown provider falls back to deepseek
  assert.equal(resolveProvider({ provider: "nope", apiKey: "k" }).provider, "deepseek");
});

test("resolveProvider reads the key from the provider's env var", () => {
  const prev = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "env-key";
  try {
    assert.equal(resolveProvider().apiKey, "env-key");
    assert.equal(resolveProvider({ apiKey: "explicit" }).apiKey, "explicit");
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prev;
  }
});

test("aiComplete throws an actionable error when no key (BYOK)", async () => {
  await assert.rejects(
    () => aiComplete({ provider: "openai", model: "m", baseUrl: "http://x", apiKey: undefined, keyEnv: "OPENAI_API_KEY" }, []),
    /no API key.*OPENAI_API_KEY/,
  );
});
