// v0.3 tests — per-principal identity over real HTTP. Proves the deeper gap is closed: the server records
// WHICH verified principal created a memory (not a self-asserted label), delete is owner-scoped, and principal
// management is admin-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";

function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-principals-"));
  const server = createServer({ dataDir });
  return new Promise((res) =>
    server.listen(0, "127.0.0.1", () => res({ server, dataDir, port: server.address().port, adminKey: server.recallToken })),
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
const mkPrincipal = async (port, adminKey, name) =>
  (await req(port, "POST", "/api/principals", { token: adminKey, body: { name } })).json.principal;

test("admin mints a principal; the new key authenticates as that principal; a wrong key is 401", async () => {
  const { server, port, adminKey } = await start();
  try {
    const created = await mkPrincipal(port, adminKey, "agent-a");
    assert.ok(created.apiKey && created.id);
    const st = await req(port, "GET", "/api/status", { token: created.apiKey });
    assert.equal(st.status, 200);
    assert.equal(st.json.principal.id, created.id);
    assert.equal(st.json.principal.role, "member");
    assert.equal((await req(port, "GET", "/api/status", { token: "not-a-real-key" })).status, 401);
  } finally {
    stop(server);
  }
});

test("provenance is the VERIFIED principal — a caller cannot forge it via source or metadata", async () => {
  const { server, port, adminKey } = await start();
  try {
    const a = await mkPrincipal(port, adminKey, "agent-a");
    const w = await req(port, "POST", "/api/remember", {
      token: a.apiKey,
      body: { text: "the deploy key rotates", source: "i-am-totally-admin", metadata: { principal: "admin" } },
    });
    assert.equal(w.json.ok, true);
    // the server-set principal is A — NOT the forged source, NOT the metadata claim
    assert.equal(w.json.memory.provenance.principal, a.id);
    assert.equal(w.json.memory.provenance.source, "i-am-totally-admin"); // recorded as an untrusted label only
    const list = await req(port, "GET", "/api/memories", { token: adminKey });
    assert.equal(list.json.memories[0].provenance.principal, a.id);
  } finally {
    stop(server);
  }
});

test("delete is owner-scoped: another member gets 403; the owner and the admin can forget", async () => {
  const { server, port, adminKey } = await start();
  try {
    const a = await mkPrincipal(port, adminKey, "agent-a");
    const b = await mkPrincipal(port, adminKey, "agent-b");
    const mk = async (token) => (await req(port, "POST", "/api/remember", { token, body: { text: "owned by a memory " + Math.random() } })).json.memory.id;

    let id = await mk(a.apiKey);
    assert.equal((await req(port, "DELETE", `/api/forget/${id}`, { token: b.apiKey })).status, 403); // B can't
    assert.equal((await req(port, "DELETE", `/api/forget/${id}`, { token: a.apiKey })).status, 200); // owner can

    id = await mk(a.apiKey);
    assert.equal((await req(port, "DELETE", `/api/forget/${id}`, { token: adminKey })).status, 200); // admin can
  } finally {
    stop(server);
  }
});

test("principal management is admin-only", async () => {
  const { server, port, adminKey } = await start();
  try {
    const a = await mkPrincipal(port, adminKey, "agent-a");
    assert.equal((await req(port, "POST", "/api/principals", { token: a.apiKey, body: { name: "sneaky" } })).status, 403);
    assert.equal((await req(port, "GET", "/api/principals", { token: a.apiKey })).status, 403);
    assert.equal((await req(port, "GET", "/api/principals", { token: adminKey })).status, 200);
  } finally {
    stop(server);
  }
});
