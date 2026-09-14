// The exact, dependency-free vector engine — used automatically when LanceDB's native package
// isn't available on the host. Pure math: no key, no network, no LanceDB needed to run these.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity, cosineRank } from "../src/memory.js";

test("cosineSimilarity: identical = 1, orthogonal = 0, opposite = -1", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
});

test("cosineSimilarity: scale-invariant (direction, not magnitude)", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 1], [10, 10]) - 1) < 1e-12);
});

test("cosineSimilarity: a zero vector is safe — returns 0, no divide-by-zero", () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test("cosineRank: ranks the nearest memory first and honors the limit", () => {
  const memories = [
    { id: "a", vector: [1, 0, 0] },
    { id: "b", vector: [0.9, 0.1, 0] },
    { id: "c", vector: [0, 1, 0] },
    { id: "d" }, // no vector — must be skipped, never crash
  ];
  const ranked = cosineRank([1, 0, 0], memories, 2);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, "a");
  assert.equal(ranked[1].id, "b");
  assert.equal(ranked[0].rank, 1);
  assert.ok(ranked[0].distance <= ranked[1].distance); // distance = 1 - sim → nearest is smallest
});

test("cosineRank: memories without a vector are skipped entirely", () => {
  const ranked = cosineRank([1, 0], [{ id: "x" }, { id: "y", vector: [1, 0] }], 5);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, "y");
});
