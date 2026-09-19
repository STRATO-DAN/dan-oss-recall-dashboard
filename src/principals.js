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

function keyHash(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
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
          this.principals.push({
            id: `env_${keyHash(name)}`,
            name,
            keyHash: keyHash(key),
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
    const h = keyHash(key);
    for (const p of this.principals) {
      if (timingEqual(p.keyHash, h)) return { id: p.id, name: p.name, role: p.role };
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
    const p = {
      id: `p_${crypto.randomBytes(6).toString("hex")}`,
      name: clean,
      keyHash: keyHash(key),
      role: "member",
      createdAt: new Date().toISOString(),
    };
    this.principals.push(p);
    this._save();
    return { id: p.id, name: p.name, role: p.role, createdAt: p.createdAt, apiKey: key };
  }

  /** Principal list for the admin — never exposes key material. */
  list() {
    return this.principals.map(({ keyHash: _k, fromEnv: _f, ...p }) => p);
  }

  remove(id) {
    const before = this.principals.length;
    this.principals = this.principals.filter((p) => p.id !== id);
    if (this.principals.length === before) return false;
    this._save();
    return true;
  }
}
