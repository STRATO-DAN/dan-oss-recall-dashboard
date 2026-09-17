// Real embeddings, one real provider — OpenAI is the only one with a public embeddings API
// (Anthropic does not ship one as of this writing). Stated plainly rather than pretending this
// tool is provider-agnostic for embeddings the way DAN-OSS-COMMIT's own LLM call is.
//
// Honest failure: no key configured means real vector recall is unavailable — Recall degrades to
// a real keyword search instead (see memory.js), never a fabricated "semantic" result.
const MODEL = process.env.DAN_OSS_RECALL_DASHBOARD_EMBED_MODEL || "text-embedding-3-small";

export function embeddingsConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export async function embed(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("No OPENAI_API_KEY set — real vector embeddings need OpenAI's embeddings API.");
  }
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: MODEL, input: text }),
  });
  if (!res.ok) {
    // R10 — do NOT put the provider's raw response body into the thrown error: it can echo request content or
    // upstream internals and would otherwise be reflected out through the API. Log it locally for the operator
    // (loopback-only), surface only the status to any caller.
    const detail = await res.text().catch(() => "");
    if (detail) console.error(`[DAN] RECALL DASHBOARD: OpenAI embeddings API error ${res.status}: ${detail.slice(0, 500)}`);
    throw new Error(`OpenAI embeddings API error ${res.status}`);
  }
  const data = await res.json();
  const vector = data.data?.[0]?.embedding;
  if (!Array.isArray(vector)) {
    throw new Error("OpenAI returned no real embedding vector.");
  }
  return vector;
}
