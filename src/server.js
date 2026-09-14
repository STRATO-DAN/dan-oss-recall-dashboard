// Real local HTTP server, stdlib only for the HTTP layer (the one real dependency, LanceDB, is
// used only inside memory.js). Loopback-only, same reasoning as every other DAN-OSS tool: this
// reads/stores real memories that never need to be reachable off the local machine.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "./memory.js";
import { embeddingsConfigured } from "./embeddings.js";

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

// 🔴 DNS-rebinding guard — loopback-only dashboard over stored memories; refuse any request whose Host isn't
// loopback so a web page the user visits can't rebind a hostname to 127.0.0.1 and read/write their memories.
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

export function createServer({ dataDir }) {
  const store = new MemoryStore(dataDir);
  const ready = store.init();

  return http.createServer(async (req, res) => {
    await ready;
    const url = new URL(req.url, "http://127.0.0.1");
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const p = url.pathname;

    try {
      if (p === "/api/status" && req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          mode: embeddingsConfigured() ? "hybrid" : "bm25",
          count: store.list().length,
          dataDir,
        });
      }
      if (p === "/api/memories" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, memories: store.list() });
      }
      if (p === "/api/remember" && req.method === "POST") {
        const body = await readBody(req);
        try {
          const memory = await store.remember(body.text, body.metadata || {});
          return sendJson(res, 200, { ok: true, memory });
        } catch (err) {
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
        const removed = await store.forget(forgetMatch[1]);
        return sendJson(res, removed ? 200 : 404, { ok: removed, reason: removed ? undefined : "no such memory" });
      }

      if (req.method === "GET") return serveStatic(res, p);
      res.writeHead(404).end("not found");
    } catch (err) {
      sendJson(res, 500, { ok: false, reason: err.message });
    }
  });
}

export function listen(port, dataDir) {
  const server = createServer({ dataDir });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
