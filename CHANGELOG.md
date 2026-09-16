# Changelog

All notable changes to `@strato-dan/recall-dashboard` are documented here.
This project uses [semantic versioning](https://semver.org/).

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
