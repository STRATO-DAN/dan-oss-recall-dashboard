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

test("recall rejects unbounded or malformed search parameters before search", () => withStore(async store => {
  for (const k of [-1, 0, 1.5, NaN, Infinity, 101]) await assert.rejects(store.recall("test", k), RangeError);
  for (const minScore of [-1, NaN, Infinity]) await assert.rejects(store.recall("test", 5, { minScore }), RangeError);
  await assert.rejects(store.recall("x".repeat(16385)), RangeError);
  assert.deepEqual((await store.recall("test", 100)).results, []);
}));

test("remember() rejects empty text with a real error, stores nothing", async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.remember(""), /Nothing real to remember/);
    assert.equal(store.list().length, 0);
  });
});

test("CONCURRENCY: overlapping remember() calls all persist to the sidecar — no rename race, no lost update", async () => {
  await withStore(async (store) => {
    const N = 25;
    // Before serialization every save shared ONE `.<pid>.tmp` path, so concurrent writers could race the
    // rename and/or lose an update (whichever rename lands last wins the file, even with a staler list).
    await Promise.all(Array.from({ length: N }, (_, i) => store.remember(`concurrent memory number ${i}`)));
    assert.equal(store.list().length, N, "all concurrent writes are held in memory");
    // Reload the sidecar in a fresh store — proves every write is durably ON DISK, not just in RAM.
    const reloaded = new MemoryStore(store.dataDir);
    await reloaded.init();
    assert.equal(
      reloaded.list().length,
      N,
      "every concurrently-remembered item is durably persisted — no update lost to a shared-temp-file collision",
    );
  });
});

test("R1 CROSS-PROCESS: two independent writers on one dataDir don't lose each other's update (lock + read-modify-write merge)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-recall-r1-"));
  try {
    // Two stores, two independent in-RAM snapshots — exactly what two OS processes on one dataDir have.
    // Before the cross-process lock + read-modify-write merge, each save wrote only its OWN snapshot and the
    // rename that landed last clobbered the other writer's memory (a real lost update). Now each save re-reads
    // the on-disk set under an O_EXCL lock and merges, so both survive.
    const a = new MemoryStore(dir); await a.init();
    const b = new MemoryStore(dir); await b.init();
    await Promise.all([
      a.remember("memory from writer A", {}, { principal: "writer-a" }),
      b.remember("memory from writer B", {}, { principal: "writer-b" }),
    ]);
    const reloaded = new MemoryStore(dir); await reloaded.init();
    const texts = reloaded.list().map((m) => m.text).sort();
    assert.deepEqual(texts, ["memory from writer A", "memory from writer B"],
      "both writers' memories are durably persisted — neither update is lost to a clobbering rename");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("R3: a victim storing the query term does NOT change the attacker's own-doc BM25 score (per-principal corpus stats)", async () => {
  await withStore(async (store) => {
    // Attacker builds its own little corpus and records the score of its OWN memory for a query.
    await store.remember("alpha beta gamma deploy token", {}, { principal: "attacker" });
    await store.remember("some unrelated attacker note about lunch", {}, { principal: "attacker" });
    const before = (await store.recall("deploy token", 5, { principal: "attacker" })).results;
    const scoreBefore = before.find((r) => /alpha beta gamma/.test(r.text)).score;

    // A DIFFERENT principal now stores many memories containing the query terms — which would move a GLOBAL
    // corpus's document-frequency / average-length, and thus the attacker's own score (a term-presence oracle).
    for (let i = 0; i < 8; i++) {
      await store.remember(`victim secret ${i}: the deploy token rotates, the token really matters`, {}, { principal: "victim" });
    }
    const after = (await store.recall("deploy token", 5, { principal: "attacker" })).results;
    const scoreAfter = after.find((r) => /alpha beta gamma/.test(r.text)).score;

    assert.equal(scoreAfter, scoreBefore,
      "the attacker's own-doc score must not shift when another principal stores the query term");
    assert.ok(after.every((r) => !/victim secret/.test(r.text)), "content read-isolation is not weakened");
  });
});

test("R5: quota is per-principal — one principal filling its budget doesn't starve another, and the error reflects only its own usage", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-recall-r5-"));
  const store = new MemoryStore(dir, { maxCount: 2 }); // honoured as the PER-PRINCIPAL budget
  await store.init();
  try {
    await store.remember("alice 1", {}, { principal: "alice" });
    await store.remember("alice 2", {}, { principal: "alice" });
    // Alice is full — her 3rd is refused because of HER usage, not the store's...
    await assert.rejects(() => store.remember("alice 3", {}, { principal: "alice" }), QuotaError);
    // ...but Bob is entirely unaffected: he still has his own full budget (no cross-principal starvation).
    await store.remember("bob 1", {}, { principal: "bob" });
    await store.remember("bob 2", {}, { principal: "bob" });
    assert.equal(store.list({ principal: "alice" }).length, 2);
    assert.equal(store.list({ principal: "bob" }).length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("R10: a failed durable save rolls back the in-RAM state (no persisted-nothing / remembered-in-RAM divergence)", async () => {
  await withStore(async (store) => {
    await store.remember("first, saved fine", {}, { principal: "p" });
    // Force the NEXT save to fail after the optimistic RAM push; the memory must not linger in RAM or usage.
    const realPersist = store._persist.bind(store);
    store._persist = async () => { throw new Error("disk full (simulated)"); };
    await assert.rejects(() => store.remember("second, save fails", {}, { principal: "p" }), /disk full/);
    store._persist = realPersist;
    assert.equal(store.list().length, 1, "the memory whose save failed is not left in RAM");
    assert.equal(store._usageFor("p").count, 1, "per-principal usage did not count the failed write");
    const reloaded = new MemoryStore(store.dataDir); await reloaded.init();
    assert.equal(reloaded.list().length, 1, "and it is not on disk either");
  });
});

test("v0.4 per-principal read isolation: recall/list are scoped to the caller by default; admin + null + shared bypass", async () => {
  await withStore(async (store) => {
    await store.remember("the deploy key rotates every 90 days", {}, { principal: "agent-a" });
    await store.remember("the office wifi password is on the sticker", {}, { principal: "agent-b" });

    // DEFAULT: B sees only its own — not A's.
    assert.equal(store.list({ principal: "agent-b" }).length, 1);
    assert.match(store.list({ principal: "agent-b" })[0].text, /wifi/);
    assert.equal((await store.recall("deploy key rotation", 5, { principal: "agent-b" })).results.length, 0, "B cannot recall A's memory");
    // A sees its own.
    assert.ok((await store.recall("deploy key rotation", 5, { principal: "agent-a" })).results.length >= 1, "A recalls its own memory");
    assert.equal(store.list({ principal: "agent-a" }).length, 1);
    // ADMIN (operator) bypass → sees all.
    assert.equal(store.list({ principal: "agent-b", isAdmin: true }).length, 2);
    assert.ok((await store.recall("deploy key rotation", 5, { principal: "agent-b", isAdmin: true })).results.length >= 1);
    // NULL principal (trusted in-process/library caller) → sees all.
    assert.equal(store.list().length, 2);
  });

  // SHARED-MEMORY mode (operator opt-in) → the corpus is a common pool again.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recall-shared-"));
  const shared = new MemoryStore(dir, { sharedMemory: true });
  await shared.init();
  try {
    await shared.remember("the deploy key rotates every 90 days", {}, { principal: "agent-a" });
    assert.ok((await shared.recall("deploy key rotation", 5, { principal: "agent-b" })).results.length >= 1, "shared mode: B recalls A's memory");
    assert.equal(shared.list({ principal: "agent-b" }).length, 1, "shared mode: B lists A's memory");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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

test("quota (v0.3): the total-bytes limit rejects oversize writes and forget() frees the exact footprint", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-recall-quota-"));
  const store = new MemoryStore(dir, { maxTotalBytes: 1500 });
  await store.init();
  try {
    const m = await store.remember("x".repeat(1000)); // ~1000-byte text + small metadata/provenance, fits
    await assert.rejects(() => store.remember("y".repeat(1000)), QuotaError); // second would exceed 1500
    await store.forget(m.id); // frees the full footprint
    await store.remember("z".repeat(1000)); // fits again
    assert.equal(store.list().length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("quota (v0.3): caller metadata counts toward the storage limit (not just text)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-recall-quota-md-"));
  const store = new MemoryStore(dir, { maxTotalBytes: 400 });
  await store.init();
  try {
    // tiny text, but large caller-controlled metadata — in v0.2 (text-only accounting) this slipped past;
    // v0.3 counts the full footprint, so it is correctly rejected.
    await assert.rejects(() => store.remember("hi", { blob: "m".repeat(1000) }), QuotaError);
    assert.equal(store.list().length, 0);
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

test("crash/recovery (v0.3): recall drops a stale index id the sidecar no longer has (sidecar is source of truth)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-recall-crash-"));
  const savedKey = process.env.OPENAI_API_KEY;
  try {
    const store = new MemoryStore(dir);
    await store.init();
    const m = await store.remember("real memory about deploy keys"); // BM25 mode — no embedding call
    // Now simulate a diverged index: enable the hybrid path and have the vector ranker return a GHOST id the
    // sidecar no longer has (a best-effort LanceDB delete that failed to remove it). embed() is never called —
    // _vectorRank is stubbed wholesale.
    process.env.OPENAI_API_KEY = "unused-in-this-test";
    store.memories[0].hasVector = true;
    store._vectorRank = async () => [
      { id: "ghost-deleted-id", rank: 1, distance: 0.01 },
      { id: m.id, rank: 2, distance: 0.5 },
    ];
    const result = await store.recall("deploy keys", 5);
    assert.equal(result.mode, "hybrid");
    const ids = result.results.map((r) => r.id);
    assert.ok(!ids.includes("ghost-deleted-id"), "a stale index id must be dropped, not surfaced");
    assert.ok(ids.includes(m.id), "the real, present memory is still returned");
    // and no malformed, id-less result leaked through
    assert.ok(result.results.every((r) => r.id && r.text), "every result carries real id + text from the sidecar");
  } finally {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("forget() audits a failed vector delete so orphans are findable (never swallowed)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dan-oss-recall-test-"));
  const captured = [];
  const store = new MemoryStore(dir, { audit: (e) => captured.push(e) });
  await store.init();
  try {
    const m = await store.remember("memory whose index row will fail to delete");
    // A vector backend whose delete throws: the sidecar removal must still succeed, and the
    // orphan must be audited (not swallowed) for a later cleanup sweep.
    store.table = { delete: async () => { throw new Error("index unavailable"); } };
    assert.equal(await store.forget(m.id), true);
    assert.equal(store.list().length, 0, "sidecar removal still lands despite index failure");
    const entry = captured.find((e) => e.action === "vector-delete-failed" && e.id === m.id);
    assert.ok(entry, "a vector-delete-failed audit entry names the orphaned id");
    assert.match(entry.error, /index unavailable/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
