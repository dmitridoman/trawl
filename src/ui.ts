// Single-page control panel for the crawlshot local server, served at GET /.
// Dependency-free: vanilla JS, fetch + EventSource. Kept as a TS string so it
// bundles into dist/server.js with no extra files to ship. (No backticks or
// ${...} inside — string concatenation only — so the outer template literal
// stays intact.)

export const UI_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>crawlshot</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%95%B7%3C/text%3E%3C/svg%3E" />
<style>
  :root {
    --bg: #0d1117; --bg2: #0a0e14; --panel: #151b23; --panel2: #1b232d; --hover: #222c38;
    --border: #2a333f; --border2: #38424f;
    --fg: #e6edf3; --fg2: #b9c2cd; --muted: #7d8794;
    --accent: #4493f8; --accent-dim: #1f6feb; --green: #3fb950; --green-dim: #238636;
    --amber: #d29922; --red: #f85149; --purple: #bc8cff;
    --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
    --shadow: 0 8px 24px rgba(0,0,0,.4);
    --r: 10px;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: radial-gradient(1200px 600px at 80% -10%, #16202c 0%, var(--bg) 55%); color: var(--fg); font: 14px/1.55 var(--sans); -webkit-font-smoothing: antialiased; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: #2c3744; border-radius: 6px; border: 2px solid transparent; background-clip: content-box; }
  ::-webkit-scrollbar-thumb:hover { background: #3a4654; background-clip: content-box; }

  header { display: flex; align-items: center; gap: 12px; padding: 13px 22px; border-bottom: 1px solid var(--border); background: rgba(13,17,23,.7); backdrop-filter: blur(8px); position: sticky; top: 0; z-index: 30; }
  header .logo { font-size: 19px; }
  header h1 { font-size: 15px; margin: 0; font-weight: 650; letter-spacing: .2px; }
  header .ver { color: var(--muted); font-size: 11px; padding: 2px 7px; border: 1px solid var(--border); border-radius: 20px; }
  header .spacer { flex: 1; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 3px rgba(63,185,80,.18); }
  header .live { color: var(--muted); font-size: 12px; }

  .wrap { display: grid; grid-template-columns: 410px 1fr; height: calc(100vh - 52px); }
  .col { overflow-y: auto; padding: 20px; }
  .col.left { border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 14px; padding-bottom: 90px; }

  .card { background: linear-gradient(180deg, var(--panel) 0%, #131922 100%); border: 1px solid var(--border); border-radius: var(--r); padding: 15px 16px; }
  .card > .h { display: flex; align-items: center; gap: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .7px; color: var(--muted); font-weight: 650; margin: 0 0 11px; }
  .card.dim { opacity: .45; pointer-events: none; filter: saturate(.5); }
  .card.dim .h::after { content: "off in this mode"; text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--muted); }

  label.fl { display: block; margin: 11px 0 4px; font-size: 12px; color: var(--fg2); font-weight: 500; }
  label.fl:first-of-type { margin-top: 0; }
  input[type=text], input[type=number], textarea {
    width: 100%; background: var(--bg2); border: 1px solid var(--border); color: var(--fg);
    border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: var(--mono); transition: border-color .12s, box-shadow .12s; resize: vertical; }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(68,147,248,.15); }
  input.invalid { border-color: var(--red); box-shadow: 0 0 0 3px rgba(248,81,73,.15); }
  ::placeholder { color: #566170; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 11px; }
  .hint { color: var(--muted); font-size: 11px; margin: 5px 0 0; }
  .err-msg { color: var(--red); font-size: 11px; margin: 5px 0 0; min-height: 0; }

  .check { display: flex; align-items: center; gap: 9px; margin: 9px 0; font-size: 13px; color: var(--fg); cursor: pointer; user-select: none; }
  .check input { appearance: none; width: 16px; height: 16px; border: 1.5px solid var(--border2); border-radius: 5px; background: var(--bg2); display: grid; place-content: center; cursor: pointer; flex: 0 0 auto; transition: .12s; }
  .check input:checked { background: var(--accent); border-color: var(--accent); }
  .check input:checked::after { content: "✓"; color: #fff; font-size: 11px; font-weight: 700; }
  .check.sub { margin-left: 24px; color: var(--fg2); font-size: 12.5px; }
  .check small { color: var(--muted); font-weight: 400; }

  /* segmented mode control */
  .seg { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; background: var(--bg2); border: 1px solid var(--border); border-radius: 9px; padding: 4px; }
  .seg button { all: unset; text-align: center; padding: 9px; border-radius: 6px; font-size: 13px; font-weight: 600; color: var(--fg2); cursor: pointer; transition: .14s; }
  .seg button .sub { display: block; font-size: 10.5px; font-weight: 400; color: var(--muted); margin-top: 1px; }
  .seg button[aria-selected=true] { background: linear-gradient(180deg, var(--accent) 0%, var(--accent-dim) 100%); color: #fff; box-shadow: 0 2px 8px rgba(31,111,235,.35); }
  .seg button[aria-selected=true] .sub { color: rgba(255,255,255,.8); }

  /* chips */
  .chips { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 4px; }
  .chip { padding: 5px 11px; border: 1px solid var(--border2); border-radius: 20px; font-size: 12px; color: var(--fg2); cursor: pointer; background: var(--bg2); transition: .12s; user-select: none; }
  .chip[aria-pressed=true] { background: rgba(68,147,248,.16); border-color: var(--accent); color: #cfe2fd; }

  button.btn { all: unset; cursor: pointer; border-radius: 8px; padding: 9px 15px; font-size: 13px; font-weight: 600; text-align: center; transition: .13s; border: 1px solid var(--border2); color: var(--fg); background: var(--panel2); }
  button.btn:hover { background: var(--hover); border-color: var(--border2); }
  button.btn.primary { background: linear-gradient(180deg, var(--green) 0%, var(--green-dim) 100%); border-color: var(--green-dim); color: #fff; box-shadow: 0 2px 10px rgba(35,134,54,.3); }
  button.btn.primary:hover { filter: brightness(1.07); }
  button.btn.danger { background: linear-gradient(180deg, #f85149 0%, #b62324 100%); border-color: #b62324; color: #fff; }
  button.btn.ghost { background: transparent; }
  button.btn:disabled { opacity: .5; cursor: not-allowed; }
  button.btn.sm { padding: 5px 10px; font-size: 11.5px; font-weight: 500; }

  .runbar { position: fixed; left: 0; width: 410px; bottom: 0; padding: 12px 20px; background: rgba(10,14,20,.9); backdrop-filter: blur(10px); border-top: 1px solid var(--border); border-right: 1px solid var(--border); display: flex; align-items: center; gap: 10px; z-index: 20; }
  .runbar .btn { flex: 1; }
  .runbar .kbd { color: var(--muted); font-size: 10.5px; white-space: nowrap; }

  /* right column */
  h2.sec { font-size: 11px; text-transform: uppercase; letter-spacing: .7px; color: var(--muted); margin: 0 0 11px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
  .section + .section { margin-top: 22px; }

  .progress { background: var(--panel); border: 1px solid var(--border); border-radius: var(--r); padding: 16px 18px; margin-bottom: 16px; }
  .progress .top { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  .progress .phase { font-size: 15px; font-weight: 650; }
  .progress .stat { color: var(--muted); font-size: 12px; }
  .progress .stat b { color: var(--fg2); font-variant-numeric: tabular-nums; font-weight: 600; }
  .progress .stat.timer b { color: var(--accent); }
  .spinner { width: 15px; height: 15px; border: 2px solid var(--border2); border-top-color: var(--accent); border-radius: 50%; animation: spin .7s linear infinite; flex: 0 0 auto; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .steps { display: flex; gap: 6px; }
  .steps .step { flex: 1; height: 4px; border-radius: 3px; background: var(--border); position: relative; overflow: hidden; }
  .steps .step.done { background: var(--green); }
  .steps .step.active { background: var(--border); }
  .steps .step.active::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, var(--accent), transparent); animation: sweep 1.1s linear infinite; }
  @keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
  .steplabels { display: flex; gap: 6px; margin-top: 6px; }
  .steplabels span { flex: 1; text-align: center; font-size: 9.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .4px; }
  .steplabels span.on { color: var(--fg2); }

  .console { background: #07090d; border: 1px solid var(--border); border-radius: var(--r); padding: 13px 15px; font-family: var(--mono); font-size: 12px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; height: 40vh; overflow-y: auto; }
  .console .err { color: #ff7b72; } .console .ok { color: #56d364; } .console .dim { color: var(--muted); } .console .hl { color: var(--purple); }
  .console .empty { color: var(--muted); }

  .result { margin-top: 14px; border: 1px solid var(--green-dim); border-radius: var(--r); background: linear-gradient(180deg, rgba(35,134,54,.12), rgba(35,134,54,.02)); padding: 15px 17px; }
  .result.stopped { border-color: var(--amber); background: linear-gradient(180deg, rgba(210,153,34,.12), transparent); }
  .result.failed { border-color: var(--red); background: linear-gradient(180deg, rgba(248,81,73,.12), transparent); }
  .result h3 { margin: 0 0 4px; font-size: 14px; }
  .result .metrics { display: flex; gap: 18px; margin: 10px 0 13px; flex-wrap: wrap; }
  .result .metric b { display: block; font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .result .metric span { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .4px; }
  .result .acts { display: flex; gap: 9px; flex-wrap: wrap; }
  a.linkbtn { all: unset; cursor: pointer; padding: 7px 13px; border-radius: 7px; font-size: 12.5px; font-weight: 600; background: var(--panel2); border: 1px solid var(--border2); color: var(--fg); transition: .12s; }
  a.linkbtn:hover { background: var(--hover); border-color: var(--accent); }
  a.linkbtn.go { background: var(--accent-dim); border-color: var(--accent); color: #fff; }

  .runs { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
  .runs li { border: 1px solid var(--border); border-radius: var(--r); padding: 12px 14px; background: var(--panel); transition: border-color .12s; }
  .runs li:hover { border-color: var(--border2); }
  .runs .rtop { display: flex; align-items: start; gap: 10px; }
  .runs .url { font-weight: 600; font-size: 13px; word-break: break-all; flex: 1; }
  .runs .meta { color: var(--muted); font-size: 11px; margin-top: 3px; font-family: var(--mono); }
  .runs .pill { font-size: 10px; padding: 2px 8px; border-radius: 20px; font-weight: 600; text-transform: uppercase; letter-spacing: .3px; white-space: nowrap; }
  .pill.done { background: rgba(63,185,80,.15); color: #56d364; }
  .pill.running { background: rgba(68,147,248,.15); color: #79b8ff; }
  .pill.stopped, .pill.deleted { background: rgba(210,153,34,.15); color: #e3b341; }
  .pill.disk { background: rgba(125,135,148,.15); color: var(--muted); }
  .runs .badges { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 7px; }
  .runs .badge { font-size: 10px; padding: 1px 7px; border-radius: 5px; border: 1px solid var(--border); color: var(--muted); }
  .runs .racts { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 10px; }
  .empty-state { color: var(--muted); font-size: 13px; text-align: center; padding: 24px; border: 1px dashed var(--border); border-radius: var(--r); }

  .modal { position: fixed; inset: 0; background: rgba(0,0,0,.62); display: none; align-items: center; justify-content: center; z-index: 50; backdrop-filter: blur(3px); }
  .modal.open { display: flex; }
  .modal .box { background: var(--panel); border: 1px solid var(--border2); border-radius: 14px; padding: 22px; width: 460px; box-shadow: var(--shadow); }
  .modal h3 { margin: 0 0 8px; font-size: 16px; }
  .modal p { color: var(--fg2); font-size: 13px; margin: 0 0 16px; }
  .modal .acts { display: flex; gap: 10px; justify-content: flex-end; }

  .toasts { position: fixed; bottom: 18px; right: 18px; display: flex; flex-direction: column; gap: 8px; z-index: 60; }
  .toast { background: var(--panel2); border: 1px solid var(--border2); border-left: 3px solid var(--accent); border-radius: 8px; padding: 10px 14px; font-size: 12.5px; box-shadow: var(--shadow); animation: slidein .2s ease; max-width: 320px; }
  .toast.ok { border-left-color: var(--green); } .toast.bad { border-left-color: var(--red); }
  @keyframes slidein { from { transform: translateX(20px); opacity: 0; } }

  @media (max-width: 880px) { .wrap { grid-template-columns: 1fr; height: auto; } .col.left { padding-bottom: 20px; } .runbar { position: static; width: auto; } }
</style>
</head>
<body>
<header>
  <span class="logo">🕷</span>
  <h1>crawlshot</h1>
  <span class="ver">control panel</span>
  <span class="spacer"></span>
  <span class="dot"></span><span class="live">server live</span>
</header>

<div class="wrap">
  <!-- ============ LEFT: configuration ============ -->
  <div class="col left">
    <div class="card">
      <div class="h">Target</div>
      <label class="fl">URL(s)</label>
      <textarea id="url" rows="2" placeholder="https://example.com" autocomplete="off" spellcheck="false"></textarea>
      <div class="err-msg" id="urlErr"></div>
      <p class="hint">One URL per line — 2+ runs compare mode.</p>
      <div class="row" style="margin-top:11px">
        <div><label class="fl">Max pages</label><input type="number" id="maxPages" min="1" placeholder="∞" /></div>
        <div><label class="fl">Max depth</label><input type="number" id="maxDepth" min="0" placeholder="∞" /></div>
      </div>
      <div class="row" style="margin-top:11px">
        <div><label class="fl">Include /regex/</label><input type="text" id="include" placeholder="/blog/" spellcheck="false" /></div>
        <div><label class="fl">Exclude /regex/</label><input type="text" id="exclude" placeholder="/tag/" spellcheck="false" /></div>
      </div>
      <label class="fl">Concurrency</label><input type="number" id="concurrency" min="1" placeholder="4" />
    </div>

    <div class="card">
      <div class="h">Mode</div>
      <div class="seg" role="tablist">
        <button id="modeAudit" role="tab" aria-selected="true" type="button">Audit<span class="sub">screenshots + Lighthouse + a11y</span></button>
        <button id="modeMirror" role="tab" aria-selected="false" type="button">Mirror<span class="sub">download the site's assets</span></button>
      </div>

      <!-- Audit-mode options -->
      <div id="auditOpts" style="margin-top:14px">
        <label class="check"><input type="checkbox" id="video" /> Record scrolling video</label>
        <div id="videoOpts" style="display:none; margin-left: 24px">
          <label class="fl" style="margin-top:6px">Viewports</label>
          <div class="chips" id="videoVps">
            <span class="chip" data-v="phone">phone</span><span class="chip" data-v="tablet">tablet</span><span class="chip" aria-pressed="true" data-v="desktop">desktop</span>
          </div>
          <label class="fl">Color schemes</label>
          <div class="chips" id="videoSch">
            <span class="chip" aria-pressed="true" data-v="light">light</span><span class="chip" data-v="dark">dark</span>
          </div>
        </div>
      </div>

      <!-- Mirror-mode options -->
      <div id="mirrorOpts" style="display:none; margin-top:14px">
        <label class="check sub"><input type="checkbox" id="mirrorVideo" /> Media + HLS/DASH <small>(yt-dlp)</small></label>
        <label class="check sub"><input type="checkbox" id="mirrorCrossOrigin" /> Cross-origin (CDN) assets</label>
        <label class="check sub"><input type="checkbox" id="mirrorRewrite" /> Rewrite URLs for offline browsing</label>
      </div>
    </div>

    <div class="card" id="auditCard">
      <div class="h">Audit phases</div>
      <label class="check"><input type="checkbox" id="noLighthouse" /> Skip Lighthouse</label>
      <label class="check"><input type="checkbox" id="noAxe" /> Skip axe (accessibility)</label>
      <label class="check"><input type="checkbox" id="noLinks" /> Skip outbound link checks</label>
      <label class="check"><input type="checkbox" id="noRecon" /> Skip passive recon</label>
      <label class="check"><input type="checkbox" id="noCve" /> Skip CVE correlation</label>
    </div>

    <div class="card">
      <div class="h">Authentication</div>
      <label class="fl">storageState file</label>
      <input type="text" id="authStorage" placeholder="(none — public crawl)" spellcheck="false" />
      <div style="margin-top:10px"><button class="btn ghost sm" id="captureBtn" type="button">🔑 Capture login…</button></div>
      <p class="hint">Opens a browser; log in, save the session for an authenticated crawl.</p>
    </div>

    <div class="card">
      <div class="h">Privacy</div>
      <label class="check"><input type="checkbox" id="verifyIp" /> Require VPN/proxy exit IP before crawling</label>
      <label class="fl">Home IP <small style="color:var(--muted)">(definitive VPN check)</small></label>
      <input type="text" id="homeIp" placeholder="e.g. 81.2.69.x" spellcheck="false" />
    </div>
  </div>

  <!-- runbar pinned to the left column -->
  <div class="runbar">
    <button class="btn primary" id="runBtn" type="button">Run</button>
    <button class="btn danger" id="stopBtn" type="button" style="display:none">Stop</button>
    <span class="kbd">⌘↵</span>
  </div>

  <!-- ============ RIGHT: live + history ============ -->
  <div class="col right">
    <div class="section">
      <div class="progress" id="progress" style="display:none">
        <div class="top">
          <span class="spinner" id="spinner"></span>
          <span class="phase" id="phaseLabel">Idle</span>
          <span class="spacer" style="flex:1"></span>
          <span class="stat">pages <b id="pageCount">0</b></span>
          <span class="stat timer">elapsed <b id="timer">0:00</b></span>
        </div>
        <div class="steps" id="steps"></div>
        <div class="steplabels" id="steplabels"></div>
      </div>

      <h2 class="sec">Run log</h2>
      <div class="console" id="console"><span class="empty">No run yet — configure a target on the left and hit Run (⌘↵).</span></div>
      <div id="resultMount"></div>
    </div>

    <div class="section">
      <h2 class="sec">History <button class="btn ghost sm" id="refreshRuns" type="button" style="margin-left:auto">↻</button></h2>
      <ul class="runs" id="runs"></ul>
    </div>
  </div>
</div>

<div class="modal" id="loginModal">
  <div class="box">
    <h3>🔑 Capture login</h3>
    <p id="loginMsg">A browser window will open. Log into the site, then click “Save session”.</p>
    <div class="acts">
      <button class="btn ghost" id="loginCancel" type="button">Cancel</button>
      <button class="btn primary" id="loginSave" type="button" disabled>Save session</button>
    </div>
  </div>
</div>

<div class="toasts" id="toasts"></div>

<script>
var $ = function (id) { return document.getElementById(id); };
var consoleEl = $("console"), linksMount = $("resultMount");
var es = null, loginSession = null, currentRunId = null, mode = "audit";
var timerInt = null, runStart = 0, pages = 0, doneSteps = {};

var AUDIT_STEPS = [
  { k: "crawl", label: "Crawl", re: /Crawling |crawled →/ },
  { k: "shoot", label: "Shots", re: /Shooting|✓ .*@/ },
  { k: "lh", label: "Lighthouse", re: /Running Lighthouse/ },
  { k: "links", label: "Links", re: /outbound links/ },
  { k: "recon", label: "Recon", re: /site intelligence/ },
  { k: "report", label: "Report", re: /Building results|Writing index|Zipping/ }
];
var MIRROR_STEPS = [
  { k: "crawl", label: "Crawl", re: /Crawling |crawled →/ },
  { k: "mirror", label: "Mirror", re: /Mirroring assets|^Mirror:|mirror: fetched|rewrote/ },
  { k: "report", label: "Report", re: /Building results|Writing index|Zipping/ }
];
function steps() { return mode === "mirror" ? MIRROR_STEPS : AUDIT_STEPS; }

function toast(msg, kind) {
  var t = document.createElement("div");
  t.className = "toast " + (kind || "");
  t.textContent = msg;
  $("toasts").appendChild(t);
  setTimeout(function () { t.style.transition = "opacity .3s"; t.style.opacity = "0"; setTimeout(function () { t.remove(); }, 300); }, 3200);
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
function fmtDur(ms) { if (ms == null) return ""; var s = Math.round(ms / 1000); return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2); }

function logLine(text, cls) {
  var span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text + "\\n";
  consoleEl.appendChild(span);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}
function classify(line) {
  if (/error|fail|✗|Aborting/i.test(line)) return "err";
  if (/✓|Done|success|↻|→/i.test(line)) return "ok";
  if (/^(Crawling|Found|Running|Checking|Recording|Gathering|Building|Writing|Zipping|Mirror:|Output:)/.test(line)) return "hl";
  return null;
}

// ---- progress -------------------------------------------------------------
function renderSteps() {
  var st = steps(), bar = $("steps"), labels = $("steplabels");
  bar.innerHTML = ""; labels.innerHTML = "";
  st.forEach(function (s) {
    var d = document.createElement("div");
    d.className = "step" + (doneSteps[s.k] === 2 ? " done" : doneSteps[s.k] === 1 ? " active" : "");
    d.id = "step-" + s.k; bar.appendChild(d);
    var l = document.createElement("span");
    l.textContent = s.label; l.className = doneSteps[s.k] ? "on" : ""; labels.appendChild(l);
  });
}
function updatePhase(line) {
  var st = steps(), idx = -1;
  for (var i = 0; i < st.length; i++) if (st[i].re.test(line)) idx = i;
  if (idx < 0) return;
  for (var j = 0; j < st.length; j++) doneSteps[st[j].k] = j < idx ? 2 : (j === idx ? 1 : (doneSteps[st[j].k] || 0));
  $("phaseLabel").textContent = st[idx].label + "…";
  renderSteps();
}
function startTimer() {
  runStart = Date.now(); pages = 0; doneSteps = {};
  $("pageCount").textContent = "0"; $("timer").textContent = "0:00";
  $("progress").style.display = ""; $("spinner").style.display = "";
  $("phaseLabel").textContent = "Starting…"; renderSteps();
  timerInt = setInterval(function () { $("timer").textContent = fmtDur(Date.now() - runStart); }, 1000);
}
function stopTimer() { if (timerInt) clearInterval(timerInt); timerInt = null; $("spinner").style.display = "none"; }

// ---- form state -----------------------------------------------------------
function chipVals(id) { return Array.prototype.slice.call($(id).querySelectorAll('[aria-pressed=true]')).map(function (c) { return c.dataset.v; }); }
function setChips(id, vals) { Array.prototype.forEach.call($(id).querySelectorAll(".chip"), function (c) { c.setAttribute("aria-pressed", vals.indexOf(c.dataset.v) >= 0 ? "true" : "false"); }); }

function collect() {
  var v = function (id) { return $(id).value.trim(); };
  var c = function (id) { return $(id).checked; };
  return {
    url: $("url").value,
    maxPages: v("maxPages") || null, maxDepth: v("maxDepth") || null,
    include: v("include") || null, exclude: v("exclude") || null, concurrency: v("concurrency") || null,
    mirror: mode === "mirror",
    mirrorVideo: c("mirrorVideo"), mirrorCrossOrigin: c("mirrorCrossOrigin"), mirrorRewrite: c("mirrorRewrite"),
    video: mode === "audit" && c("video"),
    videoViewports: chipVals("videoVps"), videoSchemes: chipVals("videoSch"),
    noLighthouse: c("noLighthouse"), noAxe: c("noAxe"), noLinks: c("noLinks"), noRecon: c("noRecon"), noCve: c("noCve"),
    authStorage: v("authStorage") || null, verifyIp: c("verifyIp"), homeIp: v("homeIp") || null
  };
}
function apply(o) {
  o = o || {};
  setMode(o.mirror ? "mirror" : "audit");
  var set = function (id, val) { if ($(id)) $(id).value = val == null ? "" : val; };
  var chk = function (id, val) { if ($(id)) $(id).checked = !!val; };
  set("url", Array.isArray(o.urls) ? o.urls.join("\\n") : (o.url || ""));
  set("maxPages", o.maxPages); set("maxDepth", o.maxDepth); set("include", o.include); set("exclude", o.exclude); set("concurrency", o.concurrency);
  chk("mirrorVideo", o.mirrorVideo); chk("mirrorCrossOrigin", o.mirrorCrossOrigin); chk("mirrorRewrite", o.mirrorRewrite);
  chk("video", o.video);
  if (o.videoViewports) setChips("videoVps", o.videoViewports);
  if (o.videoSchemes) setChips("videoSch", o.videoSchemes);
  chk("noLighthouse", o.noLighthouse); chk("noAxe", o.noAxe); chk("noLinks", o.noLinks); chk("noRecon", o.noRecon); chk("noCve", o.noCve);
  set("authStorage", o.authStorage); chk("verifyIp", o.verifyIp); set("homeIp", o.homeIp);
  $("videoOpts").style.display = $("video").checked ? "" : "none";
  persist();
}
function persist() { try { localStorage.setItem("crawlshot.form", JSON.stringify(collect())); } catch (e) {} }
function restore() { try { var s = localStorage.getItem("crawlshot.form"); if (s) apply(JSON.parse(s)); } catch (e) {} }

function setMode(m) {
  mode = m;
  $("modeAudit").setAttribute("aria-selected", m === "audit" ? "true" : "false");
  $("modeMirror").setAttribute("aria-selected", m === "mirror" ? "true" : "false");
  $("auditOpts").style.display = m === "audit" ? "" : "none";
  $("mirrorOpts").style.display = m === "mirror" ? "" : "none";
  $("auditCard").classList.toggle("dim", m === "mirror");
}

// ---- validation -----------------------------------------------------------
function validate() {
  var urls = $("url").value.split(/\\r?\\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  var bad = urls.filter(function (u) { return !/^https?:\\/\\/\\S+$/i.test(u); });
  var ok = urls.length > 0 && bad.length === 0;
  $("url").classList.toggle("invalid", urls.length > 0 && bad.length > 0);
  $("urlErr").textContent = bad.length ? "Not a valid URL: " + bad[0] : "";
  ["include", "exclude"].forEach(function (id) {
    var val = $(id).value.trim(); var good = true;
    if (val) try { new RegExp(val); } catch (e) { good = false; }
    $(id).classList.toggle("invalid", !good);
  });
  return ok;
}

// ---- run ------------------------------------------------------------------
function run() {
  if (!validate()) { toast("Enter at least one valid URL", "bad"); return; }
  var opts = collect(); persist();
  consoleEl.innerHTML = ""; linksMount.innerHTML = "";
  $("runBtn").disabled = true; startTimer();
  fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(opts) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (res.error) { logLine("Error: " + res.error, "err"); endRun(); toast(res.error, "bad"); return; }
      currentRunId = res.runId; $("stopBtn").style.display = ""; $("stopBtn").disabled = false;
      stream(res.runId, opts);
    })
    .catch(function (e) { logLine("Failed to start: " + e, "err"); endRun(); });
}
function endRun() { $("runBtn").disabled = false; $("stopBtn").style.display = "none"; currentRunId = null; stopTimer(); }

function stream(runId, opts) {
  if (es) es.close();
  var foundPages = null, mirrorSaved = null;
  es = new EventSource("/api/run/" + runId + "/stream");
  es.onmessage = function (ev) {
    var m = JSON.parse(ev.data);
    if (m.type === "log") {
      logLine(m.line, classify(m.line));
      updatePhase(m.line);
      if (/crawled →/.test(m.line)) { pages++; $("pageCount").textContent = pages; }
      var fp = m.line.match(/Found (\\d+) page/); if (fp) foundPages = +fp[1];
      var ms = m.line.match(/Mirror: \\d+ page\\(s\\).*?(\\d+) asset/); if (ms) mirrorSaved = +ms[1];
    } else if (m.type === "done") {
      es.close(); endRun();
      Object.keys(doneSteps).forEach(function (k) { if (doneSteps[k] === 1) doneSteps[k] = 2; }); renderSteps();
      $("phaseLabel").textContent = m.stopped ? "Stopped" : (m.code === 0 ? "Complete" : "Failed");
      showResult(m, opts, { pages: foundPages || pages, assets: mirrorSaved });
      if (!m.stopped && m.code === 0) toast("Run complete", "ok"); else if (m.stopped) toast("Run stopped", ""); else toast("Run failed (exit " + m.code + ")", "bad");
      loadRuns();
    }
  };
  es.onerror = function () { if (es) es.close(); endRun(); };
}

function showResult(m, opts, stats) {
  var cls = m.stopped ? "stopped" : (m.code === 0 ? "" : "failed");
  var title = m.stopped ? "⏹ Stopped" : (m.code === 0 ? "✓ Complete" : "✕ Failed (exit " + m.code + ")");
  var metrics = '<div class="metric"><b>' + (stats.pages || 0) + '</b><span>pages</span></div>' +
    (stats.assets != null ? '<div class="metric"><b>' + stats.assets + '</b><span>assets</span></div>' : '') +
    '<div class="metric"><b>' + fmtDur(Date.now() - runStart) + '</b><span>elapsed</span></div>';
  var acts = "";
  if (m.folder) {
    var f = encodeURIComponent(m.folder);
    acts = '<a class="linkbtn go" href="/files/' + f + '/index.html" target="_blank">Open dashboard ↗</a>' +
      (m.hasMirror ? '<a class="linkbtn" href="/files/' + f + '/mirror/manifest.json" target="_blank">Mirror manifest ↗</a>' : '') +
      '<a class="linkbtn" href="/api/reveal/' + f + '">Reveal in Finder</a>';
  }
  linksMount.innerHTML = '<div class="result ' + cls + '"><h3>' + title + '</h3>' +
    (m.folder ? '<div style="font-family:var(--mono);font-size:11px;color:var(--muted)">' + esc(m.folder) + '</div>' : '') +
    '<div class="metrics">' + metrics + '</div><div class="acts">' + acts + '</div></div>';
}

function stop() {
  if (!currentRunId) return;
  $("stopBtn").disabled = true; logLine("Stopping…", "dim");
  fetch("/api/run/" + currentRunId + "/stop", { method: "POST" }).catch(function () {});
}

// ---- login capture --------------------------------------------------------
function startLogin() {
  if (!validate()) { toast("Enter the URL to log into first", "bad"); return; }
  var url = $("url").value.split(/\\r?\\n/).map(function (s) { return s.trim(); }).filter(Boolean)[0];
  $("loginModal").classList.add("open"); $("loginSave").disabled = true; $("loginMsg").textContent = "Opening browser…";
  fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: url }) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (res.error) { $("loginMsg").textContent = "Error: " + res.error; return; }
      loginSession = res.sessionId;
      $("loginMsg").textContent = "Browser open. Log in, then click “Save session”.";
      $("loginSave").disabled = false;
    })
    .catch(function (e) { $("loginMsg").textContent = "Failed: " + e; });
}
function saveLogin() {
  if (!loginSession) return;
  $("loginSave").disabled = true; $("loginMsg").textContent = "Saving…";
  fetch("/api/login/" + loginSession + "/save", { method: "POST" }).then(function (r) { return r.json(); }).then(function (res) {
    if (res.error) { $("loginMsg").textContent = "Error: " + res.error; return; }
    $("authStorage").value = res.path; persist();
    $("loginModal").classList.remove("open"); loginSession = null; toast("Session saved", "ok");
  });
}
function cancelLogin() {
  if (loginSession) fetch("/api/login/" + loginSession + "/cancel", { method: "POST" });
  $("loginModal").classList.remove("open"); loginSession = null;
}

// ---- history --------------------------------------------------------------
function loadRuns() {
  fetch("/api/runs").then(function (r) { return r.json(); }).then(function (runs) {
    var ul = $("runs"); ul.innerHTML = "";
    if (!runs.length) { ul.innerHTML = '<div class="empty-state">No runs yet.</div>'; return; }
    runs.forEach(function (r, i) {
      var li = document.createElement("li");
      var title = (r.urls && r.urls.length) ? esc(r.urls.join(", ")) : esc(r.folder || "(no output)");
      var statusCls = r.missing ? "deleted" : (r.status === "on disk" ? "disk" : r.status);
      var statusTxt = r.missing ? "deleted" : r.status;
      var meta = esc(r.when) + (r.durationMs ? " · " + fmtDur(r.durationMs) : "");
      var badges = [];
      if (r.opts && r.opts.mirror) badges.push("mirror"); else badges.push("audit");
      if (r.opts && r.opts.mirrorVideo) badges.push("video");
      if (r.opts && r.opts.video) badges.push("video");
      if (r.opts && r.opts.authStorage) badges.push("auth");
      if (r.hasMirror) badges.push("mirror saved");
      var canOpen = r.folder && !r.missing;
      var f = r.folder ? encodeURIComponent(r.folder) : "";
      li.innerHTML =
        '<div class="rtop"><div class="url">' + title + '</div><span class="pill ' + statusCls + '">' + esc(statusTxt) + '</span></div>' +
        '<div class="meta">' + meta + (r.folder ? " · " + esc(r.folder) : "") + '</div>' +
        '<div class="badges">' + badges.map(function (b) { return '<span class="badge">' + esc(b) + '</span>'; }).join("") + '</div>' +
        '<div class="racts">' +
          (r.opts ? '<button class="btn ghost sm" data-rerun="' + i + '">↺ Re-run</button>' : "") +
          (canOpen && r.hasDashboard ? '<a class="linkbtn" style="padding:5px 10px;font-size:11.5px" href="/files/' + f + '/index.html" target="_blank">Dashboard ↗</a>' : "") +
          (canOpen && r.hasMirror ? '<a class="linkbtn" style="padding:5px 10px;font-size:11.5px" href="/files/' + f + '/mirror/manifest.json" target="_blank">Mirror ↗</a>' : "") +
          (canOpen ? '<button class="btn ghost sm" data-reveal="' + f + '">Finder</button>' : "") +
          (canOpen ? '<button class="btn ghost sm" data-del="' + f + '" style="color:var(--red)">Delete</button>' : "") +
        '</div>';
      ul.appendChild(li);
      var rerunBtn = li.querySelector("[data-rerun]");
      if (rerunBtn) rerunBtn.onclick = function () { apply(r.opts); toast("Config loaded — hit Run", ""); $("url").scrollIntoView({ behavior: "smooth" }); };
      var revBtn = li.querySelector("[data-reveal]");
      if (revBtn) revBtn.onclick = function () { fetch("/api/reveal/" + revBtn.dataset.reveal); };
      var delBtn = li.querySelector("[data-del]");
      if (delBtn) delBtn.onclick = function () {
        if (!confirm("Delete this run's output folder and zip?")) return;
        fetch("/api/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder: delBtn.dataset.del }) })
          .then(function (r) { return r.json(); }).then(function (res) { if (res.error) toast(res.error, "bad"); else { toast("Deleted", "ok"); loadRuns(); } });
      };
    });
  }).catch(function () {});
}

// ---- wiring ---------------------------------------------------------------
$("modeAudit").onclick = function () { setMode("audit"); persist(); };
$("modeMirror").onclick = function () { setMode("mirror"); persist(); };
$("video").onchange = function () { $("videoOpts").style.display = this.checked ? "" : "none"; persist(); };
Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (c) {
  c.onclick = function () { c.setAttribute("aria-pressed", c.getAttribute("aria-pressed") === "true" ? "false" : "true"); persist(); };
});
$("runBtn").onclick = run;
$("stopBtn").onclick = stop;
$("captureBtn").onclick = startLogin;
$("loginSave").onclick = saveLogin;
$("loginCancel").onclick = cancelLogin;
$("refreshRuns").onclick = loadRuns;
$("url").oninput = function () { validate(); persist(); };
["maxPages", "maxDepth", "include", "exclude", "concurrency", "authStorage", "homeIp"].forEach(function (id) { $(id).oninput = persist; });
["mirrorVideo", "mirrorCrossOrigin", "mirrorRewrite", "noLighthouse", "noAxe", "noLinks", "noRecon", "noCve", "verifyIp"].forEach(function (id) { $(id).onchange = persist; });
document.addEventListener("keydown", function (e) { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); if (!$("runBtn").disabled) run(); } });

restore();
loadRuns();
</script>
</body>
</html>`;
