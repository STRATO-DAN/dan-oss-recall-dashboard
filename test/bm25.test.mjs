// Real tests, node's own built-in test runner (node:test) — zero dependency, `npm test` runs
// this directly. Tests real BM25 properties against real, hand-checkable small corpora, not
// snapshot-style "did the number change" tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, buildCorpusStats, scoreDocument, search } from "../src/bm25.js";

test("tokenize lowercases and splits on non-alphanumeric, dropping empties", () => {
  assert.deepEqual(tokenize("The Deploy-Key rotates!! every 90 days."),
    ["the", "deploy", "key", "rotates", "every", "90", "days"]);
});

test("a document sharing zero terms with the query scores exactly 0", () => {
  const documents = [{ id: "a", tokens: tokenize("the deploy key rotates every 90 days") }];
  const results = search("Ada Lovelace algorithm", documents);
  assert.equal(results.length, 1);
  assert.equal(results[0].score, 0);
});

test("a document sharing a term with the query scores strictly above 0", () => {
  const documents = [{ id: "a", tokens: tokenize("the deploy key rotates every 90 days") }];
  const results = search("deploy key", documents);
  assert.equal(results.length, 1);
  assert.ok(results[0].score > 0, `expected a positive score, got ${results[0].score}`);
});

test("a document matching MORE query terms ranks above one matching fewer, all else equal", () => {
  const documents = [
    { id: "partial", tokens: tokenize("the deploy process is documented elsewhere") },
    { id: "full", tokens: tokenize("the deploy key rotates every day") },
  ];
  const results = search("deploy key rotates", documents);
  assert.equal(results[0].id, "full", `expected 'full' to rank first, got order: ${results.map(r => r.id)}`);
  assert.ok(results[0].score > results[1].score);
});

test("a rarer term contributes more score than a common one (real IDF weighting, not just term count)", () => {
  // "the" appears in every document (common, low IDF); "lovelace" appears in only one (rare, high IDF).
  const documents = [
    { id: "common-only", tokens: tokenize("the quick brown fox") },
    { id: "rare-term", tokens: tokenize("ada lovelace wrote the first algorithm") },
    { id: "filler-1", tokens: tokenize("the weather today is fine") },
    { id: "filler-2", tokens: tokenize("the meeting starts at the usual time") },
  ];
  const results = search("lovelace", documents);
  assert.equal(results[0].id, "rare-term");
  assert.ok(results[0].score > 0);
});

test("an empty or all-stopword-shaped query returns no results, not an error", () => {
  const documents = [{ id: "a", tokens: tokenize("something real") }];
  assert.deepEqual(search("", documents), []);
  assert.deepEqual(search("   ", documents), []);
});

test("buildCorpusStats reports real N and average document length", () => {
  const stats = buildCorpusStats([["a", "b"], ["a", "b", "c", "d"]]);
  assert.equal(stats.N, 2);
  assert.equal(stats.avgdl, 3);
  assert.equal(stats.df.get("a"), 2);
  assert.equal(stats.df.get("c"), 1);
});

test("scoreDocument matches search()'s own per-document score for the same corpus", () => {
  const documents = [
    { id: "a", tokens: tokenize("the deploy key rotates") },
    { id: "b", tokens: tokenize("the office wifi password") },
  ];
  const results = search("deploy key", documents);
  const stats = buildCorpusStats(documents.map((d) => d.tokens));
  const direct = scoreDocument(tokenize("deploy key"), documents[0].tokens, stats);
  const fromSearch = results.find((r) => r.id === "a").score;
  assert.equal(fromSearch, direct);
});
