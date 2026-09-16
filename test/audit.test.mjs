// The audit log exists to answer "what actually happened" — auth failures, remembers, quota
// rejections, forgets, denied forgets, principal management. These tests prove entries are REALLY
// written to disk with server-established values, not just that audit() is called somewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";
import { makeAudit } from "../src/audit.js";

function start(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-audit-"));
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

async function readAuditLines(dataDir) {
  try {
    const raw = await fsp.readFile(path.join(dataDir, "audit.log"), "utf8");
    return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// ── makeAudit() in isolation ────────────────────────────────────────────────────────────────────

test("makeAudit writes a real JSONL line with a server-set timestamp", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-audit-unit-"));
  try {
    const audit = makeAudit(dataDir);
    audit({ action: "remember", id: "mem-1", principal: "p1" });
    const lines = await readAuditLines(dataDir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, "remember");
    assert.ok(typeof lines[0].ts === "string" && !Number.isNaN(Date.parse(lines[0].ts)));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ── real security events actually reach audit.log, over real HTTP ─────────────────────────────────

test("AUDIT: an unauthenticated request really produces an auth-failure entry on disk", async () => {
  const { server, port, dataDir } = await start();
  try {
    await req(port, "GET", "/api/memories");
    const entry = (await readAuditLines(dataDir)).find((l) => l.action === "auth-failure");
    assert.ok(entry, "a 401 must leave a real audit trail");
    assert.equal(entry.path, "/api/memories");
  } finally {
    stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("AUDIT: a successful remember really lands in audit.log under the VERIFIED principal, not client input", async () => {
  const { server, port, token, dataDir } = await start();
  try {
    const w = await req(port, "POST", "/api/remember", { token, body: { text: "hello", source: "agent-x" } });
    assert.equal(w.status, 200);
    const entry = (await readAuditLines(dataDir)).find((l) => l.action === "remember");
    assert.ok(entry);
    assert.equal(entry.id, w.json.memory.id, "the audited memory id is the REAL stored id");
    assert.equal(entry.source, "agent-x");
  } finally {
    stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("AUDIT: a quota-rejected remember really produces a remember-rejected entry on disk", async () => {
  const { server, port, token, dataDir } = await start({ RECALL_MAX_MEMORIES: "1" });
  try {
    const first = await req(port, "POST", "/api/remember", { token, body: { text: "one" } });
    assert.equal(first.status, 200);
    const second = await req(port, "POST", "/api/remember", { token, body: { text: "two" } });
    assert.equal(second.status, 413);
    const entry = (await readAuditLines(dataDir)).find((l) => l.action === "remember-rejected");
    assert.ok(entry, "a quota rejection must be audited, not just returned to the caller");
    assert.equal(entry.reason, "quota");
  } finally {
    stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("AUDIT: a successful forget really lands in audit.log with a real result", async () => {
  const { server, port, token, dataDir } = await start();
  try {
    const w = await req(port, "POST", "/api/remember", { token, body: { text: "to be forgotten" } });
    const del = await req(port, "DELETE", `/api/forget/${w.json.memory.id}`, { token });
    assert.equal(del.status, 200);
    const entry = (await readAuditLines(dataDir)).find((l) => l.action === "forget" && l.id === w.json.memory.id);
    assert.ok(entry);
    assert.equal(entry.result, "removed");
  } finally {
    stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("AUDIT: a non-owner's denied forget really lands in audit.log as forget-denied", async () => {
  const { server, port, token, dataDir } = await start();
  try {
    // mint a second, non-admin principal to attempt forgetting the admin's own memory
    const created = await req(port, "POST", "/api/principals", { token, body: { name: "other-agent" } });
    assert.equal(created.status, 201);
    const otherToken = created.json.principal.apiKey;

    const w = await req(port, "POST", "/api/remember", { token, body: { text: "owned by admin" } });
    const denied = await req(port, "DELETE", `/api/forget/${w.json.memory.id}`, { token: otherToken });
    assert.equal(denied.status, 403);
    const entry = (await readAuditLines(dataDir)).find((l) => l.action === "forget-denied");
    assert.ok(entry, "a cross-principal delete attempt must be audited under the REAL denied principal");
  } finally {
    stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
