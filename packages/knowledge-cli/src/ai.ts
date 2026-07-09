// Optional AI layer (BYOK) — kept in the CLI so knowledge-core stays purely
// deterministic (the product's thesis). A thin multi-provider router over the
// OpenAI-compatible /chat/completions API, which DeepSeek and OpenAI both speak.
// Keys are resolved env-first (per the project's SQLite-plaintext / no-keychain
// model, a stored key can be passed in explicitly by the caller).

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIProviderConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string | undefined;
  keyEnv: string;
}

const PROVIDERS: Record<string, { baseUrl: string; model: string; keyEnv: string }> = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", keyEnv: "DEEPSEEK_API_KEY" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", keyEnv: "OPENAI_API_KEY" },
};

// Resolve which provider/model/key to use: explicit opts → PENGUIN_AI_PROVIDER →
// deepseek. apiKey: explicit (e.g. a key stored in SQLite) → the provider's env var.
export function resolveProvider(opts: {
  provider?: string;
  model?: string;
  apiKey?: string;
} = {}): AIProviderConfig {
  const name = (opts.provider ?? process.env.PENGUIN_AI_PROVIDER ?? "deepseek").toLowerCase();
  const p = PROVIDERS[name] ?? PROVIDERS.deepseek;
  return {
    provider: PROVIDERS[name] ? name : "deepseek",
    model: opts.model ?? process.env.PENGUIN_AI_MODEL ?? p.model,
    baseUrl: p.baseUrl,
    apiKey: opts.apiKey || process.env[p.keyEnv],
    keyEnv: p.keyEnv,
  };
}

// Send a chat completion. Throws a clear, actionable error when no key is set
// (BYOK) or the provider rejects the call. Uses global fetch (Node 18+).
export async function aiComplete(cfg: AIProviderConfig, messages: AIMessage[]): Promise<string> {
  if (!cfg.apiKey) {
    throw new Error(
      `no API key for provider "${cfg.provider}" — set ${cfg.keyEnv} (BYOK), or pass --provider/--key`,
    );
  }
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, stream: false }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${cfg.provider} ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "";
}
