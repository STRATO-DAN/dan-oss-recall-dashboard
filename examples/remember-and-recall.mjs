// Real, runnable example — uses MemoryStore directly, no server, no UI.
//
//   node examples/remember-and-recall.mjs
//
// Runs in real BM25 mode unless OPENAI_API_KEY is set in your environment, in which case it uses
// real hybrid (BM25 + semantic) recall instead — same honest, never-blended distinction the
// server itself makes (see MemoryStore.recall's own `mode` field in the result).
import { MemoryStore } from "../src/memory.js";
import { embeddingsConfigured } from "../src/embeddings.js";
import { fileURLToPath } from "node:url";

// fileURLToPath (not .pathname) so a real filesystem path with spaces (e.g. "/Users/me/My Projects/…")
// is decoded correctly instead of arriving URL-encoded (%20) and pointing at a path that doesn't exist.
const dataDir = fileURLToPath(new URL("./example-data", import.meta.url));
const store = new MemoryStore(dataDir);
await store.init();

console.log(`Mode: ${embeddingsConfigured() ? "hybrid (OPENAI_API_KEY set)" : "bm25 (no key set)"}`);

await store.remember("the deploy key rotates every 90 days");
await store.remember("the staging database is a nightly snapshot of production");
await store.remember("Ada Lovelace wrote the first published algorithm");

const results = await store.recall("deploy key");
console.log(`\nrecall("deploy key") -> mode: ${results.mode}`);
for (const r of results.results) {
  console.log(`  [${r.score?.toFixed(3) ?? "n/a"}] ${r.text}`);
}

console.log("\nSame store, a different query:");
const second = await store.recall("Ada Lovelace");
console.log(`recall("Ada Lovelace") -> mode: ${second.mode}, ${second.results.length} match(es)`);
