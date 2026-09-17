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

// Thrown when a write would exceed a configured bound — the server maps it to HTTP 413 so an
// unauthorized (or runaway) caller cannot grow the store, or amplify embedding cost, without limit.
export class QuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuotaError";
  }
}

// Thrown when a principal tries to delete a memory it does not own — the server maps it to HTTP 403.
export class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.name = "ForbiddenError";
  }
}

// The full stored footprint of a memory (v0.3) — NOT just its text. Counts the caller-controllable text +
// metadata + provenance, plus the embedding vector (the largest per-memory cost in hybrid mode). This is what
// the storage quota accounts against, so metadata bloat or the vector overhead can no longer slip past it.
function memoryBytes({ text = "", metadata = {}, provenance = {}, vector = null }) {
  let n = Buffer.byteLength(text, "utf8");
  try {
    n += Buffer.byteLength(JSON.stringify(metadata) || "", "utf8");
    n += Buffer.byteLength(JSON.stringify(provenance) || "", "utf8");
  } catch {
    /* non-serializable metadata is rejected elsewhere; count conservatively */
  }
  if (Array.isArray(vector)) n += vector.length * 8; // float64 per dimension
  return n;
}

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
  constructor(dataDir, opts = {}) {
    this.dataDir = dataDir;
    this.sidecarPath = path.join(dataDir, "memories.json");
    this.lockPath = path.join(dataDir, ".memories.lock"); // v0.5 — cross-process save lock
    this.memories = []; // real records: { id, text, metadata, provenance, createdAt, hasVector, vector? }
    this.table = null; // LanceDB table, when the native package is available on this host
    this._lanceMod = undefined; // undefined = not yet checked; module | null after the first check
    this._tombstones = new Set(); // ids this instance has forgotten — never resurrected by a merge (v0.5)
    // Quotas — bound storage growth and embedding amplification. v0.5: accounted PER PRINCIPAL, not globally,
    // so one principal can neither starve the others nor probe a shared global fill level. The historical
    // option/env names are honoured as the per-principal budget (each principal gets up to this much); the new
    // RECALL_MAX_*_PER_PRINCIPAL names are preferred and take precedence.
    this.maxCountPerPrincipal =
      opts.maxCountPerPrincipal ?? opts.maxCount ??
      (Number(process.env.RECALL_MAX_MEMORIES_PER_PRINCIPAL) || Number(process.env.RECALL_MAX_MEMORIES) || 100000);
    this.maxBytesPerPrincipal =
      opts.maxBytesPerPrincipal ?? opts.maxTotalBytes ??
      (Number(process.env.RECALL_MAX_BYTES_PER_PRINCIPAL) || Number(process.env.RECALL_MAX_TOTAL_BYTES) || 512 * 1024 * 1024);
    this.usage = new Map(); // principal → { count, bytes }; the per-principal accounting, recomputed on every save
    this.totalBytes = 0; // running sum of ALL stored footprints (diagnostic; enforcement is per-principal)
    // v0.7 — an optional audit sink (server passes makeAudit()). Used to record embedding EGRESS events so the
    // audit trail's own "embedding calls" claim is actually true; defaults to a no-op for library/test callers.
    this._audit = typeof opts.audit === "function" ? opts.audit : () => {};
    // v0.4 — per-principal READ isolation. By DEFAULT a principal's reads/searches see only the memories
    // it created (its verified provenance.principal). An operator who genuinely wants one shared team
    // corpus opts in explicitly via RECALL_SHARED_MEMORY. Authentication already told the server WHICH
    // principal is asking (v0.3); this makes authorization follow identity on reads too, so one shared
    // instance no longer hands every principal every other principal's memories.
    this.sharedMemory = opts.sharedMemory ?? /^(1|true|yes|on)$/i.test(process.env.RECALL_SHARED_MEMORY || "");
  }

  /** Recompute the per-principal usage table (and the diagnostic global total) from the current memories.
   *  Called after every durable save so accounting can never drift from what is actually on disk. */
  _recomputeUsage() {
    this.usage = new Map();
    this.totalBytes = 0;
    for (const m of this.memories) {
      const b = m._bytes ?? memoryBytes(m);
      this.totalBytes += b;
      const p = m.provenance?.principal || "unknown";
      const u = this.usage.get(p) || { count: 0, bytes: 0 };
      u.count += 1;
      u.bytes += b;
      this.usage.set(p, u);
    }
  }

  _usageFor(principal) {
    return this.usage.get(principal) || { count: 0, bytes: 0 };
  }

  /** Can `principal` read `memory`? Shared-memory mode → everyone; an admin (the instance operator) →
   *  everyone, matching forget()'s existing isAdmin bypass; otherwise only the creating principal.
   *  `principal == null` is a trusted in-process/library caller (no HTTP identity) and sees everything —
   *  the server ALWAYS passes the authenticated principal, so a non-admin API caller is always scoped. */
  _canRead(memory, principal, isAdmin = false) {
    if (this.sharedMemory || isAdmin || principal == null) return true;
    return memory?.provenance?.principal === principal;
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
    this._recomputeUsage();
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

  /** Acquire an advisory CROSS-PROCESS lock on the data dir via an O_EXCL lock file (the portable,
   *  zero-dependency cross-process mutex on a shared filesystem). Spins with jittered backoff and breaks
   *  a stale lock left by a crashed writer, so a dead process can never wedge the store forever. */
  async _acquireLock() {
    const STALE_MS = 10_000;
    const TIMEOUT_MS = 15_000;
    const start = Date.now();
    for (;;) {
      try {
        const fh = await fs.open(this.lockPath, "wx");
        try { await fh.writeFile(`${process.pid} ${new Date().toISOString()}`); } catch { /* advisory only */ }
        return fh;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        try {
          const st = await fs.stat(this.lockPath);
          if (Date.now() - st.mtimeMs > STALE_MS) { await fs.rm(this.lockPath, { force: true }); continue; }
        } catch { continue; /* lock vanished under us — retry immediately */ }
        if (Date.now() - start > TIMEOUT_MS) throw new Error("timed out acquiring the sidecar lock");
        await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 10)));
      }
    }
  }

  async _releaseLock(fh) {
    if (!fh) return;
    try { await fh.close(); } catch { /* already closed */ }
    try { await fs.rm(this.lockPath, { force: true }); } catch { /* already gone */ }
  }

  /** fsync a directory entry so a rename into it actually survives a crash. Not supported on every
   *  platform (Windows), so it is strictly best-effort — the file fsync above is the load-bearing part. */
  async _fsyncDir(dir) {
    let dh;
    try { dh = await fs.open(dir, "r"); await dh.sync(); }
    catch { /* directory fsync unsupported here */ }
    finally { try { await dh?.close(); } catch { /* ignore */ } }
  }

  async _saveSidecar() {
    // Serialize saves WITHIN this process (each waits for the previous), then persist UNDER a cross-process
    // lock. Intra-process ordering alone is not enough: two PROCESSES on one dataDir each hold their own
    // stale snapshot and the rename that lands last wins the file — a real lost update. So each save now does
    // a read-modify-write while holding the lock: it re-reads the on-disk set and MERGES it with this
    // instance's memories (minus anything this instance has forgotten), so a concurrent process's freshly
    // written memory is preserved instead of clobbered. Durability, not just atomicity: the temp file is
    // fsync'd before the rename and the directory is fsync'd after it.
    const prev = this._saveChain || Promise.resolve();
    const mine = prev.catch(() => {}).then(() => this._persist());
    this._saveChain = mine;
    return mine;
  }

  async _persist() {
    const lock = await this._acquireLock();
    try {
      let onDisk = [];
      try {
        onDisk = JSON.parse(await fs.readFile(this.sidecarPath, "utf8")).memories ?? [];
      } catch (err) {
        if (err.code !== "ENOENT") throw err; // a real read error must not silently drop the other writer's data
      }
      // Merge: start from what is durably on disk (another process may have added rows we have never seen),
      // drop anything THIS instance has forgotten, then overlay our own memories (adds win over a stale disk copy).
      const merged = new Map();
      for (const m of onDisk) if (!this._tombstones.has(m.id)) merged.set(m.id, m);
      for (const m of this.memories) if (!this._tombstones.has(m.id)) merged.set(m.id, m);
      const list = [...merged.values()];

      const tmp = path.join(this.dataDir, `.memories.json.${process.pid}.${crypto.randomUUID()}.tmp`);
      const fh = await fs.open(tmp, "w");
      try {
        await fh.writeFile(JSON.stringify({ memories: list }, null, 2), "utf8");
        await fh.sync(); // flush file contents to disk BEFORE the rename — the "crash-safe" claim made real
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, this.sidecarPath);
      await this._fsyncDir(this.dataDir); // flush the rename itself

      // Adopt the merged, durable truth so RAM never diverges from disk.
      this.memories = list;
      this._recomputeUsage();
    } finally {
      await this._releaseLock(lock);
    }
  }

  // A stored memory carries its embedding vector in the sidecar (the source of truth); that big
  // array is never leaked out through the API — strip it from anything returned to a caller.
  static _public(m) {
    if (!m) return m;
    const { vector, _bytes, ...rest } = m;
    return rest;
  }

  async remember(text, metadata = {}, provenance = {}) {
    if (!text || !text.trim()) {
      throw new Error("Nothing real to remember — text is empty.");
    }
    // Quota (v0.5) — account for the FULL footprint (text + metadata + provenance + the vector estimate when
    // embeddings are on), not just text, and reject BEFORE any external embedding call so a runaway/unauthorized
    // caller can neither grow the store (via text OR metadata) nor amplify OpenAI cost past the configured bound.
    // The accounting is PER PRINCIPAL: the check reflects only the CALLING principal's own usage, so one
    // principal can neither exhaust another's budget (starvation) nor learn a global fill level (probe oracle).
    const principalId = String(provenance.principal || "unknown").slice(0, 120);
    const VECTOR_BYTES_ESTIMATE = embeddingsConfigured() ? 1536 * 8 : 0; // typical embedding dim; refined post-embed
    const estBytes =
      memoryBytes({ text, metadata, provenance: { principal: provenance.principal, source: provenance.source } }) +
      VECTOR_BYTES_ESTIMATE;
    const usage = this._usageFor(principalId);
    if (usage.count >= this.maxCountPerPrincipal) {
      throw new QuotaError(`per-principal memory count limit reached (${this.maxCountPerPrincipal}) — nothing stored`);
    }
    if (usage.bytes + estBytes > this.maxBytesPerPrincipal) {
      throw new QuotaError(`per-principal storage limit reached (${this.maxBytesPerPrincipal} bytes) — nothing stored`);
    }
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    let hasVector = false;
    let vector = null;

    if (embeddingsConfigured()) {
      // If a key IS configured a real embedding is expected — a transient API failure surfaces as a
      // real error rather than silently degrading just this one memory to BM25-only.
      // v0.7 — record the embedding EGRESS (text bytes leave the process boundary to OpenAI) so the audit
      // trail's "embedding calls" claim is actually true. Egress BEHAVIOUR is deliberately unchanged here.
      this._audit({ action: "embedding", principal: principalId, bytes: Buffer.byteLength(text, "utf8") });
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

    // Provenance (v0.3) — `principal` is the VERIFIED authenticated principal set by the server, NOT the
    // caller; it is the unforgeable owner of this memory and the answer to "who created it" before it re-enters
    // model context. `source` is a free label the caller may pass (recorded, untrusted). `metadata` stays
    // caller-controlled and untrusted.
    const memory = {
      id,
      text,
      metadata,
      provenance: {
        principal: String(provenance.principal || "unknown").slice(0, 120),
        source: String(provenance.source || "").slice(0, 200),
        at: createdAt,
      },
      createdAt,
      hasVector,
    };
    if (hasVector) memory.vector = vector;
    memory._bytes = memoryBytes(memory); // exact footprint, so forget() reclaims precisely what remember() added
    // R10 — the durable sidecar is the source of truth: only KEEP the memory in RAM if the save actually
    // succeeds. Push, save, and on any failure roll the RAM state back so it can never diverge from disk
    // (a persisted-nothing / remembered-in-RAM split). _saveSidecar recomputes usage from the merged truth.
    this.memories.push(memory);
    try {
      await this._saveSidecar();
    } catch (err) {
      this.memories = this.memories.filter((m) => m.id !== id);
      this._recomputeUsage();
      throw err;
    }
    return MemoryStore._public(memory);
  }

  /** Real BM25 ranking over the CALLER'S READABLE memories only. R3: BM25's corpus statistics (document
   * frequency, average length) are computed over exactly the documents passed in — so scoping the corpus to
   * the caller's own set means another principal storing a term can no longer shift the df/avgdl behind the
   * caller's own scores (a cross-principal term-presence oracle). Same functions bm25.js exposes for its own
   * unit tests, not a re-implementation. */
  _bm25Rank(query, memories = this.memories) {
    const documents = memories.map((m) => ({ id: m.id, tokens: tokenize(m.text) }));
    return bm25Search(query, documents).filter((r) => r.score > 0);
  }

  /** Real semantic candidate ranking — LanceDB's indexed search when the native package is available, else
   * the exact JS cosine scan. Returns empty (not an error) when hybrid isn't in play, so the caller falls back
   * to a complete BM25-only result. R4: it ranks over the CALLER'S READABLE set so the k*3 candidate window is
   * filled from the caller's own memories BEFORE the slice — another principal's (closer) vectors can no longer
   * crowd the caller's own memories out of recall. LanceDB's index carries no principal column, so its fast path
   * is used only for the full-corpus view (admin / shared / trusted in-process); a per-principal caller is ranked
   * with the exact in-process cosine scan over exactly its own readable vectors. */
  async _vectorRank(query, limit, memories = this.memories, useIndex = true, principal = null) {
    if (!embeddingsConfigured() || !memories.some((m) => m.hasVector)) return [];
    // v0.7 — record embedding EGRESS on the recall path too (embed() runs on remember AND recall).
    this._audit({ action: "embedding", principal: principal ?? "unknown", bytes: Buffer.byteLength(query, "utf8") });
    const queryVector = await embed(query);
    if (useIndex) {
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
    }
    return cosineRank(queryVector, memories, limit);
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
  async recall(query, k = 5, { minScore = 0, principal = null, isAdmin = false } = {}) {
    if (!query || !query.trim()) {
      return { mode: "none", results: [] };
    }
    const byId = new Map(this.memories.map((m) => [m.id, m]));
    // v0.4/v0.5 — per-principal read isolation, computed ONCE up front so both the lexical and the semantic
    // ranker score over exactly the caller's readable set (R3 corpus-stat oracle, R4 candidate crowd-out).
    const fullView = this.sharedMemory || isAdmin || principal == null;
    const readable = fullView ? this.memories : this.memories.filter((m) => this._canRead(m, principal, isAdmin));
    const bm25Ranked = this._bm25Rank(query, readable);
    const hybridAvailable = embeddingsConfigured() && readable.some((m) => m.hasVector);

    if (!hybridAvailable) {
      const results = bm25Ranked
        .filter((r) => r.score >= minScore)
        .filter((r) => byId.has(r.id)) // source-of-truth guard (defensive; readable ⊆ this.memories)
        .slice(0, k)
        .map((r) => ({ ...MemoryStore._public(byId.get(r.id)), score: r.score }));
      return { mode: "bm25", results };
    }

    const vectorRanked = await this._vectorRank(query, Math.max(k * 3, 20), readable, fullView, principal);
    const fused = MemoryStore._rrfCombine(bm25Ranked, vectorRanked);
    const results = fused
      .filter((r) => r.rrf >= minScore)
      // 🔴 v0.3 — the sidecar is the source of truth. Drop any id it no longer has (a stale LanceDB entry left
      // by a best-effort delete that failed) BEFORE mapping, so a diverged index can never surface a deleted
      // memory as a malformed, id-less result. (Read isolation is already applied via `readable` above.)
      .filter((r) => byId.has(r.id))
      .slice(0, k)
      .map((r) => ({ ...MemoryStore._public(byId.get(r.id)), score: r.rrf, bm25Score: r.bm25Score, vectorDistance: r.vectorDistance }));
    return { mode: "hybrid", results };
  }

  async forget(id, { principal, isAdmin = false } = {}) {
    const removed = this.memories.find((m) => m.id === id);
    if (!removed) return false;
    // Owner-scoped delete (v0.3): only the principal that created the memory — or an admin — may forget it.
    // R9 (DOC): a non-owner still gets 403 here rather than 404. Unifying to 404 would remove a theoretical
    // existence oracle, but it would also erase the owner-scoped contract's `forget-denied` audit signal, and
    // the oracle is unreachable in practice — memory ids are unguessable UUIDv4 and are never exposed across
    // principals by read isolation, so a caller cannot obtain another principal's id to probe with. Kept 403.
    if (principal !== undefined && !isAdmin && removed.provenance?.principal !== principal) {
      throw new ForbiddenError("this memory belongs to another principal — only its owner or an admin may forget it");
    }
    // R10 — mutate RAM optimistically, then roll back if the durable save fails, so a failed delete can never
    // leave RAM missing a memory the sidecar still holds. The tombstone makes the removal win any concurrent
    // merge (so a stale on-disk copy from another writer cannot resurrect it). _saveSidecar recomputes usage.
    const prevMemories = this.memories;
    this._tombstones.add(id);
    this.memories = this.memories.filter((m) => m.id !== id);
    try {
      await this._saveSidecar();
    } catch (err) {
      this._tombstones.delete(id);
      this.memories = prevMemories;
      this._recomputeUsage();
      throw err;
    }
    if (this.table) {
      try {
        await this.table.delete(`id = '${id.replace(/'/g, "''")}'`);
      } catch {
        /* index cleanup is best-effort — the sidecar (source of truth) no longer has this memory */
      }
    }
    return true;
  }

  list({ principal = null, isAdmin = false } = {}) {
    return this.memories
      // v0.4 — per-principal read isolation: list only the caller's own memories unless shared mode.
      .filter((m) => this._canRead(m, principal, isAdmin))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((m) => MemoryStore._public(m));
  }
}
