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
    throw new Error(`OpenAI embeddings API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const vector = data.data?.[0]?.embedding;
  if (!Array.isArray(vector)) {
    throw new Error("OpenAI returned no real embedding vector.");
  }
  return vector;
}
