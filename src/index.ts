import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
// @ts-expect-error @types/archiver is stale and doesn't export ZipArchive; v8 exports it at runtime.
import { ZipArchive } from "archiver";
import path from "path";
import fs from "fs";
import os from "os";
import net from "net";
import { parseArgs } from "node:util";
import { runLighthouse, type Scores } from "./lighthouse";
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
} from "./util";
import { dismissCookieBanner } from "./cookies";
import { extractSeo } from "./seo";
import { scoreHeaders } from "./security";
import { runAxe } from "./axe";
import { checkLinks } from "./links";
import { buildResults, writeResults, type Results } from "./results";
import { writeCompareReport } from "./compare";
import { recordVideos } from "./video";

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

const HELP = `
crawlshot — crawl a site and audit every internal page

Usage:
  crawlshot <url> [flags]
  crawlshot <url> <url> <url> [flags]       multi-site compare mode
  crawlshot <urls.txt> [flags]              read URLs from a file (one per line, # for comments)

Examples:
  crawlshot http://localhost:3000
  crawlshot https://example.com --max-pages 50 --concurrency 6
  crawlshot https://example.com --exclude '/blog/'
  crawlshot https://stripe.com https://plaid.com https://truelayer.com
  crawlshot ./prospects.txt --max-pages 30

Audit flags:
  --no-lighthouse        skip the Lighthouse audit phase
  --no-axe               skip the axe-core a11y scan
  --no-links             skip outbound-link HEAD checks

Scope flags:
  --max-pages <N>        stop after N pages have been crawled
  --max-depth <N>        only follow links up to depth N from the start URL
  --include <regex>      only crawl URLs whose full URL matches this regex
  --exclude <regex>      skip URLs whose full URL matches this regex

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
        "max-pages":      { type: "string" },
        "max-depth":      { type: "string" },
        "include":        { type: "string" },
        "exclude":        { type: "string" },
        "concurrency":    { type: "string" },
        "video":          { type: "boolean" },
        "video-pages":    { type: "string" },
        "video-viewport": { type: "string", multiple: true },
        "video-scheme":   { type: "string", multiple: true },
        "help":           { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`crawlshot: ${(err as Error).message}`);
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
      console.error(`crawlshot: --${name} must be a positive number, got ${raw}`);
      process.exit(1);
    }
    return n;
  };

  const re = (raw: string | undefined, name: string): RegExp | null => {
    if (raw === undefined) return null;
    try {
      return new RegExp(raw);
    } catch (err) {
      console.error(`crawlshot: --${name} is not a valid regex: ${(err as Error).message}`);
      process.exit(1);
    }
  };

  const videoEnabled = Boolean(values["video"]);

  const rawViewports = (values["video-viewport"] as string[] | undefined) ?? [];
  const validViewportNames = VIEWPORTS.map((v) => v.name);
  for (const vp of rawViewports) {
    if (!validViewportNames.includes(vp as typeof VIEWPORTS[number]["name"])) {
      console.error(`crawlshot: --video-viewport must be one of: ${validViewportNames.join(", ")}, got "${vp}"`);
      process.exit(1);
    }
  }
  const videoViewports = rawViewports.length > 0 ? rawViewports : ["desktop"];

  const rawSchemes = (values["video-scheme"] as string[] | undefined) ?? [];
  const validSchemes = [...COLOR_SCHEMES];
  for (const s of rawSchemes) {
    if (!validSchemes.includes(s as typeof COLOR_SCHEMES[number])) {
      console.error(`crawlshot: --video-scheme must be one of: ${validSchemes.join(", ")}, got "${s}"`);
      process.exit(1);
    }
  }
  const videoSchemes = rawSchemes.length > 0 ? rawSchemes : ["light"];

  const options: RunOptions = {
    noLighthouse: Boolean(values["no-lighthouse"]),
    noAxe:        Boolean(values["no-axe"]),
    noLinks:      Boolean(values["no-links"]),
    maxPages:     num(values["max-pages"], "max-pages"),
    maxDepth:     num(values["max-depth"], "max-depth"),
    include:      re(values["include"], "include"),
    exclude:      re(values["exclude"], "exclude"),
    concurrency:  num(values["concurrency"], "concurrency") ?? DEFAULT_CONCURRENCY,
    video:        videoEnabled,
    videoPages:   re(values["video-pages"], "video-pages"),
    videoViewports,
    videoSchemes,
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
        console.error(`crawlshot: ${candidate} contains no URLs`);
        process.exit(1);
      }
      return urls;
    }
  }
  for (const p of positionals) {
    if (!/^https?:\/\//i.test(p)) {
      console.error(`crawlshot: not a URL or file: ${p}`);
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
  consoleEvents: Map<string, ConsoleEvent[]>;
  outboundLinks: { fromSlug: string; url: string }[];
  baseOrigin: string;
};

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
    sink.push({ type: "pageerror", text: err.message });
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

async function crawl(baseUrl: string, opts: RunOptions): Promise<CrawlOutput> {
  const visited = new Set<string>();
  const queued = new Set<string>();
  const queue: CrawlQueueItem[] = [];

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
  const consoleEvents = new Map<string, ConsoleEvent[]>();
  const outboundLinks: { fromSlug: string; url: string }[] = [];

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

      if (!resolvedOrigin) {
        resolvedOrigin = new URL(page.url()).origin;
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

      const linkData = await page.evaluate(`(() => {
        const origin = ${JSON.stringify(resolvedOrigin)};
        const all = Array.from(document.querySelectorAll("a[href]"))
          .map((el) => el.href)
          .filter((href) => Boolean(href));

        const norm = (href) => {
          try {
            const u = new URL(href);
            return { url: u.toString(), pathOnly: u.origin + u.pathname };
          } catch {
            return null;
          }
        };

        const internalForQueue = [];
        const outbound = [];
        for (const raw of all) {
          const n = norm(raw);
          if (!n) continue;
          let parsed;
          try { parsed = new URL(n.url); } catch { continue; }
          const isAsset = /\\.(pdf|jpg|jpeg|png|gif|svg|webp|zip|xml|json|ico|txt|css|js|mjs|map)$/i.test(parsed.pathname);
          const isMail = /^(mailto|tel|javascript):/i.test(raw);
          if (isMail) continue;
          if (origin && parsed.origin === origin && !isAsset) {
            internalForQueue.push(n.pathOnly);
          }
          if (/^https?:$/i.test(parsed.protocol) && !isAsset) {
            outbound.push(n.url);
          }
        }
        return { internalForQueue: Array.from(new Set(internalForQueue)), outbound: Array.from(new Set(outbound)) };
      })()`) as { internalForQueue: string[]; outbound: string[] };

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
        outboundLinks.push({ fromSlug: slug, url: out });
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
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
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
    consoleEvents,
    outboundLinks,
    baseOrigin: resolvedOrigin ?? new URL(baseUrl).origin,
  };
}

type ShootJob = { rec: PageRecord; scheme: typeof COLOR_SCHEMES[number]; vp: typeof VIEWPORTS[number] };

async function shoot(pages: PageRecord[], outDir: string, runAxeScan: boolean, concurrency: number): Promise<Map<string, AxeSummary>> {
  const browser: Browser = await chromium.launch({
    args: ["--ignore-certificate-errors"],
  });
  const axeResults = new Map<string, AxeSummary>();
  const axeLock = new Set<string>(); // prevents concurrent axe runs on the same slug

  for (const scheme of COLOR_SCHEMES) {
    for (const vp of VIEWPORTS) {
      fs.mkdirSync(path.join(outDir, scheme, vp.name), { recursive: true });
    }
  }

  // Pre-flatten the full job grid so workers can pull independently.
  const jobs: ShootJob[] = [];
  for (const rec of pages) {
    for (const scheme of COLOR_SCHEMES) {
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
          viewport: { width: vp.width, height: vp.height },
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

        await page.addStyleTag({ content: STILL_CSS }).catch(() => {});
        await page.addStyleTag({ content: HIDE_BANNERS_CSS }).catch(() => {});
        await page.waitForTimeout(500);
        await page.screenshot({
          path: path.join(outDir, scheme, vp.name, `${rec.slug}.png`),
          fullPage: true,
        });
        console.log(`  ✓ ${rec.slug} @ ${scheme}/${vp.name} (${vp.width}px)`);
      } catch {
        console.warn(`  ✗ ${rec.slug} @ ${scheme}/${vp.name} — failed`);
      } finally {
        await ctx?.close().catch(() => {});
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, () => worker());
  await Promise.all(workers);
  await browser.close();
  return axeResults;
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
  const crawled = await crawl(url, options);
  console.log(`\nFound ${crawled.pages.length} page(s). Shooting...\n`);

  const axeResults = await shoot(crawled.pages, outDir, !options.noAxe, options.concurrency);

  let scores: Map<string, Scores> | null = null;
  if (!options.noLighthouse && crawled.pages.length > 0) {
    console.log("\nRunning Lighthouse...\n");
    try {
      const port = await getFreePort();
      scores = await runLighthouse(crawled.pages, port, outDir);
    } catch (err) {
      console.warn(`Lighthouse phase failed: ${(err as Error).message}`);
      scores = null;
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

  console.log("\nBuilding results.json...");
  const results = buildResults({
    outDir,
    siteLabel,
    siteUrl: url,
    runStamp,
    durationMs: Date.now() - startedAt,
    pages: crawled.pages,
    pageStatus: crawled.pageStatus,
    scores,
    axe: axeResults,
    seo: crawled.seo,
    security: crawled.security,
    consoleEvents: crawled.consoleEvents,
    links,
  });
  writeResults(outDir, results);

  console.log("Writing index.html...");
  writeIndexReport(outDir, results);

  if (zipPath) {
    console.log("Zipping...");
    await zipDir(outDir, zipPath);
  }

  const lhSummary = scores ? `, Lighthouse on ${scores.size}` : ", Lighthouse skipped";
  const axeSummary = !options.noAxe ? `, axe on ${axeResults.size}` : ", axe skipped";
  const linksSummary = links.length > 0 ? `, ${links.length} links (${links.filter((l) => !l.ok).length} broken)` : "";
  console.log(
    `\nDone (${siteLabel}). ${crawled.pages.length} pages × ${VIEWPORTS.length} viewports × ${COLOR_SCHEMES.length} modes${lhSummary}${axeSummary}${linksSummary}`,
  );

  return { results, outDir, zipPath };
}

function siteLabelFor(url: string): string {
  return new URL(url).hostname.replace(/[^a-zA-Z0-9.\-]/g, "-");
}

async function main(): Promise<void> {
  const { urls, options } = parseCli();
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const downloads = path.join(os.homedir(), "Downloads");

  if (urls.length === 1) {
    const url = urls[0]!;
    const label = siteLabelFor(url);
    const outDir = path.join(downloads, `crawlshot-${label}-${runStamp}`);
    const zipPath = path.join(downloads, `crawlshot-${label}-${runStamp}.zip`);

    const result = await runSite(url, options, outDir, runStamp, label, zipPath);

    const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
    console.log(`Output: ${result.outDir}`);
    console.log(`Zip:    ${zipPath} (${mb} MB)\n`);
    return;
  }

  // Multi-site compare mode
  const compareDir = path.join(downloads, `crawlshot-compare-${runStamp}`);
  const compareZip = path.join(downloads, `crawlshot-compare-${runStamp}.zip`);
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
