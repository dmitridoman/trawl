import http from "node:http";
import { spawn, type ChildProcess, execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { UI_HTML } from "./ui";

// ---------------------------------------------------------------------------
// trawl local control panel — a tiny dependency-free web UI that builds the
// CLI flag set from a form, spawns the bundled trawl CLI, streams its logs
// to the browser over SSE, captures authenticated sessions via a headed
// Playwright window, and serves the resulting dashboards/mirrors for viewing.
//
// Binds to 127.0.0.1 only. Not an authenticated server — it's a personal tool.
// ---------------------------------------------------------------------------

const HOST = "127.0.0.1";
const PORT = Number(process.env.TRAWL_PORT || process.env.CRAWLSHOT_PORT || 4317);
const DOWNLOADS = path.join(os.homedir(), "Downloads");
const CONFIG_DIR = path.join(os.homedir(), ".trawl");
// Migrate config (saved auth sessions + run history) from the pre-rename
// ~/.crawlshot directory, one time, if the new location doesn't exist yet.
{
  const legacy = path.join(os.homedir(), ".crawlshot");
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(CONFIG_DIR)) fs.renameSync(legacy, CONFIG_DIR);
  } catch {}
}
// Output run folders are prefixed "trawl-" now; "crawlshot-" folders from
// before the rename are still recognised so old captures stay browsable.
const RUN_PREFIX = /^(?:trawl|crawlshot)-/;
const AUTH_DIR = path.join(CONFIG_DIR, "auth");
const HISTORY_FILE = path.join(CONFIG_DIR, "history.json");
const CLI = path.join(__dirname, "index.js"); // sibling bundle

type RunState = {
  id: string;
  proc: ChildProcess;
  lines: string[];
  status: "running" | "done" | "stopped";
  code: number | null;
  folder: string | null;
  hasMirror: boolean;
  clients: Set<http.ServerResponse>;
};

type LoginSession = { browser: Browser; context: BrowserContext; host: string };

const runs = new Map<string, RunState>();
const logins = new Map<string, LoginSession>();

const id = () => crypto.randomBytes(6).toString("hex");

// ---- Flag builder ---------------------------------------------------------

type RunOpts = Record<string, unknown>;

function isHttpUrl(s: unknown): s is string {
  return typeof s === "string" && /^https?:\/\/\S+$/i.test(s);
}

function buildArgs(o: RunOpts): { args: string[]; urls: string[] } | { error: string } {
  // The URL field may hold several URLs, one per line → compare mode.
  const urls = typeof o.url === "string" ? o.url.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  if (urls.length === 0) return { error: "At least one http(s) URL is required" };
  for (const u of urls) if (!isHttpUrl(u)) return { error: `Invalid URL: ${u}` };
  const args: string[] = [...urls];

  const numFlag = (key: string, flag: string) => {
    const raw = o[key];
    if (raw === null || raw === undefined || raw === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return;
    args.push(flag, String(n));
  };
  const strFlag = (key: string, flag: string) => {
    const raw = o[key];
    if (typeof raw === "string" && raw.trim()) args.push(flag, raw.trim());
  };
  const bool = (key: string, flag: string) => {
    if (o[key] === true) args.push(flag);
  };
  const multiFlag = (key: string, flag: string, allowed: string[]) => {
    const raw = o[key];
    if (!Array.isArray(raw)) return;
    for (const v of raw) if (typeof v === "string" && allowed.includes(v)) args.push(flag, v);
  };

  numFlag("maxPages", "--max-pages");
  numFlag("maxDepth", "--max-depth");
  numFlag("concurrency", "--concurrency");
  strFlag("include", "--include");
  strFlag("exclude", "--exclude");
  bool("mirror", "--mirror");
  bool("mirrorVideo", "--mirror-video");
  bool("mirrorCrossOrigin", "--mirror-cross-origin");
  bool("mirrorRewrite", "--mirror-rewrite");
  bool("mirrorMedia", "--mirror-media");
  bool("noLighthouse", "--no-lighthouse");
  bool("noAxe", "--no-axe");
  bool("noLinks", "--no-links");
  bool("noRecon", "--no-recon");
  bool("noCve", "--no-cve");
  bool("video", "--video");
  strFlag("videoPages", "--video-pages");
  multiFlag("videoViewports", "--video-viewport", ["phone", "tablet", "desktop"]);
  multiFlag("videoSchemes", "--video-scheme", ["light", "dark"]);
  bool("verifyIp", "--verify-ip");
  strFlag("homeIp", "--home-ip");

  // Only accept an auth-storage path that exists and is a readable file.
  const auth = o.authStorage;
  if (typeof auth === "string" && auth.trim()) {
    const p = path.resolve(auth.trim());
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return { error: `auth-storage file not found: ${auth}` };
    args.push("--auth-storage", p);
  }

  return { args, urls };
}

// ---- Persisted run history (~/.trawl/history.json) --------------------

type HistoryRecord = {
  runId: string;
  urls: string[];
  opts: RunOpts; // the submitted options, so a run can be re-run from history
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "done" | "stopped";
  code: number | null;
  folder: string | null;
  hasMirror: boolean;
};

function loadHistory(): HistoryRecord[] {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveHistory(records: HistoryRecord[]): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(records.slice(-200), null, 2));
  } catch {
    // best-effort; history is non-critical
  }
}

function pushHistory(rec: HistoryRecord): void {
  const all = loadHistory();
  all.push(rec);
  saveHistory(all);
}

function updateHistory(runId: string, patch: Partial<HistoryRecord>): void {
  const all = loadHistory();
  const i = all.findIndex((r) => r.runId === runId);
  if (i >= 0) {
    all[i] = { ...all[i]!, ...patch };
    saveHistory(all);
  }
}

// Delete a run's output folder (+ its sibling .zip) and drop it from history.
// Strictly scoped to trawl-* folders directly under Downloads.
function deleteRun(folder: string): { ok: true } | { error: string } {
  if (!RUN_PREFIX.test(folder) || folder.includes("/") || folder.includes("..")) {
    return { error: "Invalid folder" };
  }
  const dir = path.join(DOWNLOADS, folder);
  if (path.dirname(dir) !== DOWNLOADS) return { error: "Invalid folder" };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir + ".zip", { force: true });
  } catch (err) {
    return { error: (err as Error).message };
  }
  saveHistory(loadHistory().filter((r) => r.folder !== folder));
  return { ok: true };
}

// ---- Run lifecycle --------------------------------------------------------

function broadcast(run: RunState, payload: unknown): void {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of run.clients) res.write(data);
}

function startRun(o: RunOpts): { runId: string } | { error: string } {
  const built = buildArgs(o);
  if ("error" in built) return built;

  const runId = id();
  // detached so we can signal the whole process group on stop (the CLI spawns
  // Chromium children we don't want orphaned).
  const proc = spawn(process.execPath, [CLI, ...built.args], {
    cwd: DOWNLOADS,
    env: { ...process.env },
    detached: true,
  });
  const run: RunState = { id: runId, proc, lines: [], status: "running", code: null, folder: null, hasMirror: false, clients: new Set() };
  runs.set(runId, run);
  pushHistory({
    runId,
    urls: built.urls,
    opts: o,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    code: null,
    folder: null,
    hasMirror: false,
  });

  const onChunk = (buf: Buffer) => {
    const text = buf.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line === "") continue;
      run.lines.push(line);
      const m = line.match(/^Output:\s+(.+)$/);
      if (m) {
        const dir = m[1]!.trim();
        run.folder = path.basename(dir);
        run.hasMirror = fs.existsSync(path.join(dir, "mirror"));
      }
      broadcast(run, { type: "log", line });
    }
  };
  proc.stdout?.on("data", onChunk);
  proc.stderr?.on("data", onChunk);
  proc.on("close", (code) => {
    const stopped = run.status === "stopped";
    run.status = stopped ? "stopped" : "done";
    run.code = code ?? -1;
    broadcast(run, { type: "done", code: run.code, folder: run.folder, hasMirror: run.hasMirror, stopped });
    for (const res of run.clients) res.end();
    run.clients.clear();
    updateHistory(runId, {
      finishedAt: new Date().toISOString(),
      status: run.status as HistoryRecord["status"],
      code: run.code,
      folder: run.folder,
      hasMirror: run.hasMirror,
    });
  });

  return { runId };
}

function stopRun(runId: string): { ok: true } | { error: string } {
  const run = runs.get(runId);
  if (!run) return { error: "Run not found" };
  if (run.status !== "running") return { error: "Run is not in progress" };
  run.status = "stopped";
  const pid = run.proc.pid;
  try {
    if (pid) process.kill(-pid, "SIGTERM"); // whole group
    else run.proc.kill("SIGTERM");
  } catch {
    run.proc.kill("SIGTERM");
  }
  return { ok: true };
}

// ---- Login capture --------------------------------------------------------

async function startLogin(url: string): Promise<{ sessionId: string } | { error: string }> {
  if (!isHttpUrl(url)) return { error: "A valid http(s) URL is required" };
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { error: "Invalid URL" };
  }
  const browser = await chromium.launch({ headless: false, args: ["--ignore-certificate-errors"] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  const sessionId = id();
  logins.set(sessionId, { browser, context, host });
  return { sessionId };
}

async function saveLogin(sessionId: string): Promise<{ path: string } | { error: string }> {
  const sess = logins.get(sessionId);
  if (!sess) return { error: "Login session not found (already saved or cancelled)" };
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(AUTH_DIR, `${sess.host}-${stamp}.json`);
  await sess.context.storageState({ path: file });
  await sess.browser.close().catch(() => {});
  logins.delete(sessionId);
  return { path: file };
}

async function cancelLogin(sessionId: string): Promise<void> {
  const sess = logins.get(sessionId);
  if (!sess) return;
  await sess.browser.close().catch(() => {});
  logins.delete(sessionId);
}

// ---- Run history ----------------------------------------------------------

// Persisted UI-initiated runs first (survives restarts, carries config/status),
// then any trawl-* folders found on disk that history doesn't know about.
function listRuns(): unknown[] {
  const out: unknown[] = [];
  const seenFolders = new Set<string>();

  for (const h of loadHistory().slice().reverse()) {
    const dir = h.folder ? path.join(DOWNLOADS, h.folder) : null;
    const exists = !!dir && fs.existsSync(dir);
    if (h.folder) seenFolders.add(h.folder);
    out.push({
      folder: h.folder,
      urls: h.urls,
      opts: h.opts ?? null,
      status: h.status,
      code: h.code,
      startedAt: h.startedAt,
      finishedAt: h.finishedAt,
      durationMs: h.finishedAt ? new Date(h.finishedAt).getTime() - new Date(h.startedAt).getTime() : null,
      when: new Date(h.finishedAt || h.startedAt).toLocaleString(),
      hasDashboard: exists ? fs.existsSync(path.join(dir!, "index.html")) : false,
      hasMirror: exists ? fs.existsSync(path.join(dir!, "mirror")) : false,
      missing: !!h.folder && !exists,
    });
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(DOWNLOADS, { withFileTypes: true });
  } catch {
    /* ignore */
  }
  const disk = entries
    .filter((e) => e.isDirectory() && RUN_PREFIX.test(e.name) && !seenFolders.has(e.name))
    .map((e) => {
      const dir = path.join(DOWNLOADS, e.name);
      const stat = fs.statSync(dir);
      return {
        folder: e.name,
        urls: [] as string[],
        status: "on disk",
        code: null,
        mtime: stat.mtimeMs,
        when: new Date(stat.mtimeMs).toLocaleString(),
        hasDashboard: fs.existsSync(path.join(dir, "index.html")),
        hasMirror: fs.existsSync(path.join(dir, "mirror")),
        missing: false,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return [...out, ...disk].slice(0, 60);
}

// ---- File serving (guarded) -----------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".json": "application/json", ".css": "text/css",
  ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".webm": "video/webm", ".mp4": "video/mp4", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2",
};

function serveFile(folder: string, rest: string, res: http.ServerResponse): void {
  // Resolve strictly under a trawl-* run folder in Downloads; reject traversal.
  if (!RUN_PREFIX.test(folder)) return notFound(res);
  const base = path.join(DOWNLOADS, folder);
  const target = path.join(base, rest);
  if (path.relative(base, target).startsWith("..") || !target.startsWith(base)) return notFound(res);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return notFound(res);
  res.writeHead(200, { "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(target).pipe(res);
}

// ---- HTTP plumbing --------------------------------------------------------

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}
function json(res: http.ServerResponse, body: unknown, code = 200): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method || "GET";

  try {
    if (url.pathname === "/" && method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(UI_HTML);
    }

    if (url.pathname === "/api/run" && method === "POST") {
      const result = startRun((await readBody(req)) as RunOpts);
      return json(res, result, "error" in result ? 400 : 200);
    }

    // Stop an in-flight run: /api/run/:id/stop
    if (parts[0] === "api" && parts[1] === "run" && parts[3] === "stop" && method === "POST") {
      const result = stopRun(parts[2]!);
      return json(res, result, "error" in result ? 400 : 200);
    }

    // SSE: /api/run/:id/stream
    if (parts[0] === "api" && parts[1] === "run" && parts[3] === "stream" && method === "GET") {
      const run = runs.get(parts[2]!);
      if (!run) return notFound(res);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const line of run.lines) res.write(`data: ${JSON.stringify({ type: "log", line })}\n\n`);
      if (run.status !== "running") {
        res.write(`data: ${JSON.stringify({ type: "done", code: run.code, folder: run.folder, hasMirror: run.hasMirror, stopped: run.status === "stopped" })}\n\n`);
        return res.end();
      }
      run.clients.add(res);
      req.on("close", () => run.clients.delete(res));
      return;
    }

    if (url.pathname === "/api/login" && method === "POST") {
      const body = (await readBody(req)) as { url?: string };
      return json(res, await startLogin(body.url || ""));
    }
    if (parts[0] === "api" && parts[1] === "login" && parts[3] === "save" && method === "POST") {
      return json(res, await saveLogin(parts[2]!));
    }
    if (parts[0] === "api" && parts[1] === "login" && parts[3] === "cancel" && method === "POST") {
      await cancelLogin(parts[2]!);
      return json(res, { ok: true });
    }

    if (url.pathname === "/api/runs" && method === "GET") {
      return json(res, listRuns());
    }

    // Delete a run folder + drop it from history.
    if (parts[0] === "api" && parts[1] === "delete" && method === "POST") {
      const body = (await readBody(req)) as { folder?: string };
      return json(res, deleteRun(body.folder || ""));
    }

    // Reveal a run folder in Finder (macOS).
    if (parts[0] === "api" && parts[1] === "reveal" && method === "GET") {
      const folder = decodeURIComponent(parts[2] || "");
      if (RUN_PREFIX.test(folder)) {
        execFile("open", [path.join(DOWNLOADS, folder)], () => {});
      }
      res.writeHead(204);
      return res.end();
    }

    // Serve run output: /files/:folder/<rest...>
    if (parts[0] === "files" && method === "GET") {
      const folder = decodeURIComponent(parts[1] || "");
      const rest = parts.slice(2).map(decodeURIComponent).join("/");
      return serveFile(folder, rest, res);
    }

    return notFound(res);
  } catch (err) {
    json(res, { error: (err as Error).message }, 500);
  }
});

server.listen(PORT, HOST, () => {
  const addr = `http://${HOST}:${PORT}`;
  console.log(`\nTrawl control panel → ${addr}\n`);
  // Best-effort: open the panel in the default browser on macOS (set
  // TRAWL_NO_OPEN=1 to suppress).
  if (process.platform === "darwin" && !process.env.TRAWL_NO_OPEN) execFile("open", [addr], () => {});
});
