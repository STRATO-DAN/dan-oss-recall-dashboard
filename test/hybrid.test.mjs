// Hybrid mode (BM25 + semantic RRF fusion) is otherwise untested in CI because it needs a real
// OPENAI_API_KEY. This exercises the exact code path — `embeddingsConfigured()` true, `embed()`
// actually called, `recall()` returning mode:"hybrid" with real RRF fusion — by swapping
// `global.fetch` for a deterministic fake OpenAI embeddings response. No real network call, no real
// key needed, but the real MemoryStore/embed()/RRF code all run for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory.js";

// Deterministic fake "embeddings": each text is bucketed by a SYNONYM SET, not the literal query
// word — so a memory can be a genuine vector-only match for a query that shares zero tokens with it
// (the real test of RRF's semantic side), while a shared-literal-word case is also possible (the
// real test of "found by both"). Real cosine math over fabricated, but honestly independent, inputs.
const DIM = 16;
const BUCKETS = [
  { dim: 0, words: ["ocean", "sea", "nautical", "tide", "wave"] },
  { dim: 1, words: ["mountain", "summit", "peak", "alpine"] },
  { dim: 2, words: ["kitchen", "cooking", "stove", "recipe"] },
];
function fakeVectorFor(text) {
  const v = new Array(DIM).fill(0);
  const lower = text.toLowerCase();
  let matched = false;
  for (const b of BUCKETS) {
    if (b.words.some((w) => lower.includes(w))) { v[b.dim] = 1; matched = true; }
  }
  if (!matched) v[DIM - 1] = 1; // a neutral bucket so every text still has *some* vector
  return v;
}

function withFakeEmbeddings(fn) {
  const prevKey = process.env.OPENAI_API_KEY;
  const prevFetch = global.fetch;
  process.env.OPENAI_API_KEY = "sk-fake-test-key";
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ data: [{ embedding: fakeVectorFor(body.input) }] }) };
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    });
}

async function withStore(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-hybrid-"));
  const store = new MemoryStore(dataDir);
  await store.init();
  try { await fn(store); } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
}

test("HYBRID: with embeddings configured, remember() stores a real vector and recall() reports mode:hybrid", () =>
  withFakeEmbeddings(() =>
    withStore(async (store) => {
      const m = await store.remember("a trip to the ocean");
      assert.equal(m.hasVector, true, "a real embedding was computed and stored for this memory");
      assert.equal(m.vector, undefined, "the public shape never exposes the raw vector");
      const result = await store.recall("ocean");
      assert.equal(result.mode, "hybrid", "with OPENAI_API_KEY set and at least one vectorized memory, mode must be hybrid, not bm25");
      assert.ok(result.results.some((r) => r.id === m.id));
    })));

test("HYBRID: RRF scores a memory found by BOTH BM25 and the vector search STRICTLY ABOVE one found by neither", () =>
  withFakeEmbeddings(() =>
    withStore(async (store) => {
      // Note on this implementation: cosineRank has no similarity floor — it rank-orders every
      // vectorized memory, so with a default minScore:0 every memory appears in the fused candidate
      // set (a "found by neither" memory just scores lower, it isn't dropped outright). The real,
      // meaningful property to assert is the RANK ORDER, and that a tighter k/minScore excludes it.
      const both = await store.remember("a beautiful ocean sunset over the water"); // shares "ocean" (BM25) + ocean bucket (vector)
      const neither = await store.remember("a quiet kitchen at midnight"); // shares no token; different vector bucket
      const result = await store.recall("ocean", 10);
      assert.equal(result.mode, "hybrid");
      const bothResult = result.results.find((r) => r.id === both.id);
      const neitherResult = result.results.find((r) => r.id === neither.id);
      assert.ok(bothResult && neitherResult, "both memories are candidates in the fused set");
      assert.ok(bothResult.score > neitherResult.score, "double-matched must rank strictly above the memory that matched neither ranking");
      assert.ok(bothResult.bm25Score > 0 && bothResult.vectorDistance !== null, "the fused result carries a real BM25 score and a real vector distance");
      assert.equal(neitherResult.bm25Score, 0, "the neither-matched memory's BM25 contribution is genuinely zero");

      // With k=1, only the strictly-higher-ranked "both" memory survives the cut.
      const top1 = await store.recall("ocean", 1);
      assert.deepEqual(top1.results.map((r) => r.id), [both.id]);
    })));

test("HYBRID: a memory with zero shared tokens with the query still surfaces via vector-only RRF", () =>
  withFakeEmbeddings(() =>
    withStore(async (store) => {
      // "tide" triggers the ocean bucket but shares no literal token with the query's "nautical".
      const vectorOnly = await store.remember("the tide pulled the little boat out to open water");
      const result = await store.recall("a nautical adventure story", 10);
      assert.equal(result.mode, "hybrid");
      const hit = result.results.find((r) => r.id === vectorOnly.id);
      assert.ok(hit, "a memory with no shared tokens still ranks via the vector side of RRF");
      assert.equal(hit.bm25Score, 0, "confirms this hit came from the vector side, not BM25 (zero lexical overlap)");
    })));

test("R4: a principal's own memory is not crowded out of the vector candidate window by another principal's closer vectors", () => {
  const prevKey = process.env.OPENAI_API_KEY;
  const prevFetch = global.fetch;
  process.env.OPENAI_API_KEY = "sk-fake-r4";
  // The query and every VICTIM doc embed to the same unit vector (cosine 1); the attacker's OWN doc embeds to a
  // slightly-off vector (cosine 0.9). Globally the 25 victim vectors fill the entire k*3 candidate window ahead
  // of the attacker's single doc, so pre-fix the attacker's own doc never reaches the vector side of RRF. With
  // per-principal candidate selection it is ranked within the attacker's OWN set and keeps its vector hit.
  global.fetch = async (url, opts) => {
    const input = JSON.parse(opts.body).input.toLowerCase();
    const v = input.includes("attacker-doc") ? [0.9, Math.sqrt(1 - 0.81)] : [1, 0];
    return { ok: true, status: 200, json: async () => ({ data: [{ embedding: v }] }) };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-r4-"));
  const store = new MemoryStore(dir);
  return store.init()
    .then(async () => {
      await store.remember("attacker-doc shared-term note", {}, { principal: "attacker" });
      for (let i = 0; i < 25; i++) {
        await store.remember(`victim ${i} shared-term filler`, {}, { principal: "victim" });
      }
      const res = await store.recall("shared-term query", 5, { principal: "attacker" });
      assert.equal(res.mode, "hybrid");
      const own = res.results.find((r) => /attacker-doc/.test(r.text));
      assert.ok(own, "the attacker recalls its own memory");
      assert.ok(own.vectorDistance !== null,
        "its own memory was found by the VECTOR side too — not crowded out of the candidate window by another principal's closer vectors");
      assert.ok(res.results.every((r) => !/victim/.test(r.text)), "content read-isolation is intact");
    })
    .finally(() => {
      global.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
      fs.rmSync(dir, { recursive: true, force: true });
    });
});

test("R7: embedding EGRESS is actually audited (action:embedding, principal, bytes) on BOTH remember and recall", () =>
  withFakeEmbeddings(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-r7-"));
    const events = [];
    const store = new MemoryStore(dir, { audit: (e) => events.push(e) });
    await store.init();
    try {
      await store.remember("a trip to the ocean", {}, { principal: "agent-x" });
      const onRemember = events.find((e) => e.action === "embedding");
      assert.ok(onRemember, "remember() records a real embedding-egress event (the audit claim is now true)");
      assert.equal(onRemember.principal, "agent-x");
      assert.ok(onRemember.bytes > 0, "the egress event records the byte count that left the process boundary");
      events.length = 0;
      await store.recall("ocean", 5, { principal: "agent-x" });
      const onRecall = events.find((e) => e.action === "embedding");
      assert.ok(onRecall, "recall() records an embedding-egress event too — embed() runs on recall as well");
      assert.equal(onRecall.principal, "agent-x");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));

test("HYBRID: without OPENAI_API_KEY, the exact same store stays BM25-only (no silent hybrid claim)", () =>
  withStore(async (store) => {
    await store.remember("a trip to the ocean");
    const result = await store.recall("ocean");
    assert.equal(result.mode, "bm25", "mode must never claim hybrid when no embeddings were actually computed");
  }));
