import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
// @ts-expect-error @types/archiver is stale and doesn't export ZipArchive; v8 exports it at runtime.
import { ZipArchive } from "archiver";
import path from "path";
import fs from "fs";
import os from "os";
import net from "net";
import { parseArgs } from "node:util";
import { runLighthouse, type LighthouseDetail } from "./lighthouse";
import { writeIndexReport } from "./report";
import {
  VIEWPORTS,
  COLOR_SCHEMES,
  toSlug,
  DEFAULT_CONCURRENCY,
  type PageRecord,
  type ConsoleEvent,
  type SeoMeta,
  type SecurityHeaders,
  type AxeSummary,
  type LinkCheck,
  type RunOptions,
  type TechResult,
  type SiteIntel,
} from "./util";
import { dismissCookieBanner, hideCookieBanners } from "./cookies";
import { extractSeo } from "./seo";
import { scoreHeaders } from "./security";
import { runAxe } from "./axe";
import { checkLinks } from "./links";
import { buildResults, writeResults, type Results } from "./results";
import { writeCompareReport } from "./compare";
import { recordVideos } from "./video";
import {
  createMirrorState,
  attachMirrorListener,
  mirrorPage,
  reassembleStreams,
  completeMirrorAssets,
  rewriteForOffline,
  writeMirrorManifest,
  mirrorSummary,
  type MirrorState,
} from "./mirror";
import { detectTech, rollupTech, JS_GLOBAL_PATHS, type TechInput } from "./tech";
import { correlateVulnerabilities } from "./cve";
import { lookupDomain, lookupDns, lookupGeo, lookupExitIp, checkEmailSecurity } from "./domain";
import { inspectTls } from "./tls";
import { gatherOffpageIntel } from "./offpage";

const STILL_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}
`;

const HIDE_BANNERS_CSS = `
#onetrust-consent-sdk,
#onetrust-banner-sdk,
#onetrust-pc-sdk,
#CybotCookiebotDialog,
#CybotCookiebotDialogBodyUnderlay,
.osano-cm-window,
.osano-cm-dialog,
.qc-cmp2-container,
#qc-cmp2-ui,
#iubenda-cs-banner,
.iubenda-cs-container,
#didomi-host,
#didomi-notice,
#cky-consent,
.cky-consent-container,
#truste-consent-track,
.truste_box_overlay,
.evidon-banner,
#hs-eu-cookie-confirmation,
[class*="cookie-banner" i],
[id*="cookie-banner" i],
[class*="consent-banner" i],
[id*="consent-banner" i],
[class*="CookieConsent" i],
[id*="CookieConsent" i] {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
html { overflow: auto !important; }
body { overflow: auto !important; }
`;

// Force scroll-reveal libraries into their "shown" state. Many themes start
// content at opacity:0 / translated and reveal it via IntersectionObserver on
// scroll. The scroll pass below triggers most of them, but with animations
// frozen (STILL_CSS) a few can get stuck mid-reveal — this is the safety net so
// below-the-fold sections never render as blank space in a full-page shot.
const REVEAL_CSS = `
[data-aos], .aos-init, .aos-animate,
.wow, .animated, .reveal, .revealed, .is-visible, .in-view, .inview,
[class*="fade" i], [class*="reveal" i], [class*="appear" i],
[class*="animate" i], [class*="slide-in" i], [class*="scroll-in" i] {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
  filter: none !important;
  clip-path: none !important;
}
`;

// Walk the full page top-to-bottom to trigger IntersectionObserver reveals and
// lazy-loaded images, wait for those images to settle, then return to the top.
// Bounded so a never-idle / infinite-scroll page can't hang the shoot.
async function autoScrollAndSettle(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      await new Promise<void>((resolve) => {
        const step = Math.max(200, Math.floor(window.innerHeight * 0.85));
        const startedAt = Date.now();
        let y = 0;
        const tick = () => {
          window.scrollTo(0, y);
          y += step;
          const atBottom =
            y >= document.documentElement.scrollHeight - window.innerHeight;
          if (atBottom || Date.now() - startedAt > 8000) {
            window.scrollTo(0, document.documentElement.scrollHeight);
            setTimeout(resolve, 200);
          } else {
            setTimeout(tick, 90);
          }
        };
        tick();
      });
    })
    .catch(() => {});

  // Let lazy <img> fetches (kicked off by the scroll) finish — capped at 3s.
  await page
    .evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.race([
        Promise.all(
          imgs.map((img) =>
            img.complete && img.naturalWidth > 0
              ? null
              : new Promise<void>((res) => {
                  img.addEventListener("load", () => res(), { once: true });
                  img.addEventListener("error", () => res(), { once: true });
                }),
          ),
        ),
        new Promise<void>((res) => setTimeout(res, 3000)),
      ]);
    })
    .catch(() => {});

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

const HELP = `
Trawl — crawl a site and audit every internal page

Usage:
  trawl <url> [flags]
  trawl <url> <url> <url> [flags]       multi-site compare mode
  trawl <urls.txt> [flags]              read URLs from a file (one per line, # for comments)

Examples:
  trawl http://localhost:3000
  trawl https://example.com --max-pages 50 --concurrency 6
  trawl https://example.com --exclude '/blog/'
  trawl https://stripe.com https://plaid.com https://truelayer.com
  trawl ./prospects.txt --max-pages 30

Audit flags:
  --no-lighthouse        skip the Lighthouse audit phase
  --no-axe               skip the axe-core a11y scan
  --no-links             skip outbound-link HEAD checks
  --no-recon             skip passive recon (WHOIS/DNS/geo, tech, TLS, email)
  --no-cve               skip known-vulnerability correlation (keeps other recon)

Capture:
  --shot <mode>          screenshot mode: fullpage (default, tall scroll capture),
                         viewport (above-the-fold crop only), or both (full-page
                         plus an above-the-fold <slug>@fold.png)
  --no-dark              skip the dark-colour-scheme screenshot pass (light only)
  --screens              also slice full-page shots into sequential viewport-height
                         images (<slug>@screen-N.png) and mark the boundaries on the
                         full-page shot; implies full-page capture even with --shot viewport
  --max-screens <N>      cap on slices per page/viewport with --screens (default 20)

SEO / ranking flags (free external APIs — see README for the env keys):
  --rank "kw1, kw2"      check this domain's SERP position for each keyword
                         (Brave Search; needs CRAWLSHOT_BRAVE_KEY)
  --gsc-credentials <p>  pull owner Search Console stats from a credentials JSON
                         (access_token or a service-account key)
  --no-pagerank          skip the OpenPageRank domain-authority lookup
  --no-crux              skip the Google CrUX field Core Web Vitals lookup

Scope flags:
  --max-pages <N>        stop after N pages have been crawled
  --max-depth <N>        only follow links up to depth N from the start URL
  --include <regex>      only crawl URLs whose full URL matches this regex
  --exclude <regex>      skip URLs whose full URL matches this regex

Auth:
  --auth-storage <path>  Playwright storageState JSON to use for authenticated crawls

Privacy:
  --verify-ip            abort before crawling unless the public exit IP looks like a VPN/proxy
  --home-ip <ip>         your real (VPN-off) IP; aborts if the exit IP matches it (implies --verify-ip)

Mirror (asset extraction — for authorized sites / design reference):
  --mirror               download the site's HTML + same-origin assets (CSS/JS/
                         images/fonts/SVG) into a mirror/ folder + manifest.json.
                         Turns off Lighthouse/axe/links and the screenshot grid.
  --mirror-media         media-only: download just images + video/audio (skips
                         HTML/CSS/JS/fonts). Implies --mirror and media capture.
  --mirror-video         also download self-hosted media (MP4/WebM) and reassemble
                         HLS/DASH streams via yt-dlp/ffmpeg (skipped if not on PATH);
                         implies --mirror. No DRM bypass.
  --mirror-cross-origin  also download assets served from other origins (CDNs)
  --mirror-rewrite       rewrite saved HTML/CSS URLs to local paths so the mirror
                         browses offline (modifies the saved files in place)

Performance:
  --concurrency <N>      parallel pages in flight (default ${DEFAULT_CONCURRENCY})

Video:
  --video                record a scrolling video of each crawled page
  --video-pages <regex>  only record pages whose URL matches this regex
  --video-viewport <vp>  viewport to record: phone, tablet, desktop (repeatable, default desktop)
  --video-scheme <s>     color scheme to record: light, dark (repeatable, default light)

  -h, --help             show this help
`;

type ParsedCli = {
  urls: string[];
  options: RunOptions;
};

function parseCli(): ParsedCli {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        "no-lighthouse":  { type: "boolean" },
        "no-axe":         { type: "boolean" },
        "no-links":       { type: "boolean" },
        "no-recon":       { type: "boolean" },
        "no-cve":         { type: "boolean" },
        "no-pagerank":    { type: "boolean" },
        "no-crux":        { type: "boolean" },
        "rank":           { type: "string" },
        "gsc-credentials":{ type: "string" },
        "max-pages":      { type: "string" },
        "max-depth":      { type: "string" },
        "include":        { type: "string" },
        "exclude":        { type: "string" },
        "auth-storage":   { type: "string" },
        "concurrency":    { type: "string" },
        "shot":           { type: "string" },
        "no-dark":        { type: "boolean" },
        "screens":        { type: "boolean" },
        "max-screens":    { type: "string" },
        "video":          { type: "boolean" },
        "video-pages":    { type: "string" },
        "video-viewport": { type: "string", multiple: true },
        "video-scheme":   { type: "string", multiple: true },
        "verify-ip":      { type: "boolean" },
        "home-ip":        { type: "string" },
        "mirror":              { type: "boolean" },
        "mirror-video":        { type: "boolean" },
        "mirror-cross-origin": { type: "boolean" },
        "mirror-rewrite":      { type: "boolean" },
        "mirror-media":        { type: "boolean" },
        "help":           { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`trawl: ${(err as Error).message}`);
    console.error(HELP);
    process.exit(1);
  }

  const { values, positionals } = parsed;

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const num = (raw: string | undefined, name: string): number | null => {
    if (raw === undefined) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`trawl: --${name} must be a positive number, got ${raw}`);
      process.exit(1);
    }
    return n;
  };

  const re = (raw: string | undefined, name: string): RegExp | null => {
    if (raw === undefined) return null;
    try {
      return new RegExp(raw);
    } catch (err) {
      console.error(`trawl: --${name} is not a valid regex: ${(err as Error).message}`);
      process.exit(1);
    }
  };

  const authStorage = (raw: string | undefined): string | null => {
    if (raw === undefined) return null;
    const resolved = path.resolve(raw);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        console.error(`trawl: --auth-storage must point to a file, got ${raw}`);
        process.exit(1);
      }
      JSON.parse(fs.readFileSync(resolved, "utf8"));
    } catch (err) {
      console.error(`trawl: --auth-storage is not a readable JSON file: ${(err as Error).message}`);
      process.exit(1);
    }
    return resolved;
  };

  const homeIp = (raw: string | undefined): string | null => {
    if (raw === undefined) return null;
    if (net.isIP(raw) === 0) {
      console.error(`trawl: --home-ip must be a valid IP address, got ${raw}`);
      process.exit(1);
    }
    return raw;
  };

  const rankKeywords = (raw: string | undefined): string[] | null => {
    if (raw === undefined) return null;
    const list = raw.split(",").map((k) => k.trim()).filter(Boolean);
    if (list.length === 0) {
      console.error(`trawl: --rank needs at least one keyword, e.g. --rank "luxury car hire london, chauffeur london"`);
      process.exit(1);
    }
    return list;
  };

  const credsFile = (raw: string | undefined): string | null => {
    if (raw === undefined) return null;
    const resolved = path.resolve(raw);
    try {
      if (!fs.statSync(resolved).isFile()) {
        console.error(`trawl: --gsc-credentials must point to a file, got ${raw}`);
        process.exit(1);
      }
      JSON.parse(fs.readFileSync(resolved, "utf8"));
    } catch (err) {
      console.error(`trawl: --gsc-credentials is not a readable JSON file: ${(err as Error).message}`);
      process.exit(1);
    }
    return resolved;
  };

  const videoEnabled = Boolean(values["video"]);

  const rawViewports = (values["video-viewport"] as string[] | undefined) ?? [];
  const validViewportNames = VIEWPORTS.map((v) => v.name);
  for (const vp of rawViewports) {
    if (!validViewportNames.includes(vp as typeof VIEWPORTS[number]["name"])) {
      console.error(`trawl: --video-viewport must be one of: ${validViewportNames.join(", ")}, got "${vp}"`);
      process.exit(1);
    }
  }
  const videoViewports = rawViewports.length > 0 ? rawViewports : ["desktop"];

  const rawSchemes = (values["video-scheme"] as string[] | undefined) ?? [];
  const validSchemes = [...COLOR_SCHEMES];
  for (const s of rawSchemes) {
    if (!validSchemes.includes(s as typeof COLOR_SCHEMES[number])) {
      console.error(`trawl: --video-scheme must be one of: ${validSchemes.join(", ")}, got "${s}"`);
      process.exit(1);
    }
  }
  const videoSchemes = rawSchemes.length > 0 ? rawSchemes : ["light"];

  // Mirror mode is asset-focused: --mirror-video implies --mirror, and either one
  // turns off the audit grid (Lighthouse/axe/links + the screenshot phase) so the
  // run downloads assets instead of auditing. Recon stays on (it's cheap and the
  // tech fingerprint is useful context); pass --no-recon to skip it too.
  const mirrorMedia = Boolean(values["mirror-media"]);
  const mirror =
    Boolean(values["mirror"]) ||
    Boolean(values["mirror-video"]) ||
    Boolean(values["mirror-cross-origin"]) ||
    Boolean(values["mirror-rewrite"]) ||
    mirrorMedia;
  // Media-only implies media capture (images + video/audio + HLS/DASH).
  const mirrorVideo = Boolean(values["mirror-video"]) || mirrorMedia;

  const SHOT_MODES = ["fullpage", "viewport", "both"] as const;
  const rawShot = values["shot"] as string | undefined;
  if (rawShot !== undefined && !SHOT_MODES.includes(rawShot as typeof SHOT_MODES[number])) {
    console.error(`trawl: --shot must be one of: ${SHOT_MODES.join(", ")}, got "${rawShot}"`);
    process.exit(1);
  }
  const shotMode = (rawShot ?? "fullpage") as RunOptions["shotMode"];

  const options: RunOptions = {
    noLighthouse: Boolean(values["no-lighthouse"]) || mirror,
    noAxe:        Boolean(values["no-axe"]) || mirror,
    noLinks:      Boolean(values["no-links"]) || mirror,
    noRecon:      Boolean(values["no-recon"]),
    noCve:        Boolean(values["no-cve"]),
    noPagerank:   Boolean(values["no-pagerank"]),
    noCrux:       Boolean(values["no-crux"]),
    rankKeywords: rankKeywords(values["rank"]),
    gscCredentials: credsFile(values["gsc-credentials"]),
    maxPages:     num(values["max-pages"], "max-pages"),
    maxDepth:     num(values["max-depth"], "max-depth"),
    include:      re(values["include"], "include"),
    exclude:      re(values["exclude"], "exclude"),
    concurrency:  num(values["concurrency"], "concurrency") ?? DEFAULT_CONCURRENCY,
    shotMode,
    noDark:       Boolean(values["no-dark"]),
    screens:      Boolean(values["screens"]),
    maxScreens:   num(values["max-screens"], "max-screens") ?? 20,
    authStorage:  authStorage(values["auth-storage"]),
    video:        videoEnabled,
    videoPages:   re(values["video-pages"], "video-pages"),
    videoViewports,
    videoSchemes,
    homeIp:       homeIp(values["home-ip"]),
    // --home-ip implies the check; supplying a baseline is itself opting in.
    verifyIp:     Boolean(values["verify-ip"]) || values["home-ip"] !== undefined,
    mirror,
    mirrorVideo,
    mirrorCrossOrigin: Boolean(values["mirror-cross-origin"]),
    mirrorRewrite:     Boolean(values["mirror-rewrite"]),
    mirrorMedia,
  };

  const urls = expandUrlSources(positionals);
  return { urls, options };
}

// If a single positional points at an existing file, read URLs from it (one per line, # comments).
// Otherwise treat all positionals as URLs.
function expandUrlSources(positionals: string[]): string[] {
  if (positionals.length === 1) {
    const candidate = positionals[0]!;
    if (!/^https?:\/\//i.test(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const contents = fs.readFileSync(candidate, "utf8");
      const urls = contents
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      if (urls.length === 0) {
        console.error(`trawl: ${candidate} contains no URLs`);
        process.exit(1);
      }
      return urls;
    }
  }
  for (const p of positionals) {
    if (!/^https?:\/\//i.test(p)) {
      console.error(`trawl: not a URL or file: ${p}`);
      process.exit(1);
    }
  }
  return positionals;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not allocate port"));
      }
    });
  });
}

type CrawlOutput = {
  pages: PageRecord[];
  pageStatus: Map<string, number | null>;
  seo: Map<string, SeoMeta>;
  security: Map<string, SecurityHeaders>;
  tech: Map<string, TechResult>;
  consoleEvents: Map<string, ConsoleEvent[]>;
  outboundLinks: { fromSlug: string; url: string; text?: string }[];
  baseOrigin: string;
  mirror: MirrorState | null;
};

// Gather the passive fingerprint inputs the page exposes (script URLs, <meta>
// tags, and the JS globals the dataset references), then run the matcher.
// Skipped entirely when --no-recon is set.
async function collectTech(page: Page, url: string, headers: Record<string, string>): Promise<TechResult | null> {
  try {
    const cookies = await page.context().cookies().catch(() => []);
    const html = await page.content().catch(() => "");
    const probe = (await page.evaluate((paths: string[]) => {
      const scriptSrc = Array.from(document.querySelectorAll("script[src]")).map((s) => (s as HTMLScriptElement).src);
      const metas: Record<string, string> = {};
      document.querySelectorAll("meta[name], meta[property]").forEach((m) => {
        const n = (m.getAttribute("name") || m.getAttribute("property") || "").toLowerCase();
        const c = m.getAttribute("content");
        if (n && c != null) metas[n] = c;
      });
      const jsGlobals: Record<string, string> = {};
      for (const path of paths) {
        try {
          let cur: any = window;
          for (const part of path.split(".")) {
            if (cur == null) { cur = undefined; break; }
            cur = cur[part];
          }
          if (cur !== undefined) jsGlobals[path] = typeof cur === "string" || typeof cur === "number" ? String(cur) : "";
        } catch {
          // inaccessible global (e.g. cross-origin getter) — skip
        }
      }
      return { scriptSrc, metas, jsGlobals };
    }, JS_GLOBAL_PATHS)) as { scriptSrc: string[]; metas: Record<string, string>; jsGlobals: Record<string, string> };

    const normHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) normHeaders[k.toLowerCase()] = v;

    const input: TechInput = {
      url,
      headers: normHeaders,
      cookies: cookies.map((c) => ({ name: c.name, value: c.value })),
      html,
      scriptSrc: probe.scriptSrc,
      metas: probe.metas,
      jsGlobals: probe.jsGlobals,
    };
    return detectTech(input);
  } catch {
    return null;
  }
}

function attachConsoleListeners(page: Page, sink: ConsoleEvent[]): () => void {
  const onConsole = (msg: import("playwright").ConsoleMessage) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning") return;
    const loc = msg.location();
    sink.push({
      type: type === "error" ? "error" : "warning",
      text: msg.text(),
      location: loc.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : undefined,
    });
  };
  const onPageError = (err: Error) => {
    sink.push({ type: "pageerror", text: err.message, stack: err.stack });
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  return () => {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  };
}

function passesScope(url: string, opts: RunOptions): boolean {
  if (opts.include && !opts.include.test(url)) return false;
  if (opts.exclude && opts.exclude.test(url)) return false;
  return true;
}

type CrawlQueueItem = { url: string; depth: number };

async function crawl(baseUrl: string, opts: RunOptions, outDir: string): Promise<CrawlOutput> {
  const visited = new Set<string>();
  const queued = new Set<string>();
  const queue: CrawlQueueItem[] = [];
  const mirror = opts.mirror ? createMirrorState(outDir, opts) : null;

  const enqueue = (url: string, depth: number) => {
    const key = new URL(url).pathname.replace(/\/$/, "") || "/";
    if (queued.has(key) || visited.has(key)) return;
    queued.add(key);
    queue.push({ url, depth });
  };

  enqueue(baseUrl, 0);

  const pages: PageRecord[] = [];
  const pageStatus = new Map<string, number | null>();
  const seo = new Map<string, SeoMeta>();
  const security = new Map<string, SecurityHeaders>();
  const tech = new Map<string, TechResult>();
  const consoleEvents = new Map<string, ConsoleEvent[]>();
  const outboundLinks: { fromSlug: string; url: string; text?: string }[] = [];

  const browser = await chromium.launch({
    args: ["--ignore-certificate-errors"],
  });
  let resolvedOrigin: string | null = null;
  const crawledResolvedKeys = new Set<string>();
  let active = 0;
  let stopped = false;

  async function processOne(item: CrawlQueueItem, page: Page): Promise<void> {
    const key = new URL(item.url).pathname.replace(/\/$/, "") || "/";
    if (visited.has(key)) return;
    visited.add(key);

    const sink: ConsoleEvent[] = [];
    const detach = attachConsoleListeners(page, sink);

    try {
      const response = await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await dismissCookieBanner(page);
      await hideCookieBanners(page);

      if (!resolvedOrigin) {
        resolvedOrigin = new URL(page.url()).origin;
        if (mirror) mirror.origin = resolvedOrigin;
      }

      const resolvedUrl = page.url();
      const resolvedKey = new URL(resolvedUrl).pathname.replace(/\/$/, "") || "/";
      if (crawledResolvedKeys.has(resolvedKey)) {
        console.log(`  skipped  → ${key}  (resolved duplicate ${resolvedKey})`);
        return;
      }
      crawledResolvedKeys.add(resolvedKey);

      const slug = toSlug(resolvedUrl);
      const title = (await page.title().catch(() => "")) || "";
      pages.push({ url: resolvedUrl, slug, title });

      const status = response?.status() ?? null;
      pageStatus.set(slug, status);

      const headers = response?.headers() ?? {};
      security.set(slug, scoreHeaders(status, headers));

      try {
        seo.set(slug, await extractSeo(page));
      } catch (err) {
        console.warn(`    seo extract failed for ${slug}: ${(err as Error).message}`);
      }

      if (!opts.noRecon) {
        const techResult = await collectTech(page, resolvedUrl, headers);
        if (techResult) tech.set(slug, techResult);
      }

      const linkData = await page.evaluate(`(() => {
        const origin = ${JSON.stringify(resolvedOrigin)};
        const anchors = Array.from(document.querySelectorAll("a[href]"))
          .map((el) => ({ href: el.href, text: (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120) }))
          .filter((a) => Boolean(a.href));

        const norm = (href) => {
          try {
            const u = new URL(href);
            return { url: u.toString(), pathOnly: u.origin + u.pathname };
          } catch {
            return null;
          }
        };

        const internalForQueue = [];
        const outboundMap = {};
        for (const a of anchors) {
          const n = norm(a.href);
          if (!n) continue;
          let parsed;
          try { parsed = new URL(n.url); } catch { continue; }
          const isAsset = /\\.(pdf|jpg|jpeg|png|gif|svg|webp|zip|xml|json|ico|txt|css|js|mjs|map)$/i.test(parsed.pathname);
          const isMail = /^(mailto|tel|javascript):/i.test(a.href);
          if (isMail) continue;
          if (origin && parsed.origin === origin && !isAsset) {
            internalForQueue.push(n.pathOnly);
          }
          if (/^https?:$/i.test(parsed.protocol) && !isAsset) {
            if (!(n.url in outboundMap)) outboundMap[n.url] = a.text;
          }
        }
        return {
          internalForQueue: Array.from(new Set(internalForQueue)),
          outbound: Object.keys(outboundMap).map((url) => ({ url, text: outboundMap[url] })),
        };
      })()`) as { internalForQueue: string[]; outbound: { url: string; text: string }[] };

      let newCount = 0;
      const atDepthLimit = opts.maxDepth !== null && item.depth >= opts.maxDepth;
      for (const link of linkData.internalForQueue) {
        if (atDepthLimit) break;
        if (!passesScope(link, opts)) continue;
        const linkKey = new URL(link).pathname.replace(/\/$/, "") || "/";
        if (visited.has(linkKey) || queued.has(linkKey)) continue;
        if (opts.maxPages !== null && visited.size + queue.length >= opts.maxPages) {
          stopped = true;
          break;
        }
        enqueue(link, item.depth + 1);
        newCount++;
      }
      for (const out of linkData.outbound) {
        outboundLinks.push({ fromSlug: slug, url: out.url, text: out.text || undefined });
      }

      if (mirror) {
        await mirrorPage(page, page.context(), slug, resolvedUrl, mirror).catch((e) =>
          console.warn(`    mirror failed for ${slug}: ${(e as Error).message}`),
        );
      }

      console.log(
        `  crawled → ${resolvedKey}  (d=${item.depth}, ${linkData.internalForQueue.length} internal, ${newCount} new, ${linkData.outbound.length} outbound, status ${status})`,
      );
    } catch (err) {
      console.warn(`  skipped  → ${key}  (${(err as Error).message})`);
    } finally {
      detach();
      if (sink.length > 0) {
        const slug = toSlug(page.url());
        const existing = consoleEvents.get(slug) ?? [];
        consoleEvents.set(slug, existing.concat(sink));
      }
    }
  }

  async function worker(): Promise<void> {
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      storageState: opts.authStorage ?? undefined,
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    const detachMirror = mirror ? attachMirrorListener(page, ctx, mirror) : null;
    try {
      while (true) {
        if (stopped && queue.length === 0) return;
        if (opts.maxPages !== null && visited.size >= opts.maxPages) {
          stopped = true;
          return;
        }
        const item = queue.shift();
        if (!item) {
          if (active === 0) return;
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        active++;
        try {
          await processOne(item, page);
        } finally {
          active--;
        }
      }
    } finally {
      detachMirror?.();
      await page.close().catch(() => {});
      await ctx.close().catch(() => {});
    }
  }

  const workers = Array.from({ length: opts.concurrency }, () => worker());
  await Promise.all(workers);
  await browser.close();

  return {
    pages,
    pageStatus,
    seo,
    security,
    tech,
    consoleEvents,
    outboundLinks,
    baseOrigin: resolvedOrigin ?? new URL(baseUrl).origin,
    mirror,
  };
}

// Site-level passive recon: domain registration (RDAP), DNS, IP geo/ASN, TLS,
// and email-spoofing posture. Runs once per site against the resolved origin.
// `technologies` and `vulnerabilities` are filled in by the caller after the
// per-page tech results have been rolled up. Returns null on hard failure.
async function gatherSiteIntel(origin: string, options: RunOptions): Promise<SiteIntel | null> {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return null;
  }
  const [domain, dns, tls, offpage] = await Promise.all([
    lookupDomain(hostname),
    lookupDns(hostname),
    inspectTls(hostname),
    gatherOffpageIntel(origin, {
      noPagerank: options.noPagerank,
      noCrux: options.noCrux,
      rankKeywords: options.rankKeywords,
      gscCredentials: options.gscCredentials,
    }),
  ]);
  const [geo, email] = await Promise.all([
    lookupGeo(dns.a[0]),
    checkEmailSecurity(hostname, dns.txt),
  ]);
  return {
    domain,
    dns,
    geo,
    email,
    tls,
    technologies: [],
    vulnerabilities: [],
    authority: offpage.authority,
    fieldCwv: offpage.fieldCwv,
    rankings: offpage.rankings,
    searchConsole: offpage.searchConsole,
  };
}

type ShootJob = { rec: PageRecord; scheme: typeof COLOR_SCHEMES[number]; vp: typeof VIEWPORTS[number] };

async function shoot(
  pages: PageRecord[],
  outDir: string,
  runAxeScan: boolean,
  options: Pick<RunOptions, "authStorage" | "concurrency" | "shotMode" | "noDark" | "screens" | "maxScreens">,
): Promise<{ axeResults: Map<string, AxeSummary>; screenCounts: Map<string, Record<string, number>> }> {
  const browser: Browser = await chromium.launch({
    args: ["--ignore-certificate-errors"],
  });
  const axeResults = new Map<string, AxeSummary>();
  const screenCounts = new Map<string, Record<string, number>>();
  const axeLock = new Set<string>(); // prevents concurrent axe runs on the same slug

  const schemes = options.noDark
    ? COLOR_SCHEMES.filter((s) => s !== "dark")
    : COLOR_SCHEMES;

  for (const scheme of schemes) {
    for (const vp of VIEWPORTS) {
      fs.mkdirSync(path.join(outDir, scheme, vp.name), { recursive: true });
    }
  }

  // Pre-flatten the full job grid so workers can pull independently.
  const jobs: ShootJob[] = [];
  for (const rec of pages) {
    for (const scheme of schemes) {
      for (const vp of VIEWPORTS) {
        jobs.push({ rec, scheme, vp });
      }
    }
  }

  let nextJob = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextJob++;
      if (i >= jobs.length) return;
      const { rec, scheme, vp } = jobs[i]!;

      let ctx: BrowserContext | null = null;
      try {
        ctx = await browser.newContext({
          ignoreHTTPSErrors: true,
          storageState: options.authStorage ?? undefined,
          viewport: { width: vp.width, height: vp.height },
          deviceScaleFactor: vp.deviceScaleFactor,
          isMobile: vp.isMobile,
          hasTouch: vp.hasTouch,
          colorScheme: scheme,
          reducedMotion: "reduce",
        });
        const page = await ctx.newPage();

        await page.goto(rec.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        await page.evaluate("(() => document.fonts?.ready)()").catch(() => {});
        await dismissCookieBanner(page);

        // Run axe BEFORE injecting our still/hide CSS so the DOM matches the real page.
        // Only on the desktop+light pass — one a11y run per page is sufficient.
        if (runAxeScan && scheme === "light" && vp.name === "desktop" && !axeLock.has(rec.slug)) {
          axeLock.add(rec.slug);
          try {
            const summary = await runAxe(page, outDir, rec.slug);
            axeResults.set(rec.slug, summary);
            console.log(`  ⚖ ${rec.slug} — axe: ${summary.violationCount} violations (${summary.nodeCount} nodes)`);
          } catch (err) {
            console.warn(`  ✗ ${rec.slug} — axe failed: ${(err as Error).message}`);
          }
        }

        // Freeze motion, force reveal-on-scroll content visible, hide banners.
        await page.addStyleTag({ content: STILL_CSS }).catch(() => {});
        await page.addStyleTag({ content: REVEAL_CSS }).catch(() => {});
        await page.addStyleTag({ content: HIDE_BANNERS_CSS }).catch(() => {});

        // Scroll the whole page so IntersectionObserver reveals fire and lazy
        // images load, then settle back at the top before the full-page shot.
        await autoScrollAndSettle(page);

        // Banners often render late or re-appear after interaction — clear them
        // again now that the page is fully hydrated.
        await dismissCookieBanner(page);
        await hideCookieBanners(page);

        await page.waitForTimeout(400);

        // shotMode: "fullpage" (default) → tall scroll capture as <slug>.png;
        // "viewport" → above-the-fold crop, also as <slug>.png (keeps report.ts
        // happy); "both" → full-page <slug>.png + an above-the-fold <slug>@fold.png.
        // --screens always forces the full-page capture too, since the per-screen
        // slices and boundary markers below are cut from it.
        const wantFold = options.shotMode !== "fullpage";
        const wantFull = options.shotMode !== "viewport" || options.screens;

        // When --screens is set, bake dashed boundary markers into the full-page
        // shot (so the scroll "rhythm" is visible on the long image too), then
        // strip them back out before cutting the clean per-screen slices.
        let screenCount = 0;
        let totalHeight = 0;
        if (options.screens) {
          totalHeight = await page.evaluate(() => document.documentElement.scrollHeight);
          screenCount = Math.max(1, Math.min(Math.ceil(totalHeight / vp.height), options.maxScreens));
          if (screenCount > 1) {
            await page
              .evaluate(
                ({ stepHeight, count }: { stepHeight: number; count: number }) => {
                  for (let n = 1; n < count; n++) {
                    const line = document.createElement("div");
                    line.className = "__trawl_fold_marker";
                    line.style.cssText =
                      `position:absolute;left:0;top:${n * stepHeight}px;width:100%;` +
                      `border-top:3px dashed #ff2d78;z-index:2147483647;pointer-events:none;`;
                    const label = document.createElement("span");
                    label.className = "__trawl_fold_marker";
                    label.textContent = `screen ${n} / ${n + 1}`;
                    label.style.cssText =
                      `position:absolute;left:8px;top:${n * stepHeight + 4}px;background:#ff2d78;` +
                      `color:#fff;font:11px/1.4 monospace;padding:2px 6px;border-radius:3px;` +
                      `z-index:2147483647;pointer-events:none;`;
                    document.body.appendChild(line);
                    document.body.appendChild(label);
                  }
                },
                { stepHeight: vp.height, count: screenCount },
              )
              .catch(() => {});
          }
        }

        if (wantFull) {
          await page.screenshot({
            path: path.join(outDir, scheme, vp.name, `${rec.slug}.png`),
            fullPage: true,
          });
        }
        if (wantFold) {
          const foldName = options.shotMode === "viewport" ? `${rec.slug}.png` : `${rec.slug}@fold.png`;
          await page.screenshot({
            path: path.join(outDir, scheme, vp.name, foldName),
            fullPage: false,
          });
        }

        if (options.screens) {
          if (screenCount > 1) {
            await page
              .evaluate(() => document.querySelectorAll(".__trawl_fold_marker").forEach((el) => el.remove()))
              .catch(() => {});
          }
          for (let n = 0; n < screenCount; n++) {
            const y = n * vp.height;
            const sliceHeight = Math.min(vp.height, totalHeight - y);
            if (sliceHeight <= 0) break;
            // clip on a non-fullPage screenshot is relative to the current viewport,
            // not the whole document — scroll to this slice's offset first.
            await page.evaluate((scrollY: number) => window.scrollTo(0, scrollY), y);
            await page.waitForTimeout(50);
            await page.screenshot({
              path: path.join(outDir, scheme, vp.name, `${rec.slug}@screen-${n + 1}.png`),
              clip: { x: 0, y: 0, width: vp.width, height: sliceHeight },
            });
          }
          const perPage = screenCounts.get(rec.slug) ?? {};
          perPage[`${scheme}/${vp.name}`] = screenCount;
          screenCounts.set(rec.slug, perPage);
        }

        console.log(`  ✓ ${rec.slug} @ ${scheme}/${vp.name} (${vp.width}px, ${options.shotMode}${options.screens ? `, ${screenCount} screens` : ""})`);
      } catch {
        console.warn(`  ✗ ${rec.slug} @ ${scheme}/${vp.name} — failed`);
      } finally {
        await ctx?.close().catch(() => {});
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency, jobs.length)) }, () => worker());
  await Promise.all(workers);
  await browser.close();
  return { axeResults, screenCounts };
}

function zipDir(srcDir: string, zipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}

type SiteRunResult = { results: Results; outDir: string; zipPath: string | null };

async function runSite(
  url: string,
  options: RunOptions,
  outDir: string,
  runStamp: string,
  siteLabel: string,
  zipPath: string | null,
): Promise<SiteRunResult> {
  const startedAt = Date.now();
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\nCrawling ${url}...\n`);
  const crawled = await crawl(url, options, outDir);
  console.log(
    `\nFound ${crawled.pages.length} page(s). ${options.mirror ? "Mirroring assets (screenshots skipped)..." : "Shooting..."}\n`,
  );

  // Kick off passive recon and CVE correlation now so they overlap with the
  // (slower) screenshot/Lighthouse phases. Tech is already in hand from crawl.
  const techRollup = options.noRecon ? [] : rollupTech([...crawled.tech.values()]);
  const reconP: Promise<SiteIntel | null> = options.noRecon
    ? Promise.resolve(null)
    : gatherSiteIntel(crawled.baseOrigin, options).catch((err) => {
        console.warn(`Recon phase failed: ${(err as Error).message}`);
        return null;
      });
  const cveP = options.noRecon || options.noCve
    ? Promise.resolve([])
    : correlateVulnerabilities(techRollup, { nvd: true }).catch((err) => {
        console.warn(`CVE correlation failed: ${(err as Error).message}`);
        return [];
      });

  const { axeResults, screenCounts } = options.mirror
    ? { axeResults: new Map<string, AxeSummary>(), screenCounts: new Map<string, Record<string, number>>() }
    : await shoot(crawled.pages, outDir, !options.noAxe, options);

  let lighthouse: Map<string, LighthouseDetail> | null = null;
  if (!options.noLighthouse && crawled.pages.length > 0) {
    console.log("\nRunning Lighthouse...\n");
    try {
      const port = await getFreePort();
      lighthouse = await runLighthouse(crawled.pages, port, outDir, options);
    } catch (err) {
      console.warn(`Lighthouse phase failed: ${(err as Error).message}`);
      lighthouse = null;
    }
  }

  let links: LinkCheck[] = [];
  if (!options.noLinks && crawled.outboundLinks.length > 0) {
    console.log(`\nChecking ${crawled.outboundLinks.length} outbound links...\n`);
    try {
      links = await checkLinks(crawled.outboundLinks, crawled.baseOrigin);
      const broken = links.filter((l) => !l.ok).length;
      console.log(`  ${links.length} checked, ${broken} broken`);
    } catch (err) {
      console.warn(`Link check phase failed: ${(err as Error).message}`);
    }
  }

  if (options.video && crawled.pages.length > 0) {
    const vpList = options.videoViewports.join(", ");
    const schemeList = options.videoSchemes.join(", ");
    console.log(`\nRecording videos (${vpList} × ${schemeList})...\n`);
    await recordVideos(crawled.pages, outDir, options);
  }

  if (crawled.mirror) {
    await reassembleStreams(crawled.mirror);
    const extra = await completeMirrorAssets(crawled.mirror, options.authStorage);
    if (extra) console.log(`  + mirror: fetched ${extra} CSS-referenced asset(s) the page didn't load`);
    if (options.mirrorRewrite) {
      const touched = rewriteForOffline(crawled.mirror);
      console.log(`  ↻ mirror: rewrote URLs in ${touched} file(s) for offline browsing`);
    }
    writeMirrorManifest(crawled.mirror, url);
    const m = mirrorSummary(crawled.mirror);
    console.log(
      `\nMirror: ${m.pages} page(s) HTML, ${m.saved} asset(s) saved${m.skipped ? `, ${m.skipped} skipped` : ""} → ${crawled.mirror.root}`,
    );
  }

  let siteIntel: SiteIntel | null = null;
  if (!options.noRecon) {
    console.log("\nGathering site intelligence (WHOIS/DNS/geo, tech, TLS, email)...");
    siteIntel = await reconP;
    if (siteIntel) {
      siteIntel.technologies = techRollup;
      siteIntel.vulnerabilities = await cveP;
      const tls = siteIntel.tls;
      console.log(
        `  ${siteIntel.technologies.length} technologies, ${siteIntel.vulnerabilities.length} vuln finding(s)` +
          `${tls ? `, TLS ${tls.grade}` : ""}, email ${siteIntel.email.grade}`,
      );
    }
  }

  console.log("\nBuilding results.json...");
  const results = buildResults({
    outDir,
    siteLabel,
    siteUrl: url,
    runStamp,
    durationMs: Date.now() - startedAt,
    pages: crawled.pages,
    pageStatus: crawled.pageStatus,
    lighthouse,
    baseOrigin: crawled.baseOrigin,
    axe: axeResults,
    screenCounts: options.screens ? screenCounts : null,
    seo: crawled.seo,
    security: crawled.security,
    tech: crawled.tech,
    consoleEvents: crawled.consoleEvents,
    links,
    site: siteIntel,
  });
  writeResults(outDir, results);

  console.log("Writing index.html...");
  writeIndexReport(outDir, results);

  if (zipPath) {
    console.log("Zipping...");
    await zipDir(outDir, zipPath);
  }

  const lhSummary = lighthouse ? `, Lighthouse on ${lighthouse.size}` : ", Lighthouse skipped";
  const axeSummary = !options.noAxe ? `, axe on ${axeResults.size}` : ", axe skipped";
  const linksSummary = links.length > 0 ? `, ${links.length} links (${links.filter((l) => !l.ok).length} broken)` : "";
  const modeCount = options.noDark ? 1 : COLOR_SCHEMES.length;
  console.log(
    `\nDone (${siteLabel}). ${crawled.pages.length} pages × ${VIEWPORTS.length} viewports × ${modeCount} modes${lhSummary}${axeSummary}${linksSummary}`,
  );

  return { results, outDir, zipPath };
}

function siteLabelFor(url: string): string {
  return new URL(url).hostname.replace(/[^a-zA-Z0-9.\-]/g, "-");
}

// Pre-flight VPN/proxy check (--verify-ip). Confirms the public exit IP this
// machine presents isn't your real connection BEFORE any crawl request leaves —
// so a dropped or forgotten VPN aborts the run instead of leaking your IP. The
// lookup rides the same network path trawl uses, so it reflects the tunnel.
async function verifyVpn(opts: RunOptions): Promise<void> {
  console.log("Verifying exit IP (--verify-ip)...");
  const info = await lookupExitIp();
  if (!info || !info.ip) {
    console.error(
      "trawl: could not determine your exit IP (network/API error). Aborting so nothing leaks.",
    );
    process.exit(1);
  }
  const where = [info.city, info.country].filter(Boolean).join(", ");
  console.log(`  exit IP : ${info.ip}${where ? `  (${where})` : ""}`);
  console.log(`  network : ${info.org || info.isp || "unknown"}${info.asn ? `  [${info.asn}]` : ""}`);

  // Strongest check: you supplied your real (VPN-off) IP, so we can be definitive.
  if (opts.homeIp) {
    if (info.ip === opts.homeIp) {
      console.error(
        `\ntrawl: exit IP equals your real IP (${opts.homeIp}) — VPN is OFF. Aborting.`,
      );
      process.exit(1);
    }
    console.log(`  verdict : differs from your real IP (${opts.homeIp}) — VPN active ✓\n`);
    return;
  }

  // Heuristic: VPN/datacenter exits are flagged hosting/proxy by ip-api;
  // residential and mobile ISP connections are not.
  if (!info.proxy && !info.hosting) {
    console.error(
      `\ntrawl: exit IP looks like a residential/ISP connection (${info.org || info.isp}), not a VPN.\n` +
        `Connect Proton VPN (kill switch on) and retry, or pass --home-ip <your-real-ip> for a definitive check.`,
    );
    process.exit(1);
  }
  console.log(
    `  verdict : VPN/datacenter route (hosting=${info.hosting}, proxy=${info.proxy}) ✓\n`,
  );
}

async function main(): Promise<void> {
  const { urls, options } = parseCli();
  if (options.verifyIp) await verifyVpn(options);
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const downloads = path.join(os.homedir(), "Downloads");

  if (urls.length === 1) {
    const url = urls[0]!;
    const label = siteLabelFor(url);
    const outDir = path.join(downloads, `trawl-${label}-${runStamp}`);
    const zipPath = path.join(downloads, `trawl-${label}-${runStamp}.zip`);

    const result = await runSite(url, options, outDir, runStamp, label, zipPath);

    const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
    console.log(`Output: ${result.outDir}`);
    console.log(`Zip:    ${zipPath} (${mb} MB)\n`);
    return;
  }

  // Multi-site compare mode
  const compareDir = path.join(downloads, `trawl-compare-${runStamp}`);
  const compareZip = path.join(downloads, `trawl-compare-${runStamp}.zip`);
  const sitesDir = path.join(compareDir, "sites");
  fs.mkdirSync(sitesDir, { recursive: true });

  const runs: { results: Results; dir: string }[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    const label = siteLabelFor(url);
    const subDirName = label;
    const outDir = path.join(sitesDir, subDirName);

    console.log(`\n=== [${i + 1}/${urls.length}] ${url} ===`);
    try {
      const r = await runSite(url, options, outDir, runStamp, label, null);
      runs.push({ results: r.results, dir: subDirName });
    } catch (err) {
      console.warn(`\nSite failed: ${url} — ${(err as Error).message}`);
    }
  }

  if (runs.length === 0) {
    console.error("\nNo sites completed successfully.");
    process.exit(1);
  }

  console.log("\nBuilding comparison report...");
  writeCompareReport(compareDir, runStamp, runs);

  console.log("Zipping compare bundle...");
  await zipDir(compareDir, compareZip);

  const mb = (fs.statSync(compareZip).size / 1024 / 1024).toFixed(2);
  console.log(`\nCompared ${runs.length} sites.`);
  console.log(`Output: ${compareDir}`);
  console.log(`Zip:    ${compareZip} (${mb} MB)\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
