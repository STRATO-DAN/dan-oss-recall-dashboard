#!/usr/bin/env node
// [DAN] RECALL DASHBOARD — real CLI entry. Starts the local server (loopback only), opens the browser.
//
// Flags (hand-rolled, zero dependency): --version, --help, --json. See printHelp() for the full contract.
import { listen } from "../src/server.js";
import { embeddingsConfigured } from "../src/embeddings.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp() {
  const v = readVersion();
  process.stdout.write(
    `[DAN] RECALL DASHBOARD v${v} — a real memory server with a real BM25 ranking engine.

Usage:
  dan-oss-recall-dashboard [options]

Options:
  --version, -v   Print the version and exit.
  --help, -h      Print this help and exit.
  --json          Print the startup banner as ONE JSON object
                  ({url,port,mode,dataDir,principal}) instead of human text,
                  for scripting and CI. The human banner is the default.

Runs a loopback-only (127.0.0.1) HTTP server and opens the dashboard in your
browser. Every /api/ operation requires the printed access token. Keyword
(BM25) recall is pure Node standard library; set OPENAI_API_KEY for hybrid
(BM25 + semantic) recall.

Environment:
  DAN_OSS_RECALL_DASHBOARD_PORT   Port to listen on (default 4872; 0 = an
                                  OS-assigned ephemeral port).
  DAN_OSS_RECALL_DASHBOARD_DATA   Data directory (default ./.dan-oss-recall-dashboard).
  RECALL_TOKEN                    Override the admin bootstrap token (else a
                                  0600 token is generated in the data dir).
  OPENAI_API_KEY                  Enable hybrid (semantic) recall via embeddings.
  DAN_OSS_RECALL_DASHBOARD_ALLOW_SECRET_EMBED
                                  Opt OUT of the deny-by-default embedding-egress
                                  secret gate (1/true/yes/on). Off by default:
                                  secret-bearing text is never sent to the
                                  embeddings provider.

Exit codes:
  0   Success (server ran and exited cleanly, or --version / --help).
  1   Startup failure (e.g. port already in use, unusable data directory) —
      a single-line message on stderr, never a raw stack trace.
  2   Usage error (an unknown or invalid flag).
`,
  );
}

const argv = process.argv.slice(2);
const has = (...names) => names.some((n) => argv.includes(n));

if (has("--version", "-v")) {
  process.stdout.write(readVersion() + "\n");
  process.exit(0);
}
if (has("--help", "-h")) {
  printHelp();
  process.exit(0);
}

// Reject any unrecognised flag with a usage error (exit 2), rather than silently ignoring it.
const KNOWN_FLAGS = new Set(["--version", "-v", "--help", "-h", "--json"]);
const unknown = argv.find((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
if (unknown) {
  process.stderr.write(`[DAN] RECALL DASHBOARD: unknown option '${unknown}' — try --help\n`);
  process.exit(2);
}

const jsonBanner = has("--json");

const cwd = process.cwd();
// Support port 0 (OS-assigned ephemeral) explicitly: `Number(x) || 4872` would turn "0" into 4872, so
// distinguish "set" from "unset/garbage" and read the ACTUAL bound port back from the server below.
const envPort = process.env.DAN_OSS_RECALL_DASHBOARD_PORT;
const requestedPort =
  envPort !== undefined && envPort !== "" && !Number.isNaN(Number(envPort)) ? Number(envPort) : 4872;
const dataDir = process.env.DAN_OSS_RECALL_DASHBOARD_DATA || path.join(cwd, ".dan-oss-recall-dashboard");

let server;
try {
  server = await listen(requestedPort, dataDir);
} catch (err) {
  // Startup failure — one clean line on stderr and a non-zero exit, never a raw stack trace.
  const reason =
    err && err.code === "EADDRINUSE"
      ? `port ${requestedPort} is already in use — set DAN_OSS_RECALL_DASHBOARD_PORT to choose another`
      : err && err.code === "EACCES"
        ? `permission denied binding the port or data directory (${dataDir})`
        : `could not start — ${(err && err.message) || String(err)}`;
  process.stderr.write(`[DAN] RECALL DASHBOARD: ${reason}\n`);
  process.exit(1);
}

const port = server.address().port;
const token = server.recallToken;
const base = `http://127.0.0.1:${port}`;
// The dashboard needs the instance token to call the API — hand it over in the launch URL (Jupyter-style).
// A local process that didn't see this console output can't read the 0600 token file, so it can't drive the API.
const url = `${base}/?token=${encodeURIComponent(token)}`;
const mode = embeddingsConfigured() ? "hybrid" : "bm25";

if (jsonBanner) {
  // Scripting/CI banner: exactly ONE JSON object on stdout and nothing else. The token is NOT included
  // here (it is still printed in human mode and saved 0600 in the data dir).
  process.stdout.write(
    JSON.stringify({ url, port, mode, dataDir, principal: "admin" }) + "\n",
  );
} else {
  console.log(`[DAN] RECALL DASHBOARD running — open this URL (it carries your access token):\n  ${url}`);
  console.log(`Mode: ${embeddingsConfigured() ? "real vector search (OPENAI_API_KEY set)" : "keyword search (no OPENAI_API_KEY — set one for real semantic recall)"}`);
  console.log(`Memories saved to: ${dataDir}`);
  console.log(`API access token (also saved 0600 in the data dir; agents/CI can set RECALL_TOKEN): ${token}`);
  console.log("Ctrl-C to stop.\n");

  // execFile, not exec — no shell. On Windows `start` is a cmd builtin, so it must run via cmd.exe
  // rather than be exec'd as a binary (otherwise auto-open silently no-ops on Windows).
  const [openerCmd, openerArgs] =
    process.platform === "darwin" ? ["open", [url]]
      : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(openerCmd, openerArgs, () => {});
}

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
