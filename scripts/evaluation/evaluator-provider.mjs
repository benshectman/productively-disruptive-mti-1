const OPENAI = {
  id: "openai",
  apiKeyEnv: "OPENAI_API_KEY",
  url: "https://api.openai.com/v1/responses"
};

const OPENROUTER = {
  id: "openrouter",
  apiKeyEnv: "OPENROUTER_API_KEY",
  url: "https://openrouter.ai/api/v1/chat/completions"
};

const PROVIDERS = new Map([[OPENAI.id, OPENAI], [OPENROUTER.id, OPENROUTER]]);

export function resolveEvaluatorProvider(value = "openai") {
  const id = String(value || "openai").trim().toLowerCase();
  const provider = PROVIDERS.get(id);
  if (!provider) throw new Error(`Unsupported evaluator provider: ${value}`);
  return provider;
}

export function resolveEvaluatorRuntime({
  config = {},
  environment = process.env,
  provider: providerOverride,
  model: modelOverride
} = {}) {
  const providerEnv = config.providerEnv || "EVAL_PROVIDER";
  const provider = resolveEvaluatorProvider(providerOverride || environment[providerEnv] || config.defaultProvider || "openai");
  const apiKeyEnv = config.apiKeyEnvByProvider?.[provider.id]
    || (provider.id === "openai" ? config.apiKeyEnv : null)
    || provider.apiKeyEnv;
  const apiKey = environment[apiKeyEnv];
  const model = modelOverride || environment[config.modelEnv || "EVAL_MODEL"] || config.defaultModel;
  if (!apiKey) throw new Error(`Set ${apiKeyEnv}`);
  if (!model) throw new Error("Set an evaluator model");
  return { provider: provider.id, apiKeyEnv, apiKey, model };
}

function openRouterBody(body) {
  const schema = body.text?.format?.schema;
  const schemaInstruction = schema
    ? ` Return only one strict JSON object matching this JSON Schema exactly. Do not use Markdown fences or add commentary. JSON Schema: ${JSON.stringify(schema)}`
    : "";
  return {
    model: body.model,
    messages: [
      { role: "system", content: `${body.instructions || ""}${schemaInstruction}`.trim() },
      { role: "user", content: body.input || "" }
    ],
    max_tokens: body.max_output_tokens
  };
}

export function buildProviderRequest({ provider: providerValue = "openai", apiKey, body, signal }) {
  const provider = resolveEvaluatorProvider(providerValue);
  return {
    url: provider.url,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(provider.id === "openrouter" ? openRouterBody(body) : body),
      signal
    }
  };
}

export function providerResponseText(result, providerValue = "openai") {
  const provider = resolveEvaluatorProvider(providerValue);
  if (provider.id === "openrouter") return result.choices?.[0]?.message?.content?.trim() || "";
  return result.output_text || result.output?.flatMap((item) => item.content || []).map((item) => item.text || "").join("").trim() || "";
}

export function parseEvaluatorJson(text) {
  const trimmed = String(text || "").trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(unfenced);
  } catch (initialError) {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw initialError;
  }
}

export function normalizeProviderUsage(usage, providerValue = "openai") {
  if (!usage) return null;
  const provider = resolveEvaluatorProvider(providerValue);
  if (provider.id === "openrouter") {
    return {
      ...usage,
      input_tokens: Number(usage.prompt_tokens || 0),
      output_tokens: Number(usage.completion_tokens || 0),
      total_tokens: Number(usage.total_tokens || 0)
    };
  }
  return usage;
}
