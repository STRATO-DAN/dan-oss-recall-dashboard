# Changelog

All notable changes to `@strato-dan/recall-dashboard` are documented here.
This project uses [semantic versioning](https://semver.org/).

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
