// v0.2 security tests — real HTTP against a real server on an ephemeral loopback port. Proves the
// findings the team review raised are closed: privileged ops require the bearer token, non-loopback
// Host is refused, provenance is recorded, and the rate limit engages.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";

function start(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-auth-"));
  const server = createServer({ dataDir });
  // restore env right after construction (limits/token are read at construct time)
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return new Promise((res) =>
    server.listen(0, "127.0.0.1", () =>
      res({ server, dataDir, port: server.address().port, token: server.recallToken }),
    ),
  );
}

function req(port, method, p, { token, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { host: host || `127.0.0.1:${port}` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (data) headers["content-type"] = "application/json";
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers, agent: false }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        let json = null;
        try { json = b ? JSON.parse(b) : null; } catch { json = null; } // 403/404 bodies are plain text
        resolve({ status: res.statusCode, json });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

test("privileged ops are REFUSED without the bearer token (read, write, delete → 401)", async () => {
  const { server, port } = await start();
  try {
    assert.equal((await req(port, "GET", "/api/memories")).status, 401);
    assert.equal((await req(port, "POST", "/api/remember", { body: { text: "x" } })).status, 401);
    assert.equal((await req(port, "DELETE", "/api/forget/abc")).status, 401);
    assert.equal((await req(port, "GET", "/api/status")).status, 401);
    // a wrong token is also refused
    assert.equal((await req(port, "GET", "/api/memories", { token: "not-the-token" })).status, 401);
  } finally {
    server.closeAllConnections?.(); server.close();
  }
});

test("with the token: a full remember → list → recall → forget round-trip works", async () => {
  const { server, port, token } = await start();
  try {
    const w = await req(port, "POST", "/api/remember", { token, body: { text: "the sky is blue", source: "agent-A" } });
    assert.equal(w.status, 200);
    assert.equal(w.json.ok, true);
    const id = w.json.memory.id;
    // provenance is SERVER-set from the authenticated request, not caller metadata
    assert.equal(w.json.memory.provenance.source, "agent-A");
    assert.ok(w.json.memory.provenance.at);

    const list = await req(port, "GET", "/api/memories", { token });
    assert.equal(list.json.memories.length, 1);
    assert.equal(list.json.memories[0].provenance.source, "agent-A");

    const rec = await req(port, "GET", "/api/recall?q=sky", { token });
    assert.equal(rec.json.ok, true);
    assert.equal(rec.json.results[0].text, "the sky is blue");

    const del = await req(port, "DELETE", `/api/forget/${id}`, { token });
    assert.equal(del.status, 200);
    assert.equal((await req(port, "GET", "/api/memories", { token })).json.memories.length, 0);
  } finally {
    server.closeAllConnections?.(); server.close();
  }
});

test("a non-loopback Host header is refused (DNS-rebind guard, 403) even with a valid token", async () => {
  const { server, port, token } = await start();
  try {
    const r = await req(port, "GET", "/api/memories", { token, host: "evil.example.com" });
    assert.equal(r.status, 403);
  } finally {
    server.closeAllConnections?.(); server.close();
  }
});

test("the rate limit engages (RECALL_RATE_MAX) → 429 once the window is exceeded", async () => {
  const { server, port, token } = await start({ RECALL_RATE_MAX: "3" });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await req(port, "GET", "/api/status", { token })).status);
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
    assert.equal(codes[3], 429);
    assert.equal(codes[4], 429);
  } finally {
    server.closeAllConnections?.(); server.close();
  }
});
