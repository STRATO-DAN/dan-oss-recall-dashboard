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
const url = `http://127.0.0.1:${port}`;

console.log(`[DAN] RECALL DASHBOARD running at ${url}`);
console.log(`Mode: ${embeddingsConfigured() ? "real vector search (OPENAI_API_KEY set)" : "keyword search (no OPENAI_API_KEY — set one for real semantic recall)"}`);
console.log(`Memories saved to: ${dataDir}`);
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
