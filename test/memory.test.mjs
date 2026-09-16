// Real integration tests against MemoryStore itself (BM25-only mode — no OPENAI_API_KEY in this
// test run, so these exercise the real, always-available default path every user gets with zero
// setup). Uses a real temp directory per test, cleaned up after.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore, QuotaError } from "../src/memory.js";

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-recall-test-"));
  const store = new MemoryStore(dir);
  await store.init();
  try {
    await fn(store);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("remember() rejects empty text with a real error, stores nothing", async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.remember(""), /Nothing real to remember/);
    assert.equal(store.list().length, 0);
  });
});

test("recall() with no memories returns an empty, honest result, not an error", async () => {
  await withStore(async (store) => {
    const result = await store.recall("anything");
    assert.equal(result.mode, "bm25");
    assert.deepEqual(result.results, []);
  });
});

test("recall() ranks a real matching memory above an unrelated one", async () => {
  await withStore(async (store) => {
    await store.remember("the deploy key rotates every 90 days");
    await store.remember("the office wifi password is on the router sticker");
    const result = await store.recall("deploy key rotation");
    assert.equal(result.mode, "bm25");
    assert.ok(result.results.length >= 1);
    assert.match(result.results[0].text, /deploy key/);
    assert.ok(result.results[0].score > 0);
  });
});

test("recall() never returns a memory that shares zero real terms with the query", async () => {
  await withStore(async (store) => {
    await store.remember("the deploy key rotates every 90 days");
    const result = await store.recall("Ada Lovelace algorithm");
    assert.deepEqual(result.results, []);
  });
});

test("a stricter minScore filters out a weak match that a looser one would include", async () => {
  await withStore(async (store) => {
    await store.remember("the deploy key rotates every 90 days");
    await store.remember("deploy deploy deploy key key key rotates constantly here");
    const loose = await store.recall("deploy key", 5, { minScore: 0 });
    const strict = await store.recall("deploy key", 5, { minScore: loose.results[0].score - 0.001 });
    assert.ok(strict.results.length < loose.results.length,
      `expected minScore to actually filter something out: loose=${loose.results.length} strict=${strict.results.length}`);
  });
});

test("forget() removes a memory so it no longer appears in recall()", async () => {
  await withStore(async (store) => {
    const m = await store.remember("the deploy key rotates every 90 days");
    let result = await store.recall("deploy key");
    assert.equal(result.results.length, 1);
    const removed = await store.forget(m.id);
    assert.equal(removed, true);
    result = await store.recall("deploy key");
    assert.equal(result.results.length, 0);
  });
});

test("recall() respects k, returning at most that many results", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 5; i++) {
      await store.remember(`deploy note number ${i} about the deploy key`);
    }
    const result = await store.recall("deploy key", 2);
    assert.equal(result.results.length, 2);
  });
});

test("quota (v0.2): remember() rejects with QuotaError once the count limit is hit — before any store growth", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-recall-quota-"));
  const store = new MemoryStore(dir, { maxCount: 1 });
  await store.init();
  try {
    await store.remember("first is fine");
    await assert.rejects(() => store.remember("second exceeds the count limit"), QuotaError);
    assert.equal(store.list().length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("quota (v0.2): a total-bytes limit rejects oversize writes and forget() frees the budget", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-recall-quota-"));
  const store = new MemoryStore(dir, { maxTotalBytes: 20 });
  await store.init();
  try {
    const m = await store.remember("0123456789"); // 10 bytes, ok
    await assert.rejects(() => store.remember("this is well over twenty bytes"), QuotaError);
    await store.forget(m.id); // frees the 10 bytes
    await store.remember("0123456789"); // fits again
    assert.equal(store.list().length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("provenance (v0.2): a memory records server-set provenance {source, at}", async () => {
  await withStore(async (store) => {
    const m = await store.remember("hello", {}, { source: "agent-Z" });
    assert.equal(m.provenance.source, "agent-Z");
    assert.ok(m.provenance.at);
    const listed = store.list()[0];
    assert.equal(listed.provenance.source, "agent-Z");
  });
});
