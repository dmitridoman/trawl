import { request, type Page, type BrowserContext, type APIRequestContext, type Response } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { toSlug, type PageRecord, type RunOptions } from "./util";

// ---------------------------------------------------------------------------
// Mirror mode — download a site's own assets to disk.
//
// Two confirmed use cases: (a) extract specific assets from an authorized site,
// (b) competitive/design reference (capture markup, CSS, JS, structure).
//
// Mechanism is a hybrid: a non-intercepting `page.on("response")` observer sees
// every resource the page actually fetches (including JS-injected assets and
// HLS/DASH playlist URLs that never appear in the initial HTML). Small text
// resources are captured from the live response body; large/media/partial(206)
// resources are re-fetched cleanly out-of-band via the context's APIRequestContext
// with no Range header, so we always store full bytes rather than a partial slice.
//
// Same-origin only by default; no DRM circumvention (yt-dlp is invoked with no
// key/license flags — protected streams simply fail and are recorded as such).
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);

// Inline-capture (from the live response) only small text resources; everything
// else is re-fetched cleanly to dodge the 206-partial and post-navigation
// `response.body()` gotchas.
const INLINE_MAX_BYTES = 5 * 1024 * 1024;
const INLINE_TYPE = /^(text\/|application\/(json|javascript|x-javascript|xml|.*\+xml)|image\/svg)/i;
const MEDIA_TYPE = /^(video|audio)\//i;
const STREAM_MANIFEST = /\.(m3u8|mpd)(\?|$)/i;
const STREAM_TYPE = /(mpegurl|dash\+xml)/i;
const ASSET_RESOURCE_TYPES = new Set(["stylesheet", "script", "image", "font"]);

export type AssetStatus = number | "skipped" | "error" | "pending";

export type AssetEntry = {
  url: string;
  localPath: string | null; // relative to mirror/, null if not saved
  status: AssetStatus;
  contentType: string | null;
  bytes: number | null;
  via: "inline" | "fetch" | "yt-dlp";
  fromPage: string; // slug of the page that referenced it
  note?: string;
};

export type MirrorManifest = {
  site: string;
  pages: { slug: string; url: string; htmlPath: string }[];
  assets: AssetEntry[];
};

export type MirrorState = {
  outDir: string; // crawlshot-<label>-<stamp>/
  root: string; // <outDir>/mirror
  assetDir: string; // <root>/assets
  pagesDir: string; // <root>/pages
  mediaDir: string; // <root>/media
  seen: Map<string, AssetEntry>; // dedup + cross-worker collision guard, keyed by URL (no fragment)
  streams: Map<string, string>; // HLS/DASH manifest URL -> page slug, resolved post-crawl
  htmlPages: { slug: string; url: string; htmlPath: string }[];
  opts: RunOptions;
  origin: string | null; // resolved base origin, set by the crawler once known
  toolAvail: { ytDlp: boolean; ffmpeg: boolean } | null; // memoized binary probe
};

export function createMirrorState(outDir: string, opts: RunOptions): MirrorState {
  const root = path.join(outDir, "mirror");
  const state: MirrorState = {
    outDir,
    root,
    assetDir: path.join(root, "assets"),
    pagesDir: path.join(root, "pages"),
    mediaDir: path.join(root, "media"),
    seen: new Map(),
    streams: new Map(),
    htmlPages: [],
    opts,
    origin: null,
    toolAvail: null,
  };
  fs.mkdirSync(state.pagesDir, { recursive: true });
  fs.mkdirSync(state.assetDir, { recursive: true });
  return state;
}

const stripFrag = (url: string): string => url.split("#")[0]!;

function sanitizeSeg(seg: string): string {
  const clean = seg.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return clean || "_";
}

// Deterministic, sanitized, collision-resistant local path for a remote URL.
// Same URL always maps to the same path (idempotent writes); the query string,
// when present, is hashed into the filename so `foo.js?v=3` and `foo.js?v=4`
// don't clobber each other.
export function localPathForUrl(url: string, assetDir: string): string {
  const u = new URL(url);
  const host = sanitizeSeg(u.hostname);
  let pathname = u.pathname;
  if (pathname === "" || pathname.endsWith("/")) pathname += "index.html";
  const segs = pathname.split("/").filter(Boolean).map(sanitizeSeg);
  let file = segs.pop() || "index.html";
  if (u.search) {
    const h = crypto.createHash("sha1").update(u.search).digest("hex").slice(0, 8);
    const dot = file.lastIndexOf(".");
    file = dot > 0 ? `${file.slice(0, dot)}.q${h}${file.slice(dot)}` : `${file}.q${h}`;
  }
  return path.join(assetDir, host, ...segs, file);
}

function recordSkipped(state: MirrorState, url: string, fromPage: string, via: AssetEntry["via"], note: string): void {
  state.seen.set(url, { url, localPath: null, status: "skipped", contentType: null, bytes: null, via, fromPage, note });
}

function writeAsset(
  state: MirrorState,
  url: string,
  buf: Buffer,
  contentType: string | null,
  status: number,
  via: AssetEntry["via"],
  fromPage: string,
): void {
  const dest = localPathForUrl(url, state.assetDir);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    state.seen.set(url, {
      url,
      localPath: path.relative(state.root, dest),
      status,
      contentType,
      bytes: buf.length,
      via,
      fromPage,
    });
  } catch (err) {
    // e.g. a path that is a file on one URL and a directory prefix on another
    state.seen.set(url, { url, localPath: null, status: "error", contentType, bytes: null, via, fromPage, note: (err as Error).message });
  }
}

// One clean, Range-free GET streamed to disk via an APIRequestContext (inherits
// the context's cookies/storageState). Used for media, 206 partials, anything
// whose live body couldn't be read, and CSS-referenced resources in the
// completeness pass. Returns the content-type so callers can chain (e.g. follow
// @import'd CSS).
export async function fetchAssetClean(
  rc: APIRequestContext,
  url: string,
  state: MirrorState,
  fromPage: string,
): Promise<string | null> {
  try {
    const resp = await rc.get(url, { timeout: 60000, maxRedirects: 5 });
    if (!resp.ok()) {
      recordSkipped(state, url, fromPage, "fetch", `HTTP ${resp.status()}`);
      return null;
    }
    const ct = resp.headers()["content-type"] ?? null;
    const buf = await resp.body();
    writeAsset(state, url, buf, ct, resp.status(), "fetch", fromPage);
    return ct;
  } catch (err) {
    state.seen.set(url, { url, localPath: null, status: "error", contentType: null, bytes: null, via: "fetch", fromPage, note: (err as Error).message });
    return null;
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Same-origin gate. `refOrigin` is the page's own origin, used as a fallback
// because subresource responses can arrive during the very first navigation —
// before the crawler has resolved (and stored) the base origin on the state.
function isSameOrigin(state: MirrorState, url: string, refOrigin: string | null): boolean {
  if (state.opts.mirrorCrossOrigin) return true;
  const base = state.origin ?? refOrigin;
  if (!base) return true; // origin genuinely unknown — don't drop
  return safeOrigin(url) === base;
}

async function handleResponse(resp: Response, ctx: BrowserContext, state: MirrorState, page: Page): Promise<void> {
  const req = resp.request();
  const url = req.url();
  if (!/^https?:/i.test(url)) return;

  const ct = resp.headers()["content-type"] ?? null;
  const pageUrl = page.url();
  const fromPage = toSlug(pageUrl);
  const refOrigin = safeOrigin(pageUrl);

  // HLS/DASH playlists are fetched by the JS player and never appear in the DOM;
  // the response observer is the only reliable source. Queue for post-crawl
  // reassembly via yt-dlp (only under --mirror-video).
  if (state.opts.mirrorVideo && (STREAM_MANIFEST.test(url) || (ct && STREAM_TYPE.test(ct)))) {
    const key = stripFrag(url);
    if (!state.streams.has(key) && isSameOrigin(state, key, refOrigin)) state.streams.set(key, fromPage);
    return;
  }

  const type = req.resourceType();
  const wantAsset = ASSET_RESOURCE_TYPES.has(type) || (!!ct && /image\/svg|text\/css|javascript/i.test(ct));
  const wantMedia = state.opts.mirrorVideo && (type === "media" || (!!ct && MEDIA_TYPE.test(ct)));
  if (!wantAsset && !wantMedia) return;

  const key = stripFrag(url);
  if (state.seen.has(key)) return; // already captured/reserved
  if (!isSameOrigin(state, key, refOrigin)) return;
  // Reserve synchronously before any await so concurrent workers can't double-fetch.
  state.seen.set(key, { url: key, localPath: null, status: "pending", contentType: ct, bytes: null, via: "fetch", fromPage });

  const status = resp.status();

  if (wantAsset && status === 200) {
    const len = Number(resp.headers()["content-length"] ?? "0");
    if (ct && INLINE_TYPE.test(ct) && len >= 0 && len <= INLINE_MAX_BYTES) {
      try {
        const buf = await resp.body();
        writeAsset(state, key, buf, ct, 200, "inline", fromPage);
        return;
      } catch {
        // body unavailable (e.g. read after navigation) — fall through to clean fetch
      }
    }
  }

  // Media, 206 partials, or anything whose live body we couldn't read.
  await fetchAssetClean(ctx.request, key, state, fromPage);
}

// Attach the response observer to a worker's page. Returns a detach fn.
export function attachMirrorListener(page: Page, ctx: BrowserContext, state: MirrorState): () => void {
  const onResponse = (resp: Response) => {
    handleResponse(resp, ctx, state, page).catch(() => {});
  };
  page.on("response", onResponse);
  return () => page.off("response", onResponse);
}

// Called from the crawler once a page has settled: save its rendered HTML and
// (under --mirror-video) scrape <video>/<source>/<audio> media URLs from the DOM.
export async function mirrorPage(page: Page, ctx: BrowserContext, slug: string, url: string, state: MirrorState): Promise<void> {
  try {
    const html = await page.content();
    const dest = path.join(state.pagesDir, `${slug}.html`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, html, "utf8");
    state.htmlPages.push({ slug, url, htmlPath: path.relative(state.root, dest) });
  } catch {
    // page closed / nav in flight — skip HTML for this page
  }

  if (!state.opts.mirrorVideo) return;

  let media: string[] = [];
  try {
    media = (await page.evaluate(`(() => {
      const urls = new Set();
      document.querySelectorAll('video[src],audio[src],source[src]').forEach((el) => { if (el.src) urls.add(el.src); });
      document.querySelectorAll('video[poster]').forEach((el) => { const p = el.getAttribute('poster'); if (p) urls.add(p); });
      return Array.from(urls);
    })()`)) as string[];
  } catch {
    return;
  }

  for (const raw of media) {
    let abs: string;
    try {
      abs = new URL(raw, url).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs)) continue;
    const key = stripFrag(abs);
    if (state.seen.has(key) || state.streams.has(key)) continue;
    const refOrigin = safeOrigin(url);
    if (STREAM_MANIFEST.test(key)) {
      if (isSameOrigin(state, key, refOrigin)) state.streams.set(key, slug);
      continue;
    }
    if (!isSameOrigin(state, key, refOrigin)) continue;
    state.seen.set(key, { url: key, localPath: null, status: "pending", contentType: null, bytes: null, via: "fetch", fromPage: slug });
    await fetchAssetClean(ctx.request, key, state, slug);
  }
}

// Memoized probe for the external binaries HLS/DASH reassembly needs.
export async function detectMediaTools(state: MirrorState): Promise<{ ytDlp: boolean; ffmpeg: boolean }> {
  if (state.toolAvail) return state.toolAvail;
  const probe = async (bin: string, arg: string): Promise<boolean> => {
    try {
      await execFileP(bin, [arg], { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  };
  state.toolAvail = { ytDlp: await probe("yt-dlp", "--version"), ffmpeg: await probe("ffmpeg", "-version") };
  return state.toolAvail;
}

// Post-crawl phase: reassemble each discovered HLS/DASH stream via yt-dlp
// (which orchestrates ffmpeg). Bounded sequential to avoid spawning N ffmpeg
// processes at once. Warns once and skips if the binaries aren't installed.
export async function reassembleStreams(state: MirrorState): Promise<void> {
  if (!state.opts.mirrorVideo || state.streams.size === 0) return;
  const tools = await detectMediaTools(state);
  if (!tools.ytDlp) {
    console.warn(`  ✗ mirror: ${state.streams.size} stream(s) found but yt-dlp is not installed — skipping (install yt-dlp + ffmpeg to enable)`);
    for (const [url, slug] of state.streams) recordSkipped(state, url, slug, "yt-dlp", "yt-dlp not installed");
    return;
  }
  for (const [url, slug] of state.streams) {
    const dir = path.join(state.mediaDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    const template = path.join(dir, "%(title).80s.%(ext)s");
    try {
      console.log(`  ↓ mirror: reassembling stream ${url}`);
      await execFileP("yt-dlp", ["--no-playlist", "--no-warnings", "-o", template, url], {
        timeout: 600000,
        maxBuffer: 64 * 1024 * 1024,
      });
      state.seen.set(url, { url, localPath: path.relative(state.root, dir), status: 200, contentType: "video/*", bytes: null, via: "yt-dlp", fromPage: slug });
    } catch (err) {
      const msg = (err as Error).message.split("\n")[0]!;
      console.warn(`  ✗ mirror: stream failed ${url} — ${msg}`);
      state.seen.set(url, { url, localPath: null, status: "error", contentType: null, bytes: null, via: "yt-dlp", fromPage: slug, note: msg });
    }
  }
}

// ---------------------------------------------------------------------------
// Offline URL rewriting (--mirror-rewrite)
//
// Post-pass over the saved files (run only once the full manifest is known):
// rewrite remote URLs in each saved HTML page and CSS file to relative local
// paths so the mirror browses offline. HTML attribute URLs are resolved against
// the page's own URL; CSS url()/@import are resolved against the *CSS file's*
// own URL (a common rewrite bug if you use the page URL instead). Rewrites in
// place. JS is intentionally not rewritten (bundler-generated dynamic URLs make
// it unreliable).
// ---------------------------------------------------------------------------

const HTML_ATTR_URL = /\b(src|href|poster)\s*=\s*(["'])([^"']*)\2/gi;
const HTML_SRCSET = /\bsrcset\s*=\s*(["'])([^"']*)\1/gi;
const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
const CSS_IMPORT = /@import\s+(["'])([^"']+)\1/gi;

function isCssAsset(a: AssetEntry): boolean {
  return !!a.localPath && (((a.contentType && /css/i.test(a.contentType)) || /\.css(\.|$)/i.test(a.localPath)) as boolean);
}

function extractCssRefs(css: string): string[] {
  const refs: string[] = [];
  let m: RegExpExecArray | null;
  CSS_URL.lastIndex = 0;
  while ((m = CSS_URL.exec(css))) refs.push(m[2]!);
  CSS_IMPORT.lastIndex = 0;
  while ((m = CSS_IMPORT.exec(css))) refs.push(m[2]!);
  return refs;
}

// Completeness pass: the response observer only captures what the page actually
// fetched, so a stylesheet's @font-face / background-image / @import targets that
// the page never triggered are missing — they'd 404 offline. This walks every
// saved CSS file, resolves its url()/@import refs against the CSS file's own URL,
// and fetches any not-yet-captured (origin-permitted) resources. Loops so that
// @import'd stylesheets are themselves parsed. Returns the count fetched.
export async function completeMirrorAssets(state: MirrorState, authStorage: string | null): Promise<number> {
  if (!state.opts.mirror) return 0;
  const rc = await request.newContext({ ignoreHTTPSErrors: true, storageState: authStorage ?? undefined });
  const processed = new Set<string>();
  let fetched = 0;
  try {
    for (let pass = 0; pass < 6; pass++) {
      const cssAssets = [...state.seen.values()].filter((a) => isCssAsset(a) && !processed.has(a.url));
      if (cssAssets.length === 0) break;
      let newThisPass = 0;
      for (const a of cssAssets) {
        processed.add(a.url);
        let css: string;
        try {
          css = fs.readFileSync(path.resolve(state.root, a.localPath!), "utf8");
        } catch {
          continue;
        }
        const refOrigin = safeOrigin(a.url);
        for (const ref of extractCssRefs(css)) {
          const trimmed = ref.trim();
          if (!trimmed || /^(data:|#)/i.test(trimmed)) continue;
          let abs: string;
          try {
            abs = new URL(trimmed, a.url).toString();
          } catch {
            continue;
          }
          if (!/^https?:/i.test(abs)) continue;
          const key = stripFrag(abs);
          if (state.seen.has(key) || !isSameOrigin(state, key, refOrigin)) continue;
          state.seen.set(key, { url: key, localPath: null, status: "pending", contentType: null, bytes: null, via: "fetch", fromPage: a.fromPage });
          await fetchAssetClean(rc, key, state, a.fromPage);
          fetched++;
          newThisPass++;
        }
      }
      if (newThisPass === 0) break;
    }
  } finally {
    await rc.dispose().catch(() => {});
  }
  return fetched;
}

// Build the lookup from original (fragment-stripped) URL -> absolute on-disk path.
// Includes both downloaded assets and the saved HTML pages, so page-to-page
// internal links also rewrite to local files.
function buildUrlIndex(state: MirrorState): Map<string, string> {
  const index = new Map<string, string>();
  for (const a of state.seen.values()) {
    if (a.localPath) index.set(stripFrag(a.url), path.resolve(state.root, a.localPath));
  }
  for (const p of state.htmlPages) {
    index.set(stripFrag(p.url), path.resolve(state.root, p.htmlPath));
  }
  return index;
}

// Resolve `ref` against `baseUrl`, look it up in the index, and return a POSIX
// relative path from `fromFile` to the target — or null if not captured.
function localRef(ref: string, baseUrl: string, fromFile: string, index: Map<string, string>): string | null {
  const trimmed = ref.trim();
  if (!trimmed || /^(data:|mailto:|tel:|javascript:|#)/i.test(trimmed)) return null;
  let abs: string;
  try {
    abs = new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
  const target = index.get(stripFrag(abs));
  if (!target) return null;
  const rel = path.relative(path.dirname(fromFile), target);
  const posix = rel.split(path.sep).join("/");
  // Preserve any #fragment from the original ref (e.g. internal anchors).
  const hash = trimmed.indexOf("#");
  return hash >= 0 ? posix + trimmed.slice(hash) : posix;
}

function rewriteHtml(html: string, baseUrl: string, fromFile: string, index: Map<string, string>): string {
  let out = html.replace(HTML_ATTR_URL, (m, attr, q, ref) => {
    const local = localRef(ref, baseUrl, fromFile, index);
    return local ? `${attr}=${q}${local}${q}` : m;
  });
  out = out.replace(HTML_SRCSET, (m, q, val) => {
    const rewritten = val
      .split(",")
      .map((part: string) => {
        const seg = part.trim();
        if (!seg) return seg;
        const sp = seg.search(/\s/);
        const url = sp === -1 ? seg : seg.slice(0, sp);
        const descriptor = sp === -1 ? "" : seg.slice(sp);
        const local = localRef(url, baseUrl, fromFile, index);
        return (local ?? url) + descriptor;
      })
      .join(", ");
    return `srcset=${q}${rewritten}${q}`;
  });
  return out;
}

function rewriteCss(css: string, baseUrl: string, fromFile: string, index: Map<string, string>): string {
  let out = css.replace(CSS_URL, (m, q, ref) => {
    const local = localRef(ref, baseUrl, fromFile, index);
    return local ? `url(${q}${local}${q})` : m;
  });
  out = out.replace(CSS_IMPORT, (m, q, ref) => {
    const local = localRef(ref, baseUrl, fromFile, index);
    return local ? `@import ${q}${local}${q}` : m;
  });
  return out;
}

// Rewrite every saved HTML page and CSS asset in place. Returns the count of
// files touched. Inverts state.seen to recover each CSS file's original URL.
export function rewriteForOffline(state: MirrorState): number {
  const index = buildUrlIndex(state);
  const localToUrl = new Map<string, string>();
  for (const a of state.seen.values()) {
    if (a.localPath) localToUrl.set(path.resolve(state.root, a.localPath), stripFrag(a.url));
  }

  let count = 0;

  for (const p of state.htmlPages) {
    const file = path.resolve(state.root, p.htmlPath);
    try {
      const html = fs.readFileSync(file, "utf8");
      const rewritten = rewriteHtml(html, p.url, file, index);
      if (rewritten !== html) {
        fs.writeFileSync(file, rewritten, "utf8");
        count++;
      }
    } catch {
      // unreadable/locked file — skip
    }
  }

  for (const a of state.seen.values()) {
    if (!a.localPath) continue;
    const isCss = (a.contentType && /css/i.test(a.contentType)) || /\.css(\.|$)/i.test(a.localPath);
    if (!isCss) continue;
    const file = path.resolve(state.root, a.localPath);
    const cssUrl = localToUrl.get(file) ?? a.url;
    try {
      const css = fs.readFileSync(file, "utf8");
      const rewritten = rewriteCss(css, cssUrl, file, index);
      if (rewritten !== css) {
        fs.writeFileSync(file, rewritten, "utf8");
        count++;
      }
    } catch {
      // skip
    }
  }

  return count;
}

export function writeMirrorManifest(state: MirrorState, site: string): MirrorManifest {
  const manifest: MirrorManifest = {
    site,
    pages: state.htmlPages,
    assets: [...state.seen.values()],
  };
  fs.writeFileSync(path.join(state.root, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

// Convenience for the caller's end-of-run summary.
export function mirrorSummary(state: MirrorState): { pages: number; saved: number; skipped: number } {
  let saved = 0;
  let skipped = 0;
  for (const a of state.seen.values()) {
    if (a.localPath) saved++;
    else skipped++;
  }
  return { pages: state.htmlPages.length, saved, skipped };
}

export type { PageRecord };
