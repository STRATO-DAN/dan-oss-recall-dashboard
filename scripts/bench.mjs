// [DAN] RECALL DASHBOARD — BM25 recall latency vs corpus size.
//
// Calls the real ranking engine (src/bm25.js) directly — no server, no network, no dependency — and
// measures query latency at 100 / 1k / 10k synthetic memories. Timing is stdlib only
// (perf_hooks.performance.now()). Reproduce with `make bench`.
import { performance } from "node:perf_hooks";
import { tokenize, search as bm25Search } from "../src/bm25.js";

// Small deterministic PRNG (mulberry32) so the synthetic corpus — and therefore the numbers — are
// reproducible run to run. No dependency, no Math.random() drift.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = (
  "deploy key rotation policy service latency cache database migration index vector embedding token " +
  "principal audit secret gate recall memory ranking score corpus query cluster backup restore " +
  "schema pipeline release build test coverage metric alert dashboard incident rollback config " +
  "network socket buffer stream handler request response header cookie session timeout retry queue"
).split(/\s+/);

function makeCorpus(n, rng) {
  const docs = [];
  for (let i = 0; i < n; i++) {
    const len = 12 + Math.floor(rng() * 24); // 12–35 words per memory
    const words = [];
    for (let w = 0; w < len; w++) words.push(VOCAB[Math.floor(rng() * VOCAB.length)]);
    // Pre-tokenize once — this is the "index" step BM25 works over; the query loop below measures search().
    docs.push({ id: `m_${i}`, tokens: tokenize(words.join(" ")) });
  }
  return docs;
}

const QUERIES = [
  "deploy key rotation policy",
  "vector embedding recall ranking",
  "audit secret gate principal",
  "database migration index backup",
  "latency alert incident rollback",
];

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function benchSize(n) {
  const rng = mulberry32(0x1234 + n); // seed varies with size but is fixed per size → reproducible
  const t0 = performance.now();
  const docs = makeCorpus(n, rng);
  const buildMs = performance.now() - t0;

  // Warm up so the first-call JIT cost doesn't skew the numbers.
  for (const q of QUERIES) bm25Search(q, docs);

  const ITER = 40;
  const samples = [];
  for (let i = 0; i < ITER; i++) {
    const q = QUERIES[i % QUERIES.length];
    const s = performance.now();
    const results = bm25Search(q, docs);
    samples.push(performance.now() - s);
    // Touch the result so a clever optimizer can't elide the call entirely.
    if (results.length < 0) throw new Error("unreachable");
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((x, y) => x + y, 0) / samples.length;
  return {
    n,
    buildMs,
    meanMs: mean,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
  };
}

const sizes = [100, 1000, 10000];
const wallStart = performance.now();
const rows = sizes.map(benchSize);
const wallMs = performance.now() - wallStart;

const fmt = (x) => x.toFixed(3);
console.log("[DAN] RECALL DASHBOARD — BM25 recall latency vs corpus size");
console.log(`Node ${process.version} on ${process.platform}/${process.arch}`);
console.log("");
console.log("  corpus |   build |     mean |      p50 |      p95   (per query, ms)");
console.log("  -------+---------+----------+----------+---------");
for (const r of rows) {
  const size = String(r.n).padStart(6);
  console.log(
    `  ${size} | ${fmt(r.buildMs).padStart(7)} | ${fmt(r.meanMs).padStart(8)} | ${fmt(r.p50Ms).padStart(8)} | ${fmt(r.p95Ms).padStart(7)}`,
  );
}
console.log("");
console.log(`Total wall time: ${fmt(wallMs)} ms. Reproduce: make bench`);
