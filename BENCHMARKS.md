# Benchmarks

Real numbers for the BM25 recall engine (`src/bm25.js`) — the always-on, zero-dependency ranking
path. The benchmark calls the ranking module **directly** (no server, no network, no embeddings) and
measures per-query latency at three corpus sizes with a fixed, seeded synthetic corpus, so the run
is reproducible.

**Reproduce:**

```bash
make bench
```

## Method

- `scripts/bench.mjs` builds a deterministic synthetic corpus (seeded PRNG) of 100 / 1,000 / 10,000
  memories, each 12–35 words drawn from a fixed vocabulary.
- Documents are tokenized once (the "index"/`build` column). Latency is then measured over 40 real
  `bm25Search()` calls per size, after a warm-up pass, using `perf_hooks.performance.now()` (Node
  standard library only).
- `bm25Search()` recomputes corpus statistics (document frequency, average length) on every call by
  design — this is the real cost the local store pays per query, not a pre-built index lookup, so the
  `mean`/`p50`/`p95` columns are honest end-to-end query latency.

## Results

Representative run (see machine note below):

```
[DAN] RECALL DASHBOARD — BM25 recall latency vs corpus size
Node v22.23.1 on darwin/arm64

  corpus |   build |     mean |      p50 |      p95   (per query, ms)
  -------+---------+----------+----------+---------
     100 |   0.522 |    0.222 |    0.195 |   0.453
    1000 |   2.794 |    1.888 |    1.870 |   2.129
   10000 |  14.114 |   20.356 |   19.935 |  23.601

Total wall time: 1039.168 ms. Reproduce: make bench
```

- All columns are milliseconds. `build` is the one-time tokenization of the corpus; `mean`/`p50`/`p95`
  are per **query**.
- Query latency scales roughly linearly with corpus size, as expected for a fresh per-query scan:
  sub-millisecond at 100 memories, low single-digit ms at 1,000, and ~20 ms at 10,000 — comfortably
  interactive for a local, single-user memory store.
- The whole benchmark completes in about a second (well under the ~15 s budget).

## Machine note

Measured on an Apple M5 Max (arm64), macOS (Darwin), Node v22.23.1. Absolute numbers will differ on
other hardware and Node versions; re-run `make bench` on your own machine for local figures. The
shape (near-linear growth with corpus size, sub-25 ms at 10k) is what to expect.
