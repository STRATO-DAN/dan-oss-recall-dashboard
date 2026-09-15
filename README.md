<div align="center">

<img src="assets/dan-mark.svg" alt="[DAN] RECALL DASHBOARD" width="84" height="84">

# [DAN] RECALL DASHBOARD

**A real memory server with a real ranking engine — recall scored by relevance, not a raw dump.**

[![CI](https://github.com/STRATO-DAN/dan-oss-recall-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/STRATO-DAN/dan-oss-recall-dashboard/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@strato-dan/recall-dashboard.svg)](https://www.npmjs.com/package/@strato-dan/recall-dashboard)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-2e9e56.svg)](#dependencies)
[![docs](https://img.shields.io/badge/docs-README-blue.svg)](#use)
[![license](https://img.shields.io/badge/license-MIT-informational.svg)](LICENSE)

</div>

> **⚡ One install, then direct use — on any platform.** `npx @strato-dan/recall-dashboard` runs the
> full app; keyword (BM25) recall is pure Node standard library. Semantic **hybrid** mode needs no
> second step: LanceDB auto-installs when your platform supports it, and an exact pure-JS vector
> engine takes over automatically if it can't — so hybrid works out of the box either way (it just
> needs your own `OPENAI_API_KEY` for the embeddings). Full breakdown under [Dependencies](#dependencies).

Remember. Recall. Forget.

A real memory server with a real ranking engine — every recall is scored and sorted by actual
relevance (BM25, the same real ranking algorithm family Lucene/Elasticsearch use), not a raw,
unordered dump of substring matches. Add an OpenAI key and it becomes a real hybrid search
(lexical + semantic, fused by Reciprocal Rank Fusion) for when a query paraphrases a memory
instead of sharing its words — never pretending the two are the same thing.

**Disclosure**: when `OPENAI_API_KEY` is set, the text you store via Remember is sent to OpenAI's
embeddings API (`api.openai.com`) to generate its vector — using your own key, your own OpenAI
account. With no key set, nothing ever leaves your machine; recall runs entirely on the local BM25
engine.

## Use

```bash
npx @strato-dan/recall-dashboard
```

Opens at `http://127.0.0.1:4872` (loopback only). Type something into **Remember**, then search
for it in **Recall**.

```bash
curl -X POST http://127.0.0.1:4872/api/remember -H 'content-type: application/json' \
  -d '{"text":"the deploy key rotates every 90 days"}'
curl 'http://127.0.0.1:4872/api/recall?q=deploy%20key'
```

## Two real modes, never blended

| | Not set | Set `OPENAI_API_KEY` |
|---|---|---|
| **Storage** | Text only | Text + a real embedding vector ([LanceDB](https://github.com/lancedb/lance), Apache-2.0) |
| **Recall** | Real BM25 ranking (lexical relevance) | BM25 + semantic similarity, fused by real Reciprocal Rank Fusion |
| Response's own `mode` field | `"bm25"` | `"hybrid"` |

If a memory was stored before a key was ever set, it simply has no vector — recall still finds it
via BM25. Nothing is silently re-embedded or upgraded behind your back.

```bash
export OPENAI_API_KEY=sk-...
```

## The real ranking engine (not a raw dump)

Every recall computes a genuine relevance score per memory — never an unordered list of "things
that happened to match."

- **BM25** (`src/bm25.js`, always on): the same real, standard ranking function family
  Lucene/Elasticsearch use — real term-frequency and inverse-document-frequency math over your
  actual stored memories, zero dependencies, zero model, zero external call. A memory sharing no
  term with the query scores exactly `0` and is never returned — a real, corpus-derived relevance
  floor, not "return everything." Real, tunable stricter cutoff via `?minScore=` on `/api/recall`.
- **Hybrid** (`src/memory.js`, when a key is set): BM25's own ranking combined with LanceDB's real
  vector-similarity ranking via **Reciprocal Rank Fusion** — the same real technique
  Elasticsearch's own hybrid search uses to combine two differently-scaled rankings, rather than
  inventing an arbitrary weighted blend of two scores that don't share a scale.

**Real, measured accuracy** — [`examples/measure-recall-accuracy.mjs`](examples/measure-recall-accuracy.mjs)
runs a real 10-memory corpus against 5 exact-term queries and 5 deliberately-paraphrased queries
(same fact, different words) and reports real top-1 accuracy for each, separately. It needs no
install and no key. The numbers below are the actual, unedited headline output of a real BM25-only
run (Node 22, no `OPENAI_API_KEY`); the script also prints a per-query hit/miss breakdown:

```console
$ node examples/measure-recall-accuracy.mjs
Mode: bm25 (no OPENAI_API_KEY set)
Corpus: 10 real memories, 5 exact queries, 5 paraphrased queries.

EXACT queries — top-1 accuracy: 5/5 (100.0%)
PARAPHRASED queries — top-1 accuracy: 1/5 (20.0%)

Summary: exact 100.0% · paraphrase 20.0%
```

That gap is the real, honest reason hybrid mode exists: BM25 alone is excellent when a query
shares real words with the memory, and genuinely weak when it doesn't — a well-documented,
general tradeoff in lexical vs. semantic retrieval, not unique to this tool. Run the script
yourself (with and without `OPENAI_API_KEY` set) to see the numbers on your own machine, not just
take them asserted here.

## When to use this

- **Best fit — exact/lexical recall.** You're storing notes, facts, or snippets you'll search for
  by the words actually in them ("deploy key", "staging database") — BM25's real strength, and the
  default, zero-setup mode.
- **Best fit — stdlib-only, zero-model self-hosting.** The default BM25 recall path runs on Node's
  standard library alone: no embedding model to download or run. This repo's tests and examples run
  against an empty `node_modules`, and keyword recall never needs anything beyond Node itself.
  Leave the key unset and BM25 is pure arithmetic over your own text.
- **Optional — better paraphrase recall.** Set `OPENAI_API_KEY` and hybrid (BM25 + real semantic
  search, fused by Reciprocal Rank Fusion) activates — no second install. The vector search uses
  LanceDB (auto-installed for your platform) when available, and an exact pure-JS cosine engine
  automatically when it isn't, so hybrid works out of the box on any platform. Never forced, never
  silently assumed — every response's own `mode` field says which one actually answered.

**Honest flip side**: if your primary need is strong semantic/paraphrase recall — finding a memory
from a query that shares few or no words with it — this tool's own measured 20% top-1 accuracy on
paraphrased queries (BM25-only) is genuinely weak for that use case. Turning on hybrid mode helps,
but this tool wasn't built to be a general-purpose semantic search engine; if that's your primary
requirement rather than a nice-to-have on top of solid lexical recall, a dedicated vector-search
tool built around a real embedding model as its core feature (not an opt-in enhancement) is
probably the better fit.

## Two vector engines, one install, no choice to make

Hybrid mode's semantic search never needs a second install, and never breaks on an unusual
platform, because it has two engines and picks the right one for you automatically:

- **LanceDB (preferred, robust).** Declared as an **optional dependency**, so `npm install` / `npx`
  auto-fetches the prebuilt native package for your OS and hardware in the same single install —
  no separate step. It's the indexed, scales-well path.
- **Pure-JS cosine (automatic fallback).** If LanceDB can't install or load on your platform (an
  OS with no prebuilt binary, a locked-down build environment), the install still succeeds — an
  optional dependency that fails never aborts `npm install` — and the tool computes vector
  similarity in plain JavaScript over the same stored vectors instead. Exact results, zero
  dependency, no user action.

Either way hybrid works the moment you set `OPENAI_API_KEY` (embeddings come from OpenAI's API).
`src/memory.js` loads LanceDB dynamically and falls back on any load/runtime error; keyword (BM25)
recall never touches either vector engine.

**Why LanceDB is pinned to `0.30.0`** (not the latest): later versions (0.30.1+) added an optional
local-embedding feature that pulls in `@huggingface/transformers` → a vulnerable version of `sharp`
(high-severity CVEs in its bundled `libvips`/`libheif`). This tool never uses that feature — it
calls OpenAI's embeddings API directly — so `0.30.0` gives the exact functionality it needs
(connect, create table, vector search, delete) without dragging in that chain.

## What it never does

- Never listens on anything but `127.0.0.1`.
- Never fabricates a "semantic" result when running in BM25-only mode — the response says which
  mode answered.
- Never returns a memory that shares zero real terms with the query in BM25 mode — a real
  corpus-derived floor (score `0`), not an arbitrary cutoff.
- Never loses a memory to a crash mid-save — the sidecar file is written atomically.

## Examples

[`examples/remember-and-recall.mjs`](examples/remember-and-recall.mjs) uses `MemoryStore`
directly — no server, no UI — and runs in whichever real mode your environment is actually
configured for:

```bash
node examples/remember-and-recall.mjs
```

[`examples/measure-recall-accuracy.mjs`](examples/measure-recall-accuracy.mjs) is the real
accuracy measurement referenced above — run it yourself:

```bash
node examples/measure-recall-accuracy.mjs
```

## Tests

The test suite is Node's own built-in runner (`node --test`) — no test framework, and no
`npm install` needed to run it. From a fresh clone, on Node ≥18:

```console
$ npm test
...
# tests 20
# pass 20
# fail 0
```

20 tests pass — 8 BM25-engine unit tests (`test/bm25.test.mjs`), 7 `MemoryStore` integration tests
(`test/memory.test.mjs`), and 5 pure-JS vector-engine tests (`test/vector-fallback.test.mjs`,
covering the cosine fallback) — all with no key, no network, and no LanceDB installed.

## Dependencies

**Required runtime dependencies: 0.** One install, then direct use — hybrid mode needs no second step.

| | |
|---|---|
| **Required runtime dependencies** | **0** — keyword (BM25) recall and the whole UI are pure Node standard library |
| **Optional (auto, hybrid mode)** | `@lancedb/lancedb@0.30.0` — auto-installed for your platform in the same `npx` / `npm install`. If it can't build on your platform the install still succeeds and an exact pure-JS cosine engine takes over automatically. Pinned deliberately (see [Two vector engines](#two-vector-engines-one-install-no-choice-to-make)). |
| **Install to run** | none beyond the single `npx @strato-dan/recall-dashboard` |
| **Install to test** | none — `npm test` uses Node's built-in test runner |
| **Hybrid mode needs** | your own `OPENAI_API_KEY` (configuration, not a package) |
| **Node** | ≥ 18 |
| **Dev-only** | `husky` — only if you clone to contribute |

## Project contents

| Path | What it is |
|---|---|
| `bin/dan-oss-recall-dashboard.js` | The real CLI entry point — starts the server, opens the UI. |
| `src/server.js` | The loopback-only HTTP server: `/api/remember`, `/api/recall`, `/api/forget`. |
| `src/memory.js` | `MemoryStore` — the real store + ranking: BM25 always, plus the hybrid vector path (LanceDB when available, else the exact pure-JS cosine fallback). The JSON sidecar is the source of truth for both content and vectors. |
| `src/bm25.js` | The real BM25 ranking engine — tokenizing, corpus stats, scoring, search. Zero dependencies. |
| `src/embeddings.js` | The one real external call this tool makes, to OpenAI's embeddings API. |
| `public/` | The plain HTML/CSS/vanilla-JS Remember/Recall/Forget UI. |
| `examples/` | Runnable example code — `MemoryStore` usage and the real accuracy measurement. |
| `test/` | Real unit + integration tests (`npm test`, Node's own built-in test runner). |

## FAQ

**Does BM25 do any stemming or synonym matching?** No — tokenizing is deliberately simple
(lowercase, split on non-alphanumeric characters), with no stemming and no stopword removal. A
query for "rotating" won't match a stored "rotates" on lexical grounds alone. This is a real,
current, disclosed limitation, not a hidden gap — it's exactly the class of miss hybrid mode's
semantic side is there to catch.

**What happens to my vector-mode memories if I unset `OPENAI_API_KEY` later?** They're still
found — by BM25, on their text. The vector itself just stops being used for ranking until a key
is set again; nothing is deleted or re-processed automatically.

**Can I switch a specific memory from BM25-only to hybrid after the fact?** Not directly today —
`remember()` decides whether that memory gets a vector at the moment it's stored. Re-`remember`-ing
the same text with a key set creates a new, separately-vectored memory rather than upgrading the
old one in place. It's still found either way — BM25 ranks every memory regardless of whether it
has a vector.

**How is the hybrid score combined — is it just BM25 score plus vector similarity?** No — the two
scores are on entirely different, incomparable scales, so combining them by magnitude would need
an arbitrary weight nobody could justify. Instead, hybrid mode uses real Reciprocal Rank Fusion:
each memory's *rank position* in the BM25 list and the vector-search list are combined
(`1/(60+rank)` per list, summed), so a memory both methods agree on ranks above one only one of
them found — no tuning knob, no invented weight.

**Does the embedding text get truncated for long entries?** Not by this tool — whatever you send
is passed to OpenAI's embeddings API as-is; any length limit you'd hit is OpenAI's own, not one
added here.

**What if `@lancedb/lancedb` can't install or load on my platform?** Nothing breaks. It's an
optional dependency, so a failed install never aborts `npm install`, and at runtime the tool
automatically falls back to an exact pure-JS cosine vector search over the same stored vectors —
hybrid mode keeps working, just without the native index. BM25 keyword recall is independent of
both and always available.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)
for how to file an issue or submit a PR. Maintainers may use AI tools to help review
contributions — please don't include personal information in an issue, PR, or commit beyond
what's needed to describe the change.

## Releasing

See [RELEASING.md](RELEASING.md) —
the same version-bump/tag/publish process applies to every DAN-OSS tool, this one included.

## License

MIT (code) — see `LICENSE`. The "DAN" name and logo are trademarked — see `TRADEMARK.md`.

---

**[DAN] MEMORY SMASH** — the full codebase-memory engine this tool's recall capability also lives
inside — is coming soon.
