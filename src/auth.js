// [DAN] RECALL DASHBOARD — local caller authentication (v0.2). RECALL stores memories that, in an
// agentic setup, become future model context — so a privileged op (remember / recall / list / forget)
// must prove it comes from an AUTHORIZED caller, not merely from localhost. Loopback + the DNS-rebind
// guard say WHERE a request came from; this says the caller holds THIS instance's bearer token.
//
// Zero-config: the token is auto-generated on first run and stored 0600 in the data dir; agents/CI can
// pin a known one with RECALL_TOKEN. Honest limit (documented, not hidden): a process running as the
// SAME OS user can read the token file — and the data — directly, and no app-layer auth changes that on
// a local file-backed tool. What the token DOES buy: the browser vector is closed, other OS users are
// shut out (0600), and every privileged op is attributable (provenance + audit).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Resolve the instance token: RECALL_TOKEN env override, else the 0600 file in dataDir, else generate
 *  a fresh 256-bit token and persist it 0600. Returns the token string. */
export function loadOrCreateToken(dataDir) {
  const fromEnv = (process.env.RECALL_TOKEN || process.env.DAN_OSS_RECALL_DASHBOARD_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const tokenPath = path.join(dataDir, "recall-token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* not created yet — fall through and generate */
  }
  const token = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600); // enforce 0600 even if the file pre-existed with looser perms
  } catch {
    /* best-effort on platforms without POSIX perms */
  }
  return token;
}

/** Constant-time bearer check — true iff the request carries exactly this token. */
export function bearerOk(req, token) {
  const header = req.headers["authorization"];
  if (!header || typeof header !== "string") return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const got = Buffer.from(m[1].trim());
  const want = Buffer.from(token);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
