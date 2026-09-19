// [DAN] RECALL DASHBOARD — real client logic, plain fetch + DOM.
const $ = (id) => document.getElementById(id);

// [DAN] RECALL DASHBOARD (v0.2) — the API now requires the instance bearer token. It arrives in the
// launch URL (?token=…); capture it once, strip it from the visible URL, and attach it to every API
// call. Reopen via the URL the CLI printed if it's missing.
const RECALL_TOKEN = (() => {
  try {
    const u = new URL(location.href);
    const fromUrl = u.searchParams.get("token");
    if (fromUrl) {
      try { sessionStorage.setItem("recallToken", fromUrl); } catch {}
      u.searchParams.delete("token");
      history.replaceState(null, "", u.pathname + u.search + u.hash);
      return fromUrl;
    }
    return sessionStorage.getItem("recallToken") || "";
  } catch {
    return "";
  }
})();

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}), authorization: `Bearer ${RECALL_TOKEN}` };
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && $("status")) {
    $("status").innerHTML =
      `<span class="mode-badge">Access token missing or invalid — reopen the dashboard using the URL the CLI printed.</span>`;
  }
  return res;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Friendly label for the real recall mode. The raw technical term (`bm25`/`hybrid`) is kept
// verbatim in a title= tooltip wherever this is shown, so which mode actually answered is never lost.
function modeLabel(mode) {
  if (mode === "hybrid") return "Keyword + Meaning";
  if (mode === "bm25") return "Keyword";
  return mode;
}

// Relative timestamp for a stored memory. Takes epoch milliseconds; the absolute time is kept in a
// title= tooltip by the caller.
function relativeTime(ms) {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `${mon} month${mon === 1 ? "" : "s"} ago`;
  const yr = Math.round(mon / 12);
  return `${yr} year${yr === 1 ? "" : "s"} ago`;
}

// Shown in the recall results area before a search is run — distinct from the "no match" message.
const RECALL_PLACEHOLDER = `<li class="empty-note">Search your stored memories to recall them here.</li>`;

function memoryRow(m, opts = {}) {
  const created = new Date(m.createdAt);
  const abs = created.toLocaleString();
  const rel = relativeTime(created.getTime());
  const scoreNote = typeof m.score === "number" ? ` · relevance ${m.score.toFixed(4)}` : "";
  return `
    <li class="memory-row" data-id="${m.id}">
      <span class="memory-text">
        ${escapeHtml(m.text)}
        <div class="hint memory-meta" title="${escapeHtml(abs)}">${escapeHtml(rel)}${scoreNote}</div>
      </span>
      <button class="icon-btn" data-action="forget">forget</button>
    </li>`;
}

async function loadStatus() {
  const res = await api("/api/status");
  const data = await res.json();
  const badge = data.mode === "hybrid"
    ? `<span class="mode-badge vector" title="mode: hybrid">Keyword + Meaning — real hybrid search (BM25 + semantic)</span>`
    : `<span class="mode-badge" title="mode: bm25">Keyword — real BM25 ranking; set OPENAI_API_KEY to add semantic recall</span>`;
  $("status").innerHTML = `${badge} · ${data.count} real memor${data.count === 1 ? "y" : "ies"} stored`;
}

async function loadMemories() {
  const res = await api("/api/memories");
  const data = await res.json();
  const list = $("memoryList");
  if (!data.ok || data.memories.length === 0) {
    list.innerHTML = `<li class="empty-note">Nothing remembered yet.</li>`;
    return;
  }
  list.innerHTML = data.memories.map((m) => memoryRow(m)).join("");
}

async function remember() {
  const text = $("rememberText").value;
  const status = $("rememberStatus");
  status.textContent = "Remembering…";
  const res = await api("/api/remember", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const data = await res.json();
  if (!data.ok) {
    status.textContent = data.reason;
    return;
  }
  status.textContent = "Remembered.";
  $("rememberText").value = "";
  updateRememberCount();
  await Promise.all([loadStatus(), loadMemories()]);
}

function updateRememberCount() {
  const n = $("rememberText").value.length;
  $("rememberCount").textContent = `${n} character${n === 1 ? "" : "s"}`;
}

async function recall() {
  const q = $("recallQuery").value.trim();
  const results = $("recallResults");
  if (!q) {
    results.innerHTML = RECALL_PLACEHOLDER;
    return;
  }
  const limit = Number($("recallLimit").value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    results.textContent = "Results must be a whole number between 1 and 100.";
    return;
  }
  const res = await api(`/api/recall?q=${encodeURIComponent(q)}&k=${limit}`);
  const data = await res.json();
  if (!data.ok) {
    results.innerHTML = `<li class="empty-note">${escapeHtml(data.reason)}</li>`;
    return;
  }
  if (data.results.length === 0) {
    const detail = data.mode === "none"
      ? "nothing is stored yet"
      : `<span title="${escapeHtml(data.mode)} search">${escapeHtml(modeLabel(data.mode))}</span> search found nothing`;
    results.innerHTML = `<li class="empty-note">No real match — ${detail}.</li>`;
    return;
  }
  results.innerHTML = data.results.map((m) => memoryRow(m)).join("");
}

async function onForgetClick(e) {
  const btn = e.target.closest('[data-action="forget"]');
  if (!btn) return;
  const id = btn.closest(".memory-row").dataset.id;
  await api(`/api/forget/${id}`, { method: "DELETE" });
  await Promise.all([loadStatus(), loadMemories(), recall()]);
}

$("rememberBtn").addEventListener("click", remember);
$("rememberText").addEventListener("input", updateRememberCount);
$("recallBtn").addEventListener("click", recall);
$("recallQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") recall(); });
$("memoryList").addEventListener("click", onForgetClick);
$("recallResults").addEventListener("click", onForgetClick);

(async () => {
  updateRememberCount();
  $("recallResults").innerHTML = RECALL_PLACEHOLDER;
  await loadStatus();
  await loadMemories();
})();
