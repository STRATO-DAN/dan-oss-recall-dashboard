// [DAN] RECALL DASHBOARD — token bootstrap + bearer extraction (v0.2→v0.3). The v0.2 instance token is now
// the bootstrap ADMIN principal's key (see principals.js); per-principal API keys are layered on top. This
// module keeps the token file logic and the (regex-free, ReDoS-safe) Authorization-header parse.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Resolve the bootstrap ADMIN key: RECALL_TOKEN env override, else the 0600 file in dataDir, else generate a
 *  fresh 256-bit key and persist it 0600. Existing v0.2 setups keep working — this key is the admin principal. */
export function loadOrCreateToken(dataDir) {
  const fromEnv = (process.env.RECALL_TOKEN || process.env.DAN_OSS_RECALL_DASHBOARD_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const tokenPath = path.join(dataDir, "recall-token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* not created yet — generate */
  }
  const token = crypto.randomBytes(32).toString("base64url");
  // FINDING 01 fix: restrictive modes on create; existing paths tightened best-effort.
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dataDir, 0o700); } catch {}
  fs.writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    /* best-effort on platforms without POSIX perms */
  }
  return token;
}

/** Extract the bearer credential from a request, or null. Fixed-prefix slice + trim, NOT a regex: the
 *  Authorization header is attacker-controlled and reached before auth passes, so a backtracking pattern
 *  (e.g. /^Bearer\s+(.+)$/, where \s and . both match a space) would be a ReDoS. Prefix slicing is linear. */
export function extractBearer(req) {
  const header = req.headers["authorization"];
  if (!header || typeof header !== "string") return null;
  const PREFIX = "bearer ";
  if (header.length < PREFIX.length || header.slice(0, PREFIX.length).toLowerCase() !== PREFIX) {
    return null;
  }
  return header.slice(PREFIX.length).trim();
}
