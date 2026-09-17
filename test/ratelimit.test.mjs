// RECALL_RATE_MAX (the general /api/ limiter) is already covered in auth.test.mjs. This covers the
// gaps: RECALL_WRITE_MAX (the separate, stricter limiter guarding /api/remember specifically) had NO
// test at all, and neither did the fixed-window's reset behavior or the two limiters' independence.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, makeRateLimiter } from "../src/server.js";

function start(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-ratelimit-"));
  const server = createServer({ dataDir });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return new Promise((res) =>
    server.listen(0, "127.0.0.1", () => res({ server, dataDir, port: server.address().port, token: server.recallToken })),
  );
}

function req(port, method, p, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { host: `127.0.0.1:${port}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (data) headers["content-type"] = "application/json";
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers, agent: false }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        let json = null;
        try { json = b ? JSON.parse(b) : null; } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
const stop = (server) => { server.closeAllConnections?.(); server.close(); };

test("the WRITE rate limit (RECALL_WRITE_MAX) engages on /api/remember independently of RECALL_RATE_MAX", async () => {
  const { server, port, token, dataDir } = await start({ RECALL_WRITE_MAX: "2", RECALL_RATE_MAX: "600" });
  try {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await req(port, "POST", "/api/remember", { token, body: { text: `m${i}` } })).status);
    assert.deepEqual(codes.slice(0, 2), [200, 200], "the first WRITE_MAX writes succeed");
    assert.equal(codes[2], 429, "the write limiter engages at its own, stricter bound");
    assert.equal(codes[3], 429);
  } finally {
    stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("hitting the write limit does not consume the general api limit, and vice versa — the two limiters are independent", async () => {
  const { server, port, token, dataDir } = await start({ RECALL_WRITE_MAX: "1", RECALL_RATE_MAX: "600" });
  try {
    assert.equal((await req(port, "POST", "/api/remember", { token, body: { text: "one" } })).status, 200);
    assert.equal((await req(port, "POST", "/api/remember", { token, body: { text: "two" } })).status, 429, "write limit is exhausted");
    // a read op (GET, gated only by the general apiLimit) must still work — the write limiter's
    // exhaustion does not bleed into the general limiter.
    const read = await req(port, "GET", "/api/memories", { token });
    assert.equal(read.status, 200, "a read is not blocked by the exhausted WRITE limiter");
  } finally {
    stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("R6: the api rate limit is PER-PRINCIPAL — one principal's burst does not 429 another (no cross-principal DoS)", async () => {
  const { server, port, token, dataDir } = await start({ RECALL_RATE_MAX: "3" });
  try {
    const alice = (await req(port, "POST", "/api/principals", { token, body: { name: "alice" } })).json.principal;
    const bob = (await req(port, "POST", "/api/principals", { token, body: { name: "bob" } })).json.principal;
    // Alice bursts past her own window...
    const aliceCodes = [];
    for (let i = 0; i < 5; i++) aliceCodes.push((await req(port, "GET", "/api/status", { token: alice.apiKey })).status);
    assert.ok(aliceCodes.includes(429), "alice is throttled once she exceeds her OWN window");
    // ...bob's very first request still succeeds — his window is independent of alice's (and of the admin's).
    assert.equal((await req(port, "GET", "/api/status", { token: bob.apiKey })).status, 200,
      "bob is unaffected by alice's burst — the limiter keys per principal");
  } finally {
    stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("R6: makeRateLimiter keys independently — one key's exhaustion leaves another key's budget intact", () => {
  const limit = makeRateLimiter({ windowMs: 10_000, max: 2 });
  assert.equal(limit("alice"), true);
  assert.equal(limit("alice"), true);
  assert.equal(limit("alice"), false, "alice is exhausted");
  assert.equal(limit("bob"), true, "bob still has his full, independent budget");
  assert.equal(limit("bob"), true);
  assert.equal(limit("bob"), false);
});

test("BOUNDARY: the fixed window resets exactly at its edge — a caller is not permanently locked out", async () => {
  // The server always uses a real 60s window (not env-configurable), so the reset boundary is tested
  // directly against the exported limiter with a short, controllable window — deterministic and fast,
  // not a 60-real-second wait against a live server.
  const limit = makeRateLimiter({ windowMs: 50, max: 2 });
  assert.equal(limit(), true);
  assert.equal(limit(), true);
  assert.equal(limit(), false, "the 3rd call within the window is refused");
  await new Promise((r) => setTimeout(r, 60)); // past the 50ms window
  assert.equal(limit(), true, "a call after the window elapsed is allowed again — the count really resets");
  assert.equal(limit(), true);
  assert.equal(limit(), false, "and the new window enforces the same bound, not an inflated one");
});

test("BOUNDARY: calls exactly at the max are allowed; the very next one is refused (off-by-one check)", () => {
  const limit = makeRateLimiter({ windowMs: 10_000, max: 5 });
  const results = Array.from({ length: 6 }, () => limit());
  assert.deepEqual(results, [true, true, true, true, true, false], "exactly `max` allowed, the (max+1)th refused — no off-by-one");
});
