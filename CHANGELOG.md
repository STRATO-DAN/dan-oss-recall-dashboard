# Changelog

All notable changes to `@strato-dan/recall-dashboard` are documented here.
This project uses [semantic versioning](https://semver.org/).

## [0.5.0] — 2026-09-17

### Security — side-channels, shared-resource DoS, and durability (next layer after v0.4)

v0.4's per-principal **content** read-isolation is unchanged and intact — a principal still reads only its own
memories. This release closes the ways one principal could still *observe* or *starve* another **without** reading
their content, and makes the "atomic/crash-safe" framing actually true.

#### Fixed — side-channels
- **BM25 corpus-statistics oracle.** Lexical scores were computed over the **global** corpus, so another principal
  storing a query term shifted the document-frequency/average-length behind your *own* memories' scores — a
  term-presence oracle across the isolation boundary. BM25 corpus stats are now computed over the **caller's own
  readable set**, so your scores depend only on your own memories.
- **Vector candidate crowd-out + score channel.** Hybrid recall fetched `k*3` vector candidates **globally**, then
  filtered by principal, then sliced — so another principal's (closer) vectors could push your own memories out of
  the candidate window (recall shrink) and their distances leaked in. The semantic candidate set is now ranked over
  the **caller's own readable set** *before* the slice.

#### Fixed — shared-resource DoS
- **Per-principal quotas.** Memory-count and total-byte quotas are now accounted **per principal**, so one principal
  can neither exhaust another's budget (starvation) nor probe a shared global fill level. The historical
  `RECALL_MAX_MEMORIES` / `RECALL_MAX_TOTAL_BYTES` are honoured as each principal's budget; the explicit
  `RECALL_MAX_MEMORIES_PER_PRINCIPAL` / `RECALL_MAX_BYTES_PER_PRINCIPAL` take precedence.
- **Per-principal rate limits.** The request and write limiters are now **keyed per principal**, so one principal's
  burst can't 429 another (cross-principal DoS).
- **Unauth flood can't grow the audit log.** The unauthenticated path is rate-limited (`RECALL_UNAUTH_MAX`, default
  60/min) **before** it writes its `auth-failure` audit line, capping audit growth under a failed-auth flood.

#### Fixed — durability & correctness
- **Cross-process lost update.** `_saveSidecar` only serialized writes *within* one process; two processes on one
  data dir each held a stale snapshot and the last rename clobbered the other's write. Saves now take a
  **cross-process lock** and do a **read-modify-write merge** (re-read on-disk set, drop this instance's tombstones,
  overlay its own memories), so concurrent processes no longer lose each other's updates.
- **fsync on durable writes.** The sidecar, `principals.json`, and `audit.log` now `fsync` the file (and the parent
  directory, best-effort) so a crash right after a write can't lose it — the "crash-safe" claim made real.
- **Embedding egress is now actually audited.** `audit.js` claimed to record "embedding calls" but never did; the
  store now emits an `embedding` audit event (principal + byte count) on both remember and recall. Egress
  **behaviour** is deliberately unchanged (see note below).
- **RAM never diverges from disk.** `remember`/`forget` now commit to in-RAM state **only after** the durable save
  succeeds (rolling back on failure), instead of mutating RAM before awaiting the write.
- **Honest HTTP errors.** `remember`/`recall` failures return real status codes (400 for a bad request, 500 for an
  internal error) instead of `200 {ok:false}`, and no longer reflect a raw upstream provider error body back to the
  caller (`embeddings.js` drops the provider body from the thrown error; it is logged locally instead).

#### Notes / honest limits
- **`forget` still returns 403 (not 404) to a non-owner.** Unifying to 404 would remove a theoretical existence
  oracle, but it would also erase the owner-scoped `forget-denied` audit signal — and the oracle is unreachable in
  practice, since memory ids are unguessable UUIDv4 and are never exposed across principals. Kept 403.
- **Embedding egress is audited but not gated.** Whether a principal's text *should* be allowed to leave the process
  to an external embeddings provider is a data-classification decision, deliberately **not** changed here.
- Zero runtime dependencies unchanged (LanceDB/embeddings remain optional-guarded).

## [0.4.0] — 2026-09-17

### ⚠️ Behaviour change — reads are now per-principal
- **Per-principal read isolation.** `recall()` and `GET /api/memories` now return only the **calling
  principal's own memories** by default. Authentication has known *which* principal is asking since v0.3, but
  authorization didn't follow on reads — any authenticated principal could read the entire corpus (and harvest
  a poisoned/planted memory it didn't create). Now it does. An **admin** (the instance operator) and a trusted
  in-process/library caller still see all; owner-scoped delete is unchanged. **If you relied on shared
  read/recall across principals, opt back in with `RECALL_SHARED_MEMORY=1`.**

## [0.3.1] — 2026-09-17

### Fixed
- **Concurrent sidecar persistence.** `_saveSidecar` used one per-process temp path
  (`.memories.json.<pid>.tmp`), so overlapping writes shared it and could race the rename and/or lose an
  update — the rename that lands last wins the file, even with a staler, shorter list. Atomic replacement
  is not atomic *concurrent* persistence. Saves are now serialized (each waits for the previous, so the
  last write reflects the latest memories) and use a per-write unique temp name, so concurrent
  `remember()` calls all persist durably. Regression test added.

## [0.3.0] — 2026-09-16

### Security — per-principal identity + storage integrity (next layer after v0.2)

v0.2 fixed the localhost-trust gap with an instance-wide bearer token, but the server still only knew *someone
holding the token* made a request — not **which** principal — and provenance was caller-supplied (a
memory-poisoning vector with attribution laundering, since stored memory becomes future model context).

#### Added
- **Per-principal API keys** (RECALL's own standard, portable mechanism — zero dependency, no external identity
  infra). Each request's key resolves to a *verified principal*. The bootstrap **admin** key is the v0.2 instance
  token; admin mints per-agent keys via `POST /api/principals` (key shown once, stored as a hash). Also
  `RECALL_PRINCIPALS="name:key,..."` for out-of-band provisioning.
- **Verified, unforgeable provenance** — `provenance.principal` is the authenticated caller, server-set; a caller
  can no longer label a memory as a different agent. (A free-text `source` label is kept but untrusted.)
- **Owner-scoped delete** — only a memory's creating principal, or an admin, may `forget` it (→ 403).
- Admin principal management: `GET`/`POST /api/principals`, `DELETE /api/principals/:id` (admin only).

#### Fixed
- **Storage invariant** — `RECALL_MAX_TOTAL_BYTES` now accounts for the full footprint (text + metadata +
  provenance + embedding vector), not just text; `forget` reclaims the exact footprint. Caller metadata can no
  longer slip past the quota.
- **Sidecar↔index divergence** — `recall` now treats the sidecar as the source of truth and drops any stale
  index id, so a best-effort LanceDB delete that failed can never surface a deleted memory as a malformed result.

#### Changed — BREAKING
- Provenance shape: `provenance.source` → `provenance.{principal, source}`. `forget` is now owner-scoped. The
  v0.2 single-token setup keeps working (that token is the admin principal), but per-agent callers should use
  their own keys.

#### Notes / honest limits
- Same-OS-user processes remain inside the boundary (they can read the key/data files directly). Read/list is a
  **shared pool** labelled with verified owners, not per-principal isolation; multi-org isolation and at-rest
  encryption stay out of scope for this local tier.

## [0.2.0] — 2026-09-16

### ⚠️ Security — please upgrade from 0.1.x

RECALL stores memories that, in an agentic setup, become future model context. In 0.1.x the API's only
trust decision was **locality** (loopback + a DNS-rebind guard) — which says *where* a request came from,
not *who* made it or *what they may do*. 0.2.0 adds an explicit identity-and-authorization layer.

### Added
- **Bearer-token authentication on every `/api/` operation.** Auto-generated on first run (zero config),
  stored `0600` in the data dir, printed at startup, overridable with `RECALL_TOKEN`. Unauthenticated
  read / write / delete / enumerate now return **401**.
- **Provenance:** each memory records a **server-set** `{source, at}` (from an authenticated `source` /
  `X-Recall-Source`), so a consumer can tell where a memory came from before it re-enters model context.
- **Append-only audit** (`audit.log`) of writes, deletes, and authentication failures.
- **Rate limits** (`RECALL_RATE_MAX`, `RECALL_WRITE_MAX`) → **429**, and **quotas**
  (`RECALL_MAX_MEMORIES`, `RECALL_MAX_TOTAL_BYTES`) → **413**, bounding abuse and external-embedding cost.

### Changed — BREAKING
- The `/api/` surface now **requires the bearer token**. The dashboard opens via the token-carrying URL
  the CLI prints; scripts/agents send `Authorization: Bearer <token>`. Update any 0.1.x caller.

### Notes / honest limits
- A process running as the **same OS user** can read the token file and the data directly — no app-layer
  auth changes that on a local file-backed tool. The token defends the browser vector, other OS users, and
  provides provenance/audit/quota. Multi-tenant / untrusted-caller isolation and at-rest encryption are out
  of scope for this local tier (rely on OS/disk encryption for the plaintext store).
- Kept from 0.1.x: DNS-rebind guard, loopback bind, 5 MB body cap, atomic sidecar writes, vector never
  leaves the API.

## [0.1.0]
- Initial release: local memory server — remember / recall / forget, BM25 always-on, optional hybrid
  (BM25 + OpenAI embeddings via RRF), LanceDB with an exact JS cosine fallback, loopback-only.
