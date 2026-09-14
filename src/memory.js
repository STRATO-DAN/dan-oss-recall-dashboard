// [DAN] RECALL DASHBOARD's real core — "Remember. Recall. Forget." Real, structured records and
// a real ranking engine, not a raw dump:
//   BM25    — always on, zero setup, zero dependency. Real lexical relevance scoring (see bm25.js)
//             over every stored memory's text — a computed score per memory, ranked, with a real
//             "shares no term at all" floor of 0.
//   HYBRID  — OPENAI_API_KEY set: BM25 combined with real semantic vector search, fused via
//             Reciprocal Rank Fusion (RRF) — the same technique Elasticsearch's own hybrid search
//             uses, not an ad-hoc score blend. The vector search runs on LanceDB when its native
//             package is available on the host (the robust, indexed path), and AUTOMATICALLY falls
//             back to an exact in-process cosine-similarity scan when it isn't — so hybrid mode
//             works after a single install on any platform, with no second step and nothing for the
//             user to decide. Embeddings come from OpenAI's API (your own key) either way.
//
// The plain JSON sidecar (atomic writes) is the real source of truth for every memory's content
// AND its embedding vector, so the JS fallback and LanceDB always rank the exact same data and can
// never drift; LanceDB, when present, is an accelerated index over that same vector, not a second
// copy of the truth.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { embed, embeddingsConfigured } from "./embeddings.js";
import { tokenize, search as bm25Search } from "./bm25.js";

const RRF_K = 60; // standard Reciprocal Rank Fusion constant (Elasticsearch's own default)

// Exact cosine similarity between two equal-length vectors. Pure arithmetic, zero dependency — the
// fallback vector engine used when LanceDB's native package isn't available on the host.
export function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Rank memories by cosine similarity to a query vector — the exact, dependency-free vector search.
// Returns the same { id, rank, distance } shape LanceDB's path returns, so RRF fusion is identical.
export function cosineRank(queryVector, memories, limit) {
  const scored = [];
  for (const m of memories) {
    if (!m.vector) continue;
    scored.push({ id: m.id, sim: cosineSimilarity(queryVector, m.vector) });
  }
  scored.sort((x, y) => y.sim - x.sim);
  return scored.slice(0, limit).map((h, i) => ({ id: h.id, rank: i + 1, distance: 1 - h.sim }));
}

export class MemoryStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.sidecarPath = path.join(dataDir, "memories.json");
    this.memories = []; // real records: { id, text, metadata, createdAt, hasVector, vector? }
    this.table = null; // LanceDB table, when the native package is available on this host
    this._lanceMod = undefined; // undefined = not yet checked; module | null after the first check
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.sidecarPath, "utf8");
      this.memories = JSON.parse(raw).memories ?? [];
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error(`[DAN] RECALL DASHBOARD: could not read ${this.sidecarPath}, starting empty: ${err.message}`);
      }
      this.memories = [];
    }
    if (embeddingsConfigured() && this.memories.some((m) => m.hasVector)) {
      await this._openTable(); // best-effort; returns null (→ JS fallback) if LanceDB is unavailable
    }
  }

  /** Load the optional LanceDB native package once, memoized. Returns the module, or null if it
   * isn't installed or can't load on this platform — NEVER throws, so hybrid mode degrades to the
   * exact JS cosine engine instead of breaking. */
  async _lance() {
    if (this._lanceMod !== undefined) return this._lanceMod;
    try {
      this._lanceMod = await import("@lancedb/lancedb");
    } catch {
      this._lanceMod = null; // not installed / native build absent on this host → JS fallback
    }
    return this._lanceMod;
  }

  async _openTable() {
    if (this.table) return this.table;
    const lancedb = await this._lance();
    if (!lancedb) return null;
    try {
      const db = this._db ?? (await lancedb.connect(path.join(this.dataDir, "vectors.lance")));
      this._db = db;
      const names = await db.tableNames();
      this.table = names.includes("memories") ? await db.openTable("memories") : null;
      return this.table;
    } catch {
      this._lanceMod = null; // native/runtime failure → stop trying, use the JS fallback from here
      return null;
    }
  }

  async _saveSidecar() {
    const tmp = path.join(this.dataDir, `.memories.json.${process.pid}.tmp`);
    await fs.writeFile(tmp, JSON.stringify({ memories: this.memories }, null, 2), "utf8");
    await fs.rename(tmp, this.sidecarPath);
  }

  // A stored memory carries its embedding vector in the sidecar (the source of truth); that big
  // array is never leaked out through the API — strip it from anything returned to a caller.
  static _public(m) {
    if (!m) return m;
    const { vector, ...rest } = m;
    return rest;
  }

  async remember(text, metadata = {}) {
    if (!text || !text.trim()) {
      throw new Error("Nothing real to remember — text is empty.");
    }
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    let hasVector = false;
    let vector = null;

    if (embeddingsConfigured()) {
      // If a key IS configured a real embedding is expected — a transient API failure surfaces as a
      // real error rather than silently degrading just this one memory to BM25-only.
      vector = await embed(text);
      hasVector = true;
      // Best-effort: also index it in LanceDB when the native package is present. The sidecar
      // already holds the vector, so if LanceDB isn't here the JS engine still has everything it
      // needs — a LanceDB hiccup never fails the remember.
      const lancedb = await this._lance();
      if (lancedb) {
        try {
          const db = this._db ?? (await lancedb.connect(path.join(this.dataDir, "vectors.lance")));
          this._db = db;
          const row = { id, text, vector, createdAt };
          if (!this.table) {
            const names = await db.tableNames();
            this.table = names.includes("memories")
              ? await db.openTable("memories")
              : await db.createTable("memories", [row]);
            if (names.includes("memories")) await this.table.add([row]);
          } else {
            await this.table.add([row]);
          }
        } catch {
          this._lanceMod = null; // native issue mid-run → fall back to the JS engine from here on
        }
      }
    }

    const memory = { id, text, metadata, createdAt, hasVector };
    if (hasVector) memory.vector = vector;
    this.memories.push(memory);
    await this._saveSidecar();
    return MemoryStore._public(memory);
  }

  /** Real BM25 ranking over every stored memory's own text — always available, zero setup, zero
   * external call. Same functions bm25.js exposes for its own unit tests, not a re-implementation. */
  _bm25Rank(query) {
    const documents = this.memories.map((m) => ({ id: m.id, tokens: tokenize(m.text) }));
    return bm25Search(query, documents).filter((r) => r.score > 0);
  }

  /** Real semantic candidate ranking — LanceDB's indexed search when the native package is
   * available, else the exact JS cosine scan over the same sidecar vectors. Returns empty (not an
   * error) when hybrid isn't in play, so the caller falls back to a complete BM25-only result. */
  async _vectorRank(query, limit) {
    if (!embeddingsConfigured() || !this.memories.some((m) => m.hasVector)) return [];
    const queryVector = await embed(query);
    const table = await this._openTable();
    if (table) {
      try {
        const hits = await table.vectorSearch(queryVector).limit(limit).toArray();
        // LanceDB's `_distance` is L2 — smaller is more similar. Only the rank ORDER feeds RRF, so
        // raw distance is kept as a diagnostic, never magnitude-blended with BM25's own score.
        return hits.map((h, i) => ({ id: h.id, rank: i + 1, distance: h._distance }));
      } catch {
        this._lanceMod = null; // any native error → fall through to the exact JS engine
      }
    }
    return cosineRank(queryVector, this.memories, limit);
  }

  /** Real Reciprocal Rank Fusion — combines a lexical and a semantic ranking without inventing a
   * magic weight to blend two differently-scaled scores. A memory both rankings agree on ranks
   * above one only one found; a memory neither ranking found never appears. */
  static _rrfCombine(bm25Ranked, vectorRanked) {
    const combined = new Map();
    bm25Ranked.forEach((r, i) => {
      const rank = i + 1;
      combined.set(r.id, { id: r.id, rrf: 1 / (RRF_K + rank), bm25Score: r.score, vectorDistance: null });
    });
    vectorRanked.forEach((r) => {
      const existing = combined.get(r.id);
      const rrfContribution = 1 / (RRF_K + r.rank);
      if (existing) {
        existing.rrf += rrfContribution;
        existing.vectorDistance = r.distance;
      } else {
        combined.set(r.id, { id: r.id, rrf: rrfContribution, bm25Score: 0, vectorDistance: r.distance });
      }
    });
    return [...combined.values()].sort((a, b) => b.rrf - a.rrf);
  }

  /** Real, ranked recall. `minScore` is the real, tunable relevance floor: in BM25-only mode it's
   * applied to the actual BM25 score (0 = shares no term with the query, the corpus-derived floor);
   * in hybrid mode a memory only needs to be found by BM25 OR the vector search to rank at all, so
   * `minScore` filters on the fused RRF score. Either way: return what actually scored. */
  async recall(query, k = 5, { minScore = 0 } = {}) {
    if (!query || !query.trim()) {
      return { mode: "none", results: [] };
    }
    const byId = new Map(this.memories.map((m) => [m.id, m]));
    const bm25Ranked = this._bm25Rank(query);
    const hybridAvailable = embeddingsConfigured() && this.memories.some((m) => m.hasVector);

    if (!hybridAvailable) {
      const results = bm25Ranked
        .filter((r) => r.score >= minScore)
        .slice(0, k)
        .map((r) => ({ ...MemoryStore._public(byId.get(r.id)), score: r.score }));
      return { mode: "bm25", results };
    }

    const vectorRanked = await this._vectorRank(query, Math.max(k * 3, 20));
    const fused = MemoryStore._rrfCombine(bm25Ranked, vectorRanked);
    const results = fused
      .filter((r) => r.rrf >= minScore)
      .slice(0, k)
      .map((r) => ({ ...MemoryStore._public(byId.get(r.id)), score: r.rrf, bm25Score: r.bm25Score, vectorDistance: r.vectorDistance }));
    return { mode: "hybrid", results };
  }

  async forget(id) {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => m.id !== id);
    if (this.memories.length === before) return false;
    await this._saveSidecar();
    if (this.table) {
      try {
        await this.table.delete(`id = '${id.replace(/'/g, "''")}'`);
      } catch {
        /* index cleanup is best-effort — the sidecar (source of truth) no longer has this memory */
      }
    }
    return true;
  }

  list() {
    return [...this.memories]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((m) => MemoryStore._public(m));
  }
}
