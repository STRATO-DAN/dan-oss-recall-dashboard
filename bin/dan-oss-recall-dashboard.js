#!/usr/bin/env node
// [DAN] RECALL DASHBOARD — real CLI entry. Starts the local server (loopback only), opens the browser.
import { listen } from "../src/server.js";
import { embeddingsConfigured } from "../src/embeddings.js";
import { execFile } from "node:child_process";
import path from "node:path";

const cwd = process.cwd();
const port = Number(process.env.DAN_OSS_RECALL_DASHBOARD_PORT) || 4872;
const dataDir = process.env.DAN_OSS_RECALL_DASHBOARD_DATA || path.join(cwd, ".dan-oss-recall-dashboard");

const server = await listen(port, dataDir);
const token = server.recallToken;
const base = `http://127.0.0.1:${port}`;
// The dashboard needs the instance token to call the API — hand it over in the launch URL (Jupyter-style).
// A local process that didn't see this console output can't read the 0600 token file, so it can't drive the API.
const url = `${base}/?token=${encodeURIComponent(token)}`;

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

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
