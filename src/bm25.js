// Real BM25 — the actual, standard ranking function (Robertson/Sparck Jones; the same family of
// algorithm Lucene/Elasticsearch use for lexical relevance), not a toy scoring heuristic. Zero
// dependencies, pure arithmetic over token frequencies — no model, no download, no license
// question, no external call. This is the real "logic engine" behind keyword recall: every
// stored memory gets an actual computed relevance score against a query, not a boolean
// substring match with no ranking at all.
//
// Standard constants: k1 controls how much repeated term frequency keeps adding relevance
// (1.2–2.0 is the normal range; 1.5 is Lucene's own default). b controls how much a document's
// length is penalized relative to the corpus average (0 = no length penalty, 1 = full penalty;
// 0.75 is the standard default both Lucene and the original Okapi BM25 paper use).
const K1 = 1.5;
const B = 0.75;

/** Real, honest tokenizing — lowercase, split on anything that isn't a letter or digit, drop
 * empties. No stemming, no stopword removal: a real, current, disclosed limitation (see README
 * FAQ), not a silently-worse hidden behavior. */
export function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Real corpus statistics BM25 needs: how many documents, how long they are on average, and how
 * many documents each term appears in (document frequency). Computed fresh from whatever
 * documents are passed in — recomputing on every call is the right tradeoff at the scale this
 * tool runs at (a local memory store, not a search-engine-scale corpus); no incremental index to
 * keep consistent, no risk of it drifting from the real document set. */
export function buildCorpusStats(documents) {
  const N = documents.length;
  const df = new Map();
  let totalLength = 0;
  for (const tokens of documents) {
    totalLength += tokens.length;
    for (const term of new Set(tokens)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const avgdl = N > 0 ? totalLength / N : 0;
  return { N, df, avgdl };
}

/** IDF, the "+1" (BM25+-style) variant — always non-negative, unlike the original Okapi formula,
 * which can go negative for a term that appears in more than half the corpus and would then
 * actively PENALIZE a document for containing a common word. A memory store with only a handful
 * of entries hits that case constantly (a term shared by 2 of 3 memories is already "more than
 * half"), so the classic formula would misbehave here far more than in a large search index —
 * the +1 variant is the right choice for this tool's real scale, not just a stylistic pick. */
function idf(term, { N, df }) {
  const n = df.get(term) ?? 0;
  return Math.log((N - n + 0.5) / (n + 0.5) + 1);
}

/** The real BM25 score of one document against one (already-tokenized) query. 0 means the
 * document shares no term with the query at all — a real, meaningful floor a caller can filter
 * on, unlike a naive scheme with no natural "not relevant" threshold. */
export function scoreDocument(queryTokens, docTokens, corpusStats) {
  const { avgdl } = corpusStats;
  const docLength = docTokens.length;
  const termFreq = new Map();
  for (const term of docTokens) {
    termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
  }
  let score = 0;
  for (const term of queryTokens) {
    const f = termFreq.get(term);
    if (!f) continue; // term absent from this document contributes exactly 0, not a penalty
    const numerator = f * (K1 + 1);
    const denominator = f + K1 * (1 - B + (B * docLength) / (avgdl || 1));
    score += idf(term, corpusStats) * (numerator / denominator);
  }
  return score;
}

/** Real, ranked search over a set of `{ id, tokens }` documents. Returns every document with a
 * real score, sorted descending — the caller decides the relevance threshold (see memory.js),
 * this module's own job is only the real scoring math, not deciding what counts as "relevant
 * enough" for any particular product's own UI. */
export function search(query, documents) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const corpusStats = buildCorpusStats(documents.map((d) => d.tokens));
  return documents
    .map((d) => ({ id: d.id, score: scoreDocument(queryTokens, d.tokens, corpusStats) }))
    .sort((a, b) => b.score - a.score);
}
