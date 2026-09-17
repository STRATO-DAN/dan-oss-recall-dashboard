#!/usr/bin/env bash
# [DAN] RECALL DASHBOARD — reproducible end-to-end demo, no OPENAI key (BM25 mode).
#
# Boots a throwaway instance on an OS-assigned ephemeral port against a temp data dir, mints a
# per-agent principal through the admin token, stores a few memories via the real HTTP API with
# curl, then recalls them and shows that recall returns RANKED (scored) results — not a raw dump.
# Cleans up the server and the temp dir on exit. Node stdlib + curl only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATADIR="$(mktemp -d "${TMPDIR:-/tmp}/recall-demo.XXXXXX")"
BANNER="$DATADIR/banner.json"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$DATADIR"
}
trap cleanup EXIT

echo "== [DAN] RECALL DASHBOARD demo =="
echo "temp data dir: $DATADIR"
echo

# Boot on an ephemeral port (PORT=0) with the machine-readable startup banner. No OPENAI_API_KEY → BM25 mode.
env -u OPENAI_API_KEY DAN_OSS_RECALL_DASHBOARD_PORT=0 DAN_OSS_RECALL_DASHBOARD_DATA="$DATADIR" \
  node "$ROOT/bin/dan-oss-recall-dashboard.js" --json >"$BANNER" 2>/dev/null &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true

# Wait for the one-line JSON banner to appear.
for _ in $(seq 1 50); do
  [ -s "$BANNER" ] && break
  sleep 0.1
done
if [ ! -s "$BANNER" ]; then echo "server did not start"; exit 1; fi

PORT="$(node -e 'const b=require("fs").readFileSync(process.argv[1],"utf8");process.stdout.write(String(JSON.parse(b).port))' "$BANNER")"
MODE="$(node -e 'const b=require("fs").readFileSync(process.argv[1],"utf8");process.stdout.write(JSON.parse(b).mode)' "$BANNER")"
BASE="http://127.0.0.1:$PORT"
ADMIN_TOKEN="$(tr -d '\n' < "$DATADIR/recall-token")"
echo "server up on $BASE (mode: $MODE)"
echo

# Mint a per-agent principal with the admin token; capture the one-time apiKey.
CREATED="$(curl -s -X POST "$BASE/api/principals" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"demo-agent"}')"
AGENT_KEY="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).principal.apiKey))' <<<"$CREATED")"
echo "minted principal 'demo-agent' (apiKey shown once)"
echo

# Store a few memories as that agent (provenance.principal is set by the server, not the caller).
remember() {
  curl -s -X POST "$BASE/api/remember" \
    -H "authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' \
    -d "{\"text\":$1}" >/dev/null
  echo "  remembered: $1"
}
echo "storing memories:"
remember '"the production deploy key rotates every 90 days via the release pipeline"'
remember '"database backups run nightly and are restored into staging weekly"'
remember '"the deploy key for staging is separate and rotates every 30 days"'
remember '"incident runbook: on high latency, roll back the last release first"'
echo

# Recall — the headline: ranked, scored results, not a raw dump.
Q="deploy key rotation"
echo "recall q=\"$Q\":"
curl -s "$BASE/api/recall?q=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$Q")&k=5" \
  -H "authorization: Bearer $AGENT_KEY" \
| node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const r=JSON.parse(s);
    console.log("  mode: "+r.mode+"  (results are ranked by score, highest first)");
    r.results.forEach((m,i)=>console.log("  #"+(i+1)+"  score="+m.score.toFixed(4)+"  "+JSON.stringify(m.text)));
  });'
echo
echo "demo complete — server stopped, temp data dir removed."
