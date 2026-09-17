// [DAN] RECALL DASHBOARD — append-only audit (v0.2). One JSONL line per security-relevant event, so
// memory writes, deletes, embedding calls, and authentication failures are attributable after the fact.
// Reads are NOT audited by default (a local recall tool would drown in noise); state-changing and
// security events are. Best-effort: an audit failure never fails the underlying operation, but it is
// surfaced once so a broken audit trail is not silent.
import fs from "node:fs";
import path from "node:path";

export function makeAudit(dataDir) {
  const file = path.join(dataDir, "audit.log");
  let warned = false;
  return function audit(event) {
    try {
      // R2 — fsync the append so a security-relevant event the log claims to record actually survives a
      // crash. Open/append/fsync/close explicitly (appendFileSync gives no handle to fsync). Best-effort:
      // a fsync failure still falls through to the warn-once path below rather than failing the operation.
      const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
      const fd = fs.openSync(file, "a");
      try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      if (!warned) {
        warned = true;
        console.error(`[DAN] RECALL DASHBOARD: audit write failed (events not being recorded): ${err.message}`);
      }
    }
  };
}
