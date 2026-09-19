// [DAN] RECALL DASHBOARD — PER-PRINCIPAL identity (v0.3). RECALL feeds stored memories back into future agent
// context, so it must prove WHICH principal created a memory — not merely that SOMEONE held the instance
// token. This is RECALL's OWN standard, portable mechanism: per-principal API keys any self-hosting user/org
// can generate, zero dependency, no tie to any external identity infrastructure.
//
//   • A principal = { id, name, keyHash, role, createdAt }. Keys are stored HASHED (sha256), never plaintext —
//     principals.json leaking does not leak live keys; the key is shown ONCE at creation.
//   • The bootstrap ADMIN key is the v0.2 instance token (RECALL_TOKEN / recall-token), so existing setups keep
//     working. Admin mints additional per-agent principals.
//   • RECALL_PRINCIPALS="name1:key1,name2:key2" declares principals from the environment (never persisted in
//     plaintext) — for agents/CI that provision keys out of band.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadOrCreateToken, extractBearer } from "./auth.js";

export const ADMIN_ID = "admin";

// Non-secret identifier derivation (e.g. a stable id from a principal NAME) — sha256 is fine here, there
// is no credential to protect.
function idHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Credential hashing. Generated keys are 256-bit random (crypto.randomBytes(32)) so a fast hash would be
// defensible on its own, but RECALL_PRINCIPALS keys are operator-typed and may be low entropy — scrypt
// (memory-hard, salted) protects that path too, at a per-check cost that stays small against a self-hosted
// dashboard's principal count.
const SCRYPT_KEYLEN = 32;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
function newSalt() {
  return crypto.randomBytes(16).toString("hex");
}
function keyHash(key, salt) {
  return crypto.scryptSync(key, salt, SCRYPT_KEYLEN, SCRYPT_OPTS).toString("hex");
}
// Pre-scrypt format (v0.3–v0.6): unsalted sha256(key). Kept ONLY to verify keys minted before this change —
// new/rotated keys always get a salt (see keyHash() above), and every successful legacy match is migrated
// to a salted hash on the spot in authenticate(), so this path is exercised at most once per old key.
function legacyKeyHash(key) {
  return crypto.createHash("sha256").update(key).digest("hex"); // lgtm[js/insufficient-password-hash]
}
function timingEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export class PrincipalStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "principals.json");
    this.principals = []; // { id, name, keyHash, role, createdAt, fromEnv? }
    this.envPrincipals = (process.env.RECALL_PRINCIPALS || "").trim();
    this.adminKey = loadOrCreateToken(dataDir); // the v0.2 token = the admin bootstrap key (back-compat)
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      this.principals = JSON.parse(fs.readFileSync(this.file, "utf8")).principals ?? [];
    } catch (err) {
      if (err.code !== "ENOENT") throw new Error("Principal state cannot be read; refusing to reset identities");
      this.principals = [];
    }
    if (!Array.isArray(this.principals)) throw new Error("Invalid principal state");
    const env = this.envPrincipals;
    if (env) {
      for (const pair of env.split(",")) {
        const i = pair.indexOf(":");
        if (i <= 0) continue;
        const name = pair.slice(0, i).trim();
        const key = pair.slice(i + 1).trim();
        if (name && key && !this.principals.some((p) => p.name === name)) {
          const salt = newSalt();
          this.principals.push({
            id: `env_${idHash(name)}`,
            name,
            keySalt: salt,
            keyHash: keyHash(key, salt),
            role: "member",
            createdAt: new Date().toISOString(),
            fromEnv: true,
          });
        }
      }
    }
    return this;
  }

  _save() {
    // env-declared principals are never written to disk (their keys live only in the environment)
    const persist = this.principals.filter((p) => !p.fromEnv).map(({ fromEnv, ...p }) => p);
    const tmp = path.join(this.dataDir, `.principals.json.${process.pid}.tmp`);
    // R2 — durable, not merely atomic: fsync the temp file's contents BEFORE the rename, and fsync the
    // directory AFTER it, so a crash right after this call can't lose a just-minted principal.
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ principals: persist }, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    try {
      const dfd = fs.openSync(this.dataDir, "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch {
      /* directory fsync unsupported on some platforms — best-effort */
    }
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* best-effort */
    }
  }

  /** Resolve the request's bearer key → a verified principal, or null. The admin key maps to the admin
   *  principal; every other key is matched (constant-time) against the stored hashes. */
  authenticate(req) {
    try { this.load(); } catch { return null; }
    const key = extractBearer(req);
    if (!key) return null;
    if (timingEqual(key, this.adminKey)) return { id: ADMIN_ID, name: "admin", role: "admin" };
    for (const p of this.principals) {
      if (p.keySalt) {
        if (timingEqual(p.keyHash, keyHash(key, p.keySalt))) return { id: p.id, name: p.name, role: p.role };
        continue;
      }
      // No salt on this record → minted before scrypt (pre-0.7.0). Verify against the legacy sha256 hash,
      // then migrate it to a salted scrypt hash in place so it never needs this fallback again.
      if (timingEqual(p.keyHash, legacyKeyHash(key))) {
        if (!p.fromEnv) {
          p.keySalt = newSalt();
          p.keyHash = keyHash(key, p.keySalt);
          this._save();
        }
        return { id: p.id, name: p.name, role: p.role };
      }
    }
    return null;
  }

  isAdmin(principal) {
    return !!principal && principal.role === "admin";
  }

  /** Admin op — create a principal. Returns the plaintext apiKey ONCE (it is stored only as a hash). */
  create(name) {
    const clean = String(name || "").trim().slice(0, 80);
    if (!clean) throw new Error("a principal name is required");
    if (clean === "admin" || this.principals.some((p) => p.name === clean)) {
      throw new Error(`a principal named '${clean}' already exists`);
    }
    const key = crypto.randomBytes(32).toString("base64url");
    const salt = newSalt();
    const p = {
      id: `p_${crypto.randomBytes(6).toString("hex")}`,
      name: clean,
      keySalt: salt,
      keyHash: keyHash(key, salt),
      role: "member",
      createdAt: new Date().toISOString(),
    };
    this.principals.push(p);
    this._save();
    return { id: p.id, name: p.name, role: p.role, createdAt: p.createdAt, apiKey: key };
  }

  /** Principal list for the admin — never exposes key material. */
  list() {
    return this.principals.map(({ keyHash: _k, keySalt: _s, fromEnv: _f, ...p }) => p);
  }

  remove(id) {
    const before = this.principals.length;
    this.principals = this.principals.filter((p) => p.id !== id);
    if (this.principals.length === before) return false;
    this._save();
    return true;
  }
}
