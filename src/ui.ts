// Single-page UI for the crawlshot local server. Served verbatim at GET /.
// Dependency-free: vanilla JS, fetch + EventSource. Kept as a TS string so it
// bundles into dist/server.js with no extra files to ship.

export const UI_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>crawlshot</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --panel2: #1c232d; --border: #2b333d;
    --fg: #e6edf3; --muted: #8b949e; --accent: #2f81f7; --accent2: #238636;
    --warn: #d29922; --bad: #f85149; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { padding: 14px 20px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: .3px; }
  header .tag { color: var(--muted); font-size: 12px; }
  .wrap { display: grid; grid-template-columns: 380px 1fr; gap: 0; height: calc(100vh - 53px); }
  .col { overflow-y: auto; padding: 18px; }
  .col.left { border-right: 1px solid var(--border); }
  fieldset { border: 1px solid var(--border); border-radius: 8px; margin: 0 0 14px; padding: 12px 14px; }
  legend { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .6px; padding: 0 6px; }
  label { display: block; margin: 8px 0 3px; font-size: 12px; color: var(--muted); }
  input[type=text], input[type=number], textarea { width: 100%; background: var(--panel2); border: 1px solid var(--border);
    color: var(--fg); border-radius: 6px; padding: 7px 9px; font-size: 13px; font-family: var(--mono); resize: vertical; }
  input[type=text]:focus, input[type=number]:focus, textarea:focus { outline: none; border-color: var(--accent); }
  button.danger { background: var(--bad); border-color: var(--bad); color: #fff; font-weight: 600; }
  .check { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 13px; color: var(--fg); cursor: pointer; }
  .check input { accent-color: var(--accent); }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .hint { color: var(--muted); font-size: 11px; margin: 2px 0 0; }
  button { font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid var(--border);
    background: var(--panel2); color: var(--fg); padding: 8px 14px; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent2); border-color: var(--accent2); font-weight: 600; }
  button.primary:disabled { opacity: .5; cursor: not-allowed; }
  button.ghost { background: transparent; }
  .actions { display: flex; gap: 10px; align-items: center; margin-top: 4px; }
  .console { background: #0a0d11; border: 1px solid var(--border); border-radius: 8px; padding: 12px;
    font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-word;
    height: 52vh; overflow-y: auto; }
  .console .err { color: var(--bad); }
  .console .ok { color: var(--accent2); }
  .console .dim { color: var(--muted); }
  .links a { color: var(--accent); margin-right: 16px; text-decoration: none; font-size: 13px; }
  .links a:hover { text-decoration: underline; }
  .status { font-size: 12px; color: var(--muted); margin-left: auto; }
  .status.run { color: var(--warn); } .status.done { color: var(--accent2); } .status.fail { color: var(--bad); }
  .runs { list-style: none; padding: 0; margin: 8px 0 0; }
  .runs li { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin-bottom: 7px; background: var(--panel); }
  .runs .name { font-family: var(--mono); font-size: 12px; }
  .runs .meta { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .runs .badges span { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 10px;
    border: 1px solid var(--border); color: var(--muted); margin: 4px 6px 0 0; }
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: none; align-items: center; justify-content: center; }
  .modal.open { display: flex; }
  .modal .box { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 20px; width: 440px; }
  .modal h3 { margin: 0 0 10px; font-size: 15px; }
  .modal p { color: var(--muted); font-size: 13px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); margin: 0 0 8px; }
  .section + .section { margin-top: 22px; }
</style>
</head>
<body>
<header>
  <h1>🕷 crawlshot</h1>
  <span class="tag">local control panel</span>
</header>
<div class="wrap">
  <div class="col left">
    <fieldset>
      <legend>Target</legend>
      <label>URL(s)</label>
      <textarea id="url" rows="2" placeholder="https://example.com" autocomplete="off"></textarea>
      <p class="hint">One URL per line — 2+ URLs runs compare mode.</p>
      <div class="row">
        <div><label>Max pages</label><input type="number" id="maxPages" min="1" placeholder="∞" /></div>
        <div><label>Max depth</label><input type="number" id="maxDepth" min="0" placeholder="∞" /></div>
      </div>
      <div class="row">
        <div><label>Include (regex)</label><input type="text" id="include" placeholder="/blog/" /></div>
        <div><label>Exclude (regex)</label><input type="text" id="exclude" placeholder="/tag/" /></div>
      </div>
      <label>Concurrency</label><input type="number" id="concurrency" min="1" placeholder="4" />
    </fieldset>

    <fieldset>
      <legend>Mode</legend>
      <label class="check"><input type="checkbox" id="mirror" /> Mirror — download the site's assets</label>
      <label class="check"><input type="checkbox" id="mirrorVideo" /> &nbsp;↳ also self-hosted media + HLS/DASH (yt-dlp)</label>
      <label class="check"><input type="checkbox" id="mirrorCrossOrigin" /> &nbsp;↳ also cross-origin (CDN) assets</label>
      <label class="check"><input type="checkbox" id="mirrorRewrite" /> &nbsp;↳ rewrite URLs for offline browsing</label>
      <p class="hint">Mirror mode skips the audit grid (Lighthouse/axe/links/screenshots).</p>
    </fieldset>

    <fieldset>
      <legend>Audit (default run)</legend>
      <label class="check"><input type="checkbox" id="noLighthouse" /> Skip Lighthouse</label>
      <label class="check"><input type="checkbox" id="noAxe" /> Skip axe (a11y)</label>
      <label class="check"><input type="checkbox" id="noLinks" /> Skip outbound link checks</label>
      <label class="check"><input type="checkbox" id="noRecon" /> Skip passive recon</label>
      <label class="check"><input type="checkbox" id="noCve" /> Skip CVE correlation</label>
    </fieldset>

    <fieldset>
      <legend>Auth</legend>
      <label>storageState file</label>
      <input type="text" id="authStorage" placeholder="(none)" />
      <div class="actions"><button class="ghost" id="captureBtn" type="button">Capture login…</button></div>
      <p class="hint">Opens a browser; log in, then save the session for an authenticated crawl.</p>
    </fieldset>

    <fieldset>
      <legend>Privacy</legend>
      <label class="check"><input type="checkbox" id="verifyIp" /> Verify exit IP is a VPN before crawling</label>
      <label>Home IP (definitive VPN check)</label>
      <input type="text" id="homeIp" placeholder="e.g. 81.2.69.x" />
    </fieldset>

    <div class="actions">
      <button class="primary" id="runBtn" type="button">Run crawl</button>
      <button class="danger" id="stopBtn" type="button" style="display:none">Stop</button>
      <span class="status" id="status">idle</span>
    </div>
  </div>

  <div class="col right">
    <div class="section">
      <h2>Run log</h2>
      <div class="console" id="console"><span class="dim">No run yet. Configure a target and hit Run.</span></div>
      <div class="links" id="links" style="margin-top:10px"></div>
    </div>
    <div class="section">
      <h2>History</h2>
      <ul class="runs" id="runs"></ul>
    </div>
  </div>
</div>

<div class="modal" id="loginModal">
  <div class="box">
    <h3>Capture login</h3>
    <p id="loginMsg">A browser window will open. Log into the site, then click “Save session”.</p>
    <div class="actions">
      <button class="primary" id="loginSave" type="button" disabled>Save session</button>
      <button class="ghost" id="loginCancel" type="button">Cancel</button>
    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const consoleEl = $("console"), statusEl = $("status"), linksEl = $("links");
let es = null, loginSession = null, currentRunId = null;

function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = "status " + (cls || ""); }
function logLine(text, cls) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text + "\\n";
  consoleEl.appendChild(span);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function collectOptions() {
  const v = (id) => $(id).value.trim();
  const c = (id) => $(id).checked;
  return {
    url: v("url"),
    maxPages: v("maxPages") || null, maxDepth: v("maxDepth") || null,
    include: v("include") || null, exclude: v("exclude") || null,
    concurrency: v("concurrency") || null,
    mirror: c("mirror"), mirrorVideo: c("mirrorVideo"),
    mirrorCrossOrigin: c("mirrorCrossOrigin"), mirrorRewrite: c("mirrorRewrite"),
    noLighthouse: c("noLighthouse"), noAxe: c("noAxe"), noLinks: c("noLinks"),
    noRecon: c("noRecon"), noCve: c("noCve"),
    authStorage: v("authStorage") || null,
    verifyIp: c("verifyIp"), homeIp: v("homeIp") || null,
  };
}

async function run() {
  const opts = collectOptions();
  if (!opts.url) { alert("Enter a URL"); return; }
  consoleEl.innerHTML = ""; linksEl.innerHTML = "";
  $("runBtn").disabled = true; setStatus("starting…", "run");
  let res;
  try { res = await (await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(opts) })).json(); }
  catch (e) { logLine("Failed to start: " + e, "err"); $("runBtn").disabled = false; setStatus("failed", "fail"); return; }
  if (res.error) { logLine("Error: " + res.error, "err"); $("runBtn").disabled = false; setStatus("failed", "fail"); return; }
  currentRunId = res.runId;
  setStatus("running", "run");
  $("stopBtn").style.display = ""; $("stopBtn").disabled = false;
  if (es) es.close();
  es = new EventSource("/api/run/" + res.runId + "/stream");
  es.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "log") logLine(m.line, /error|fail|✗/i.test(m.line) ? "err" : (/✓|Done|success/i.test(m.line) ? "ok" : null));
    else if (m.type === "done") {
      es.close(); $("runBtn").disabled = false; $("stopBtn").style.display = "none"; currentRunId = null;
      setStatus(m.stopped ? "stopped" : (m.code === 0 ? "done" : "exit " + m.code), m.stopped ? "fail" : (m.code === 0 ? "done" : "fail"));
      if (m.folder) {
        linksEl.innerHTML =
          '<a href="/files/' + encodeURIComponent(m.folder) + '/index.html" target="_blank">Open dashboard ↗</a>' +
          (m.hasMirror ? '<a href="/files/' + encodeURIComponent(m.folder) + '/mirror/manifest.json" target="_blank">Mirror manifest ↗</a>' : "") +
          '<a href="/api/reveal/' + encodeURIComponent(m.folder) + '">Reveal in Finder</a>';
      }
      loadRuns();
    }
  };
  es.onerror = () => { if (es) es.close(); $("runBtn").disabled = false; };
}

async function stop() {
  if (!currentRunId) return;
  $("stopBtn").disabled = true; logLine("Stopping…", "dim");
  try { await fetch("/api/run/" + currentRunId + "/stop", { method: "POST" }); } catch {}
}

async function startLogin() {
  const url = $("url").value.trim();
  if (!url) { alert("Enter the URL to log into first"); return; }
  $("loginModal").classList.add("open"); $("loginSave").disabled = true;
  $("loginMsg").textContent = "Opening browser…";
  try {
    const res = await (await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) })).json();
    if (res.error) { $("loginMsg").textContent = "Error: " + res.error; return; }
    loginSession = res.sessionId;
    $("loginMsg").textContent = "Browser open. Log in, then click “Save session”.";
    $("loginSave").disabled = false;
  } catch (e) { $("loginMsg").textContent = "Failed: " + e; }
}

async function saveLogin() {
  if (!loginSession) return;
  $("loginSave").disabled = true; $("loginMsg").textContent = "Saving…";
  const res = await (await fetch("/api/login/" + loginSession + "/save", { method: "POST" })).json();
  if (res.error) { $("loginMsg").textContent = "Error: " + res.error; return; }
  $("authStorage").value = res.path;
  $("loginModal").classList.remove("open"); loginSession = null;
}

async function cancelLogin() {
  if (loginSession) fetch("/api/login/" + loginSession + "/cancel", { method: "POST" });
  $("loginModal").classList.remove("open"); loginSession = null;
}

async function loadRuns() {
  let runs = [];
  try { runs = await (await fetch("/api/runs")).json(); } catch {}
  const ul = $("runs"); ul.innerHTML = "";
  if (!runs.length) { ul.innerHTML = '<li class="meta">No runs yet.</li>'; return; }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  for (const r of runs) {
    const li = document.createElement("li");
    const title = (r.urls && r.urls.length) ? esc(r.urls.join(", ")) : esc(r.folder || "(no output)");
    const badges = [r.status, r.hasMirror ? "mirror" : null, r.missing ? "deleted" : null].filter(Boolean).map(b => "<span>" + esc(b) + "</span>").join("");
    const canOpen = r.folder && !r.missing;
    li.innerHTML =
      '<div class="name">' + title + '</div>' +
      '<div class="meta">' + esc(r.when) + (r.folder ? " · " + esc(r.folder) : "") + '</div>' +
      '<div class="badges">' + badges + '</div>' +
      (canOpen ? '<div class="links" style="margin-top:6px">' +
        (r.hasDashboard ? '<a href="/files/' + encodeURIComponent(r.folder) + '/index.html" target="_blank">Dashboard ↗</a>' : "") +
        (r.hasMirror ? '<a href="/files/' + encodeURIComponent(r.folder) + '/mirror/manifest.json" target="_blank">Manifest ↗</a>' : "") +
        '<a href="/api/reveal/' + encodeURIComponent(r.folder) + '">Finder</a>' +
      '</div>' : "");
    ul.appendChild(li);
  }
}

$("runBtn").onclick = run;
$("stopBtn").onclick = stop;
$("captureBtn").onclick = startLogin;
$("loginSave").onclick = saveLogin;
$("loginCancel").onclick = cancelLogin;
loadRuns();
</script>
</body>
</html>`;
