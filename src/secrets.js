// Self-contained, zero-dependency secret detection for the embedding-egress gate. This module is the
// single source of truth for "does this text carry a secret, and which pattern names matched" — it
// deliberately does NOT import or share code with any other tool's gate, so this package stays
// dependency-free and each pattern is auditable in one place.
//
// Every regex is LINEAR (no nested/overlapping quantifiers, no catastrophic backtracking) so running
// it on caller-controlled text of any size is safe. The detector NEVER returns the matched value —
// only the NAMES of the patterns that fired — so a caller (and the audit trail) can record that a
// secret was present without ever echoing the secret itself.

// Ordered, named patterns. A single text may match several; all matching names are returned.
const PATTERNS = [
  // AWS access key id.
  { name: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/ },
  // PEM private-key block header (RSA/EC/OpenSSH/DSA/PGP or bare).
  { name: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  // OpenAI-style API key.
  { name: "openai-api-key", re: /sk-[A-Za-z0-9]{20,}/ },
  // Stripe live secret / restricted keys.
  { name: "stripe-secret-key", re: /sk_live_[A-Za-z0-9]{16,}/ },
  { name: "stripe-restricted-key", re: /rk_live_[A-Za-z0-9]{16,}/ },
  // GitHub tokens: personal/oauth/refresh/server/user (ghp_/gho_/ghr_/ghs_/ghu_) and fine-grained PATs.
  { name: "github-token", re: /gh[porsu]_[A-Za-z0-9]{36,}/ },
  { name: "github-fine-grained-pat", re: /github_pat_[A-Za-z0-9_]{40,}/ },
  // Google API key.
  { name: "google-api-key", re: /AIza[0-9A-Za-z_-]{35}/ },
  // Slack token (bot/app/personal/refresh/… ).
  { name: "slack-token", re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  // JWT (three base64url segments; the `eyJ` header prefix is base64 of `{"`).
  { name: "jwt", re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  // Generic secret assignment: (password|passwd|secret|token|api_key) = "…" / : "…" with an 8+ char quoted value.
  { name: "generic-secret-assignment", re: /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["'][^"']{8,}["']/i },
];

/**
 * Return the NAMES of every secret pattern that matches `text`. Never returns the matched value.
 * An empty array means "no secret detected". Non-string / empty input is treated as clean.
 */
export function detectSecrets(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const names = [];
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) names.push(name);
  }
  return names;
}

/** Convenience boolean: true when `text` carries at least one recognised secret. */
export function containsSecret(text) {
  return detectSecrets(text).length > 0;
}

/**
 * Opt-in escape hatch. When `DAN_OSS_RECALL_DASHBOARD_ALLOW_SECRET_EMBED` is set truthy
 * (1/true/yes/on), secret-bearing text is embedded exactly as before (prior behaviour restored).
 * Read at call time so it can be toggled per operation and exercised in tests.
 */
export function allowSecretEmbed() {
  return /^(1|true|yes|on)$/i.test(process.env.DAN_OSS_RECALL_DASHBOARD_ALLOW_SECRET_EMBED || "");
}
