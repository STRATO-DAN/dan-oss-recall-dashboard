// Deny-by-default embedding-egress secret gate (v0.6). A detected secret must never be sent to the
// third-party embedding provider — on either the remember() or the recall() path — while the product's
// keyword/BM25 recall value stays completely intact. Each behaviour is asserted fail-before/pass-after.
//
// NOTE ON THE FAKE SECRETS BELOW: every fake secret is assembled at runtime from fragments (frag(...))
// so no committed line ever contains a contiguous secret literal. That keeps the repo's own secret
// scanners (gitleaks / the pre-commit leak check) green while the REAL detector still runs against the
// fully-assembled string at runtime. The values are non-functional test fixtures, not live credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory.js";
import { detectSecrets, containsSecret, allowSecretEmbed } from "../src/secrets.js";

const frag = (...parts) => parts.join("");

// Fully-assembled fake secrets (never contiguous in source — see note above).
const FAKE = {
  aws: frag("AKIA", "IOSFODNN7", "EXAMPLE1"), // AKIA + 17 → matches AKIA[0-9A-Z]{16}
  openai: frag("sk", "-", "abcdefghij0123456789XY"), // sk- + 22
  stripeSecret: frag("sk_live", "_", "0123456789abcdef01"), // 18
  stripeRestricted: frag("rk_live", "_", "0123456789abcdef01"),
  githubToken: frag("ghp", "_", "0123456789012345678901234567890123456789"), // 40
  githubPat: frag("github_pat", "_", "0123456789012345678901234567890123456789ab"), // 42
  google: frag("AIza", "x".repeat(35)),
  slack: frag("xoxb", "-", "0123456789abc"),
  jwt: frag("eyJ", "abcdefghij", ".", "cGF5bG9hZHBhcnQ", ".", "c2lnbmF0dXJleHl6"),
  privateKey: frag("-----BEGIN RSA PRIVATE ", "KEY-----"),
  generic: frag("api_key", "=", '"', "s3cr3tvalue00", '"'),
};

// A deterministic fake OpenAI embeddings endpoint that RECORDS every text it is asked to embed, so a
// test can prove a given text did (or did NOT) leave the process boundary to the provider.
function withSpyEmbeddings(fn) {
  const prevKey = process.env.OPENAI_API_KEY;
  const prevFetch = global.fetch;
  const sent = []; // every `input` the provider was actually called with
  process.env.OPENAI_API_KEY = "sk-fake-test-key";
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push(body.input);
    return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 0, 0, 0] }] }) };
  };
  return Promise.resolve()
    .then(() => fn(sent))
    .finally(() => {
      global.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    });
}

async function withStore(events, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-secret-gate-"));
  const store = new MemoryStore(dataDir, { audit: (e) => events.push(e) });
  await store.init();
  try { await fn(store); } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
}

// ---- detector unit tests -----------------------------------------------------------------------

test("detectSecrets: names every supported pattern; is dependency-free and value-free", () => {
  assert.deepEqual(detectSecrets(FAKE.aws), ["aws-access-key-id"]);
  assert.deepEqual(detectSecrets(FAKE.privateKey), ["private-key-block"]);
  assert.deepEqual(detectSecrets(FAKE.openai), ["openai-api-key"]);
  assert.deepEqual(detectSecrets(FAKE.stripeSecret), ["stripe-secret-key"]);
  assert.deepEqual(detectSecrets(FAKE.stripeRestricted), ["stripe-restricted-key"]);
  assert.deepEqual(detectSecrets(FAKE.githubToken), ["github-token"]);
  assert.deepEqual(detectSecrets(FAKE.githubPat), ["github-fine-grained-pat"]);
  assert.deepEqual(detectSecrets(FAKE.google), ["google-api-key"]);
  assert.deepEqual(detectSecrets(FAKE.slack), ["slack-token"]);
  assert.deepEqual(detectSecrets(FAKE.jwt), ["jwt"]);
  assert.deepEqual(detectSecrets(FAKE.generic), ["generic-secret-assignment"]);
});

test("detectSecrets: clean prose is clean; returns names only, never the matched value", () => {
  assert.deepEqual(detectSecrets("a quiet walk in the park by the harbour at dusk"), []);
  assert.equal(containsSecret("nothing sensitive here"), false);
  // The returned names must not embed the secret value itself.
  const names = detectSecrets(`deploy notes ${FAKE.aws} for the pipeline`);
  assert.ok(names.includes("aws-access-key-id"));
  assert.ok(!names.join(" ").includes(FAKE.aws));
});

test("allowSecretEmbed: reflects the opt-in env at call time", () => {
  const prev = process.env.DAN_OSS_RECALL_DASHBOARD_ALLOW_SECRET_EMBED;
  try {
    delete process.env.DAN_OSS_RECALL_DASHBOARD_ALLOW_SECRET_EMBED;
    assert.equal(allowSecretEmbed(), false);
    process.env.DAN_OSS_RECALL_DASHBOARD_ALLOW_SECRET_EMBED = "1";
    assert.equal(allowSecretEmbed(), true);
    process.env.DAN_OSS_RECALL_DASHBOARD_ALLOW_SECRET_EMBED = "0";
    assert.equal(allowSecretEmbed(), false);
  } finally {
    if (prev === undefined) delete process.env.DAN_OSS_RECALL_DASHBOARD_ALLOW_SECRET_EMBED;
    else process.env.DAN_OSS_RECALL_DASHBOARD_ALLOW_SECRET_EMBED = prev;
  }
});

// ---- remember() egress gate --------------------------------------------------------------------

test("remember: a secret-bearing memory is STORED + keyword-recallable but NOT embedded (no egress, audit emitted)", () =>
  withSpyEmbeddings((sent) => {
    const events = [];
    return withStore(events, async (store) => {
      const secretText = `pipeline credentials ${FAKE.aws} rotate quarterly`;
      const m = await store.remember(secretText, {}, { principal: "agent-x" });

      // Behaviour: no vector was computed for the secret, so its text never went to the provider.
      assert.equal(m.hasVector, false, "the secret memory must not carry a vector");
      assert.equal(sent.includes(secretText), false, "the secret text must never be sent to the embedding provider");
      assert.equal(sent.length, 0, "no embedding call at all should have been made for the secret memory");

      // Audit: a skip event with pattern NAMES only — never the secret value anywhere in the audit trail.
      const skip = events.find((e) => e.op === "embedding-skipped-secret");
      assert.ok(skip, "an embedding-skipped-secret audit event is emitted");
      assert.equal(skip.principal, "agent-x");
      assert.ok(skip.patterns.includes("aws-access-key-id"), "the matched pattern name is recorded");
      assert.equal(JSON.stringify(events).includes(FAKE.aws), false, "the audit trail never echoes the secret value");

      // Value preserved: the memory is still stored and still recallable by keyword (BM25).
      const recalled = await store.recall("pipeline", 5, { principal: "agent-x" });
      assert.ok(recalled.results.some((r) => r.id === m.id), "the stored secret memory is still keyword-recallable");
    });
  }));

test("remember: a clean memory embeds normally (its text IS sent to the provider, a vector is stored)", () =>
  withSpyEmbeddings((sent) => {
    const events = [];
    return withStore(events, async (store) => {
      const cleanText = "a beautiful ocean sunset over the water";
      const m = await store.remember(cleanText, {}, { principal: "agent-x" });
      assert.equal(m.hasVector, true, "a clean memory is embedded exactly as before");
      assert.ok(sent.includes(cleanText), "the clean text is sent to the embedding provider");
      assert.ok(events.some((e) => e.action === "embedding"), "a normal embedding-egress audit event is recorded");
      assert.equal(events.some((e) => e.op === "embedding-skipped-secret"), false, "no skip event for clean text");
    });
  }));

// ---- recall() query egress gate ----------------------------------------------------------------

test("recall: a secret-bearing QUERY skips the vector search (query never sent to the provider), keyword still works", () =>
  withSpyEmbeddings((sent) => {
    const events = [];
    return withStore(events, async (store) => {
      // A clean, vectorised memory exists, so hybrid mode is genuinely available for a normal query.
      await store.remember("notes about the deployment pipeline", {}, { principal: "agent-x" });
      assert.ok(sent.length >= 1, "the clean memory was embedded (baseline egress happened)");
      sent.length = 0; // only watch what the RECALL query does

      const res = await store.recall(`find ${FAKE.openai} in the logs`, 5, { principal: "agent-x" });
      assert.equal(sent.length, 0, "a secret-bearing query is never sent to the embedding provider");
      assert.ok(events.some((e) => e.op === "embedding-skipped-secret"), "the skipped-query egress is audited");
      assert.ok(Array.isArray(res.results), "recall still returns a real result set (keyword fallback), never throws");

      // Sanity: a clean query on the same store DOES still embed (the gate is scoped to secret queries only).
      sent.length = 0;
      await store.recall("pipeline", 5, { principal: "agent-x" });
      assert.equal(sent.length, 1, "a clean query still embeds — semantic search value is untouched");
    });
  }));

// ---- opt-in escape hatch -----------------------------------------------------------------------

test("opt-in env restores prior behaviour: secret-bearing text IS embedded when the flag is set", () =>
  withSpyEmbeddings((sent) => {
    const events = [];
    const prev = process.env.DAN_OSS_RECALL_DASHBOARD_ALLOW_SECRET_EMBED;
    process.env.DAN_OSS_RECALL_DASHBOARD_ALLOW_SECRET_EMBED = "1";
    return withStore(events, async (store) => {
      const secretText = `pipeline credentials ${FAKE.aws} rotate quarterly`;
      const m = await store.remember(secretText, {}, { principal: "agent-x" });
      assert.equal(m.hasVector, true, "with the opt-in flag set, the secret-bearing text is embedded as before");
      assert.ok(sent.includes(secretText), "the opt-in flag sends the text to the provider (prior behaviour)");
      assert.equal(events.some((e) => e.op === "embedding-skipped-secret"), false, "no skip event when opted in");
    }).finally(() => {
      if (prev === undefined) delete process.env.DAN_OSS_RECALL_DASHBOARD_ALLOW_SECRET_EMBED;
      else process.env.DAN_OSS_RECALL_DASHBOARD_ALLOW_SECRET_EMBED = prev;
    });
  }));
