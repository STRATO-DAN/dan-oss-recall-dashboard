// The launcher CLI is the only thing most operators ever touch, so its flag contract has to hold:
// --version / --help / --json / unknown-flag handling, plus the two startup failure paths (port in
// use, unusable data directory). These tests spawn the REAL bin as a child process and assert the
// exact stdout/stderr and exit codes it emits — deriving expectations from bin/dan-oss-recall-dashboard.js,
// not from assumption. No external deps: node:test, node:assert/strict, node:child_process only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/dan-oss-recall-dashboard.js", import.meta.url));
const PKG = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);
const VERSION = PKG.version;

const PORT_ENV = "DAN_OSS_RECALL_DASHBOARD_PORT";
const DATA_ENV = "DAN_OSS_RECALL_DASHBOARD_DATA";

function mkdata() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "recall-bin-"));
}

// Run the bin for a case where it is expected to exit on its own; resolve with the captured streams.
function runToExit(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// Run the bin for the --json banner case: it starts a server and does NOT exit on its own, so read
// stdout until the first complete line arrives, then kill the child.
function runForJsonLine(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "--json"], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolve({ stdout, stderr });
    };
    child.stdout.on("data", (c) => {
      stdout += c;
      if (stdout.includes("\n")) finish();
    });
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", () => finish());
    setTimeout(() => reject(new Error("timed out waiting for --json banner")), 10000).unref();
  });
}

// A one-line, no-stack-trace error message: exactly one non-empty line, tagged, no raw "  at " frames.
function assertCleanErrorLine(stderr) {
  const lines = stderr.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1, `expected a single stderr line, got: ${JSON.stringify(stderr)}`);
  assert.match(lines[0], /^\[DAN] RECALL DASHBOARD: /);
  assert.doesNotMatch(stderr, /\n\s+at /, "stderr must not contain a raw stack trace");
}

test("--version prints the package version and exits 0", async () => {
  const { code, stdout, stderr } = await runToExit(["--version"]);
  assert.equal(code, 0);
  assert.equal(stdout, VERSION + "\n");
  assert.equal(stderr, "");
});

test("-v is an alias for --version", async () => {
  const { code, stdout } = await runToExit(["-v"]);
  assert.equal(code, 0);
  assert.equal(stdout, VERSION + "\n");
});

test("--help prints usage (with the version) and exits 0", async () => {
  const { code, stdout, stderr } = await runToExit(["--help"]);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.ok(
    stdout.includes(`RECALL DASHBOARD v${VERSION}`),
    `help banner should include "RECALL DASHBOARD v${VERSION}"`,
  );
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /--version/);
  assert.match(stdout, /--help/);
  assert.match(stdout, /--json/);
});

test("-h is an alias for --help", async () => {
  const { code, stdout } = await runToExit(["-h"]);
  assert.equal(code, 0);
  assert.match(stdout, /Usage:/);
});

test("an unknown flag is a usage error: exit 2, one-line stderr, no output on stdout", async () => {
  const { code, stdout, stderr } = await runToExit(["--nope"]);
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /unknown option '--nope'/);
  assertCleanErrorLine(stderr);
});

test("--json on an ephemeral port prints exactly one JSON banner with the real bound port", async () => {
  const dataDir = mkdata();
  try {
    const { stdout } = await runForJsonLine({ [PORT_ENV]: "0", [DATA_ENV]: dataDir });
    // Exactly ONE JSON object on stdout: one line, and it parses.
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1, `expected one banner line, got: ${JSON.stringify(stdout)}`);
    const banner = JSON.parse(lines[0]);

    // The exact shape the bin emits — no more, no less.
    assert.deepEqual(Object.keys(banner).sort(), ["dataDir", "mode", "port", "principal", "url"]);

    // The port is a real OS-assigned ephemeral port (not the 4872 default, not 0).
    assert.equal(typeof banner.port, "number");
    assert.ok(Number.isInteger(banner.port) && banner.port > 0 && banner.port !== 4872);

    // url carries the bound port and a token query param on loopback.
    assert.ok(banner.url.startsWith(`http://127.0.0.1:${banner.port}/?token=`));
    assert.equal(banner.mode, "bm25"); // no OPENAI_API_KEY in the test env
    assert.equal(banner.dataDir, dataDir);
    assert.equal(banner.principal, "admin");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a port already in use is a startup failure: exit 1, one-line stderr, no stack", async () => {
  const dataDir = mkdata();
  const blocker = http.createServer((_req, res) => res.end());
  try {
    const port = await new Promise((resolve) =>
      blocker.listen(0, "127.0.0.1", () => resolve(blocker.address().port)),
    );
    const { code, stdout, stderr } = await runToExit([], {
      [PORT_ENV]: String(port),
      [DATA_ENV]: dataDir,
    });
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.ok(stderr.includes(`port ${port} is already in use`), `stderr should report port ${port} in use`);
    assertCleanErrorLine(stderr);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an unusable data directory is a startup failure: exit 1, one-line stderr, no stack", async () => {
  // Point the data dir at a path UNDER a regular file, so mkdir cannot create it (ENOTDIR).
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "recall-bin-")), "not-a-dir");
  fs.writeFileSync(file, "x");
  const badDataDir = path.join(file, "sub");
  try {
    const { code, stdout, stderr } = await runToExit([], {
      [PORT_ENV]: "0",
      [DATA_ENV]: badDataDir,
    });
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assertCleanErrorLine(stderr);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
