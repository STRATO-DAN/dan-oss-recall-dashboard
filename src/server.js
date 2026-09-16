// Real local HTTP server, stdlib only for the HTTP layer (the one real dependency, LanceDB, is used
// only inside memory.js). Loopback-only — but as of v0.2 loopback is NOT the trust decision: every
// privileged /api/ operation requires the instance bearer token (auth.js), is rate-limited and quota-
// bounded, and writes/deletes/auth-failures are audited (audit.js). Static assets stay open (they are
// not secret and the DNS-rebind guard + loopback bind already scope who can load them).
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore, QuotaError, ForbiddenError } from "./memory.js";
import { embeddingsConfigured } from "./embeddings.js";
import { PrincipalStore } from "./principals.js";
import { makeAudit } from "./audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { reject(new Error("request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, rel);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403).end("forbidden"); return; }
  try {
    const data = await fs.readFile(resolved);
    res.writeHead(200, { "content-type": MIME[path.extname(resolved)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

// 🔴 DNS-rebinding guard — refuse any request whose Host isn't loopback so a web page the user visits
// can't rebind a hostname to 127.0.0.1 and reach the API. (Belt-and-suspenders with the bearer token.)
function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  let host = String(hostHeader).trim().toLowerCase();
  if (host.startsWith("[")) {
    host = host.slice(1, host.indexOf("]"));
  } else {
    host = host.replace(/:\d+$/, "");
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// Fixed-window rate limiter. Single-principal tool, so one global window per limiter is the right shape.
// Exported (pure, no side effects beyond its own closure) so tests can exercise the window-boundary
// reset with a short, controllable windowMs, rather than a real 60s wait against the live server.
export function makeRateLimiter({ windowMs, max }) {
  let windowStart = Date.now();
  let count = 0;
  return () => {
    const now = Date.now();
    if (now - windowStart >= windowMs) { windowStart = now; count = 0; }
    count += 1;
    return count <= max;
  };
}

export function createServer({ dataDir }) {
  const store = new MemoryStore(dataDir);
  const ready = store.init();
  const principals = new PrincipalStore(dataDir).load();
  const audit = makeAudit(dataDir);
  const apiLimit = makeRateLimiter({ windowMs: 60_000, max: Number(process.env.RECALL_RATE_MAX) || 600 });
  const writeLimit = makeRateLimiter({ windowMs: 60_000, max: Number(process.env.RECALL_WRITE_MAX) || 120 });

  const server = http.createServer(async (req, res) => {
    await ready;
    const url = new URL(req.url, "http://127.0.0.1");
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const p = url.pathname;
    let principal = null;

    try {
      if (p.startsWith("/api/")) {
        // 🔴 AUTH (v0.3) — every privileged op resolves the caller's API key to a VERIFIED principal. Locality
        // is not identity, and neither is bare possession of one shared token — the server records WHICH one.
        principal = principals.authenticate(req);
        if (!principal) {
          audit({ action: "auth-failure", path: p, method: req.method });
          return sendJson(res, 401, { ok: false, reason: "unauthorized — missing or invalid API key" });
        }
        if (!apiLimit()) {
          return sendJson(res, 429, { ok: false, reason: "rate limit exceeded — slow down" });
        }
      }

      if (p === "/api/status" && req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          mode: embeddingsConfigured() ? "hybrid" : "bm25",
          count: store.list().length,
          dataDir,
          principal: { id: principal.id, name: principal.name, role: principal.role },
        });
      }

      // Admin-only principal management (v0.3) — mint/list/remove per-agent API keys.
      if (p === "/api/principals" && req.method === "GET") {
        if (!principals.isAdmin(principal)) return sendJson(res, 403, { ok: false, reason: "admin only" });
        return sendJson(res, 200, { ok: true, principals: principals.list() });
      }
      if (p === "/api/principals" && req.method === "POST") {
        if (!principals.isAdmin(principal)) return sendJson(res, 403, { ok: false, reason: "admin only" });
        const body = await readBody(req);
        try {
          const created = principals.create(body.name); // apiKey is in the response ONCE
          audit({ action: "principal-create", principal: principal.id, created: created.id, name: created.name });
          return sendJson(res, 201, { ok: true, principal: created });
        } catch (err) {
          return sendJson(res, 400, { ok: false, reason: err.message });
        }
      }
      const principalMatch = p.match(/^\/api\/principals\/([^/]+)$/);
      if (principalMatch && req.method === "DELETE") {
        if (!principals.isAdmin(principal)) return sendJson(res, 403, { ok: false, reason: "admin only" });
        const removed = principals.remove(principalMatch[1]);
        audit({ action: "principal-remove", principal: principal.id, removed: principalMatch[1], result: removed });
        return sendJson(res, removed ? 200 : 404, { ok: removed, reason: removed ? undefined : "no such principal" });
      }
      if (p === "/api/memories" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, memories: store.list() });
      }
      if (p === "/api/remember" && req.method === "POST") {
        if (!writeLimit()) {
          return sendJson(res, 429, { ok: false, reason: "write rate limit exceeded — slow down" });
        }
        const body = await readBody(req);
        const source = String(body.source || req.headers["x-recall-source"] || "").slice(0, 200);
        try {
          // provenance.principal is the VERIFIED caller — server-set, never from the body. The caller's own
          // `source` label is recorded separately and treated as untrusted.
          const memory = await store.remember(body.text, body.metadata || {}, { principal: principal.id, source });
          audit({ action: "remember", id: memory.id, principal: principal.id, source });
          return sendJson(res, 200, { ok: true, memory });
        } catch (err) {
          if (err instanceof QuotaError) {
            audit({ action: "remember-rejected", reason: "quota", principal: principal.id });
            return sendJson(res, 413, { ok: false, reason: err.message });
          }
          return sendJson(res, 200, { ok: false, reason: err.message });
        }
      }
      if (p === "/api/recall" && req.method === "GET") {
        const q = url.searchParams.get("q") || "";
        const k = Number(url.searchParams.get("k")) || 5;
        const minScoreParam = url.searchParams.get("minScore");
        const minScore = minScoreParam === null ? undefined : Number(minScoreParam);
        try {
          const result = await store.recall(q, k, minScore === undefined ? {} : { minScore });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendJson(res, 200, { ok: false, reason: err.message });
        }
      }
      const forgetMatch = p.match(/^\/api\/forget\/([^/]+)$/);
      if (forgetMatch && req.method === "DELETE") {
        try {
          // Owner-scoped delete — only the memory's creating principal, or an admin, may forget it.
          const removed = await store.forget(forgetMatch[1], {
            principal: principal.id,
            isAdmin: principals.isAdmin(principal),
          });
          audit({ action: "forget", id: forgetMatch[1], principal: principal.id, result: removed ? "removed" : "no-such-memory" });
          return sendJson(res, removed ? 200 : 404, { ok: removed, reason: removed ? undefined : "no such memory" });
        } catch (err) {
          if (err instanceof ForbiddenError) {
            audit({ action: "forget-denied", id: forgetMatch[1], principal: principal.id });
            return sendJson(res, 403, { ok: false, reason: err.message });
          }
          throw err;
        }
      }

      if (req.method === "GET" && !p.startsWith("/api/")) return serveStatic(res, p);
      res.writeHead(404).end("not found");
    } catch (err) {
      sendJson(res, 500, { ok: false, reason: err.message });
    }
  });

  server.recallToken = principals.adminKey; // the admin bootstrap key; the CLI prints it, tests read it
  server.principals = principals; // exposed for tests
  return server;
}

export function listen(port, dataDir) {
  const server = createServer({ dataDir });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
