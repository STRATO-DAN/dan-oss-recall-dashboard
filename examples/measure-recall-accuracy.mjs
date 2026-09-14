// Real, runnable measurement — not an assertion of a claimed number. Builds a real 10-memory
// corpus, runs a real set of exact-term queries and a real set of paraphrased queries (same
// meaning, deliberately different words) against the real BM25 engine, and reports real top-1
// accuracy for each set separately — exact-match accuracy and paraphrase accuracy shown apart,
// never averaged into one number that would hide the real difference between them.
//
//   node examples/measure-recall-accuracy.mjs
//
// If OPENAI_API_KEY is set, also measures the real hybrid (BM25 + semantic) mode the same way,
// so the exact-vs-paraphrase tradeoff this tool's own README claims is shown from a real run on
// your own machine, not just asserted.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory.js";
import { embeddingsConfigured } from "../src/embeddings.js";

const CORPUS = [
  "the deploy key rotates every 90 days",
  "the staging database is a nightly snapshot of production",
  "Ada Lovelace wrote the first published algorithm",
  "our on-call rotation changes every Monday at 9am",
  "the CDN cache purges automatically after 24 hours",
  "customer support tickets escalate after 4 hours with no reply",
  "the backup job runs at 2am UTC every night",
  "API rate limits reset at the top of every hour",
  "the office wifi password is printed on the router sticker",
  "code review requires two approvals before merging",
];

// Each query names which corpus index (0-based) is the one real correct answer.
const EXACT_QUERIES = [
  ["deploy key rotates", 0],
  ["staging database snapshot", 1],
  ["on-call rotation Monday", 3],
  ["backup job 2am", 6],
  ["code review approvals", 9],
];

// Same underlying facts, deliberately reworded with different words than the stored text —
// a real test of whether the engine understands MEANING, not just shared vocabulary.
const PARAPHRASE_QUERIES = [
  ["how often does the credential get replaced", 0],
  ["is the test environment a copy of the live one", 1],
  ["who is credited with inventing computer programming", 2],
  ["when does the person on duty switch", 3],
  ["how long until cached content expires", 4],
];

async function measure(store, queries, label) {
  let hits = 0;
  const rows = [];
  for (const [query, correctIndex] of queries) {
    const result = await store.recall(query, 1);
    const top = result.results[0];
    const correctText = CORPUS[correctIndex];
    const isHit = top?.text === correctText;
    if (isHit) hits++;
    rows.push({ query, top: top?.text ?? "(no result)", score: top?.score, correct: isHit });
  }
  const accuracy = (hits / queries.length) * 100;
  console.log(`\n${label} — top-1 accuracy: ${hits}/${queries.length} (${accuracy.toFixed(1)}%)`);
  for (const r of rows) {
    console.log(`  ${r.correct ? "✅" : "❌"} "${r.query}"`);
    console.log(`     -> ${r.top}${typeof r.score === "number" ? ` (score ${r.score.toFixed(4)})` : ""}`);
  }
  return accuracy;
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-recall-measure-"));
try {
  const store = new MemoryStore(dataDir);
  await store.init();
  for (const text of CORPUS) await store.remember(text);

  console.log(`Mode: ${embeddingsConfigured() ? "hybrid (BM25 + semantic)" : "bm25 (no OPENAI_API_KEY set)"}`);
  console.log(`Corpus: ${CORPUS.length} real memories, ${EXACT_QUERIES.length} exact queries, ${PARAPHRASE_QUERIES.length} paraphrased queries.`);

  const exactAcc = await measure(store, EXACT_QUERIES, "EXACT queries");
  const paraphraseAcc = await measure(store, PARAPHRASE_QUERIES, "PARAPHRASED queries");

  console.log(`\nSummary: exact ${exactAcc.toFixed(1)}% · paraphrase ${paraphraseAcc.toFixed(1)}%`);
  if (!embeddingsConfigured()) {
    console.log("Set OPENAI_API_KEY and re-run to also measure real hybrid-mode accuracy on the same queries.");
  }
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}
