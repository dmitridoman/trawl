import { chromium } from "playwright";
import { ZipArchive } from "archiver";
import path from "path";
import fs from "fs";
import os from "os";
import net from "net";
import { runLighthouse, type Scores } from "./lighthouse";
import { writeIndexReport } from "./report";
import { VIEWPORTS, COLOR_SCHEMES, toSlug, type PageRecord } from "./util";
import { dismissCookieBanner } from "./cookies";

const args = process.argv.slice(2);
const BASE_URL = args.find((a) => !a.startsWith("-"));
const NO_LIGHTHOUSE = args.includes("--no-lighthouse");

if (!BASE_URL || args.includes("-h") || args.includes("--help")) {
  console.log(`
crawlshot — crawl a site and screenshot every internal page

Usage:
  crawlshot <url> [--no-lighthouse]

Examples:
  crawlshot http://localhost:3000
  crawlshot https://example.com
  crawlshot https://example.com --no-lighthouse

Output:
  ~/Downloads/crawlshot-<site>-<timestamp>/
    index.html        report — thumbnails + Lighthouse score chips
    light/
      phone/          375px screenshots, one PNG per page
      tablet/         768px screenshots, one PNG per page
      desktop/        1440px screenshots, one PNG per page
    dark/
      phone/          …
      tablet/         …
      desktop/        …
    lighthouse/       per-page Lighthouse HTML reports (unless --no-lighthouse)
  ~/Downloads/crawlshot-<site>-<timestamp>.zip

Flags:
  --no-lighthouse   skip the Lighthouse audit phase (faster runs)
`);
  process.exit(BASE_URL ? 0 : 1);
}

const RUN_STAMP  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const SITE_LABEL = new URL(BASE_URL).hostname.replace(/[^a-zA-Z0-9.\-]/g, "-");
const OUT_DIR    = path.join(os.homedir(), "Downloads", `crawlshot-${SITE_LABEL}-${RUN_STAMP}`);
const ZIP_PATH   = path.join(os.homedir(), "Downloads", `crawlshot-${SITE_LABEL}-${RUN_STAMP}.zip`);

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

async function crawl(baseUrl: string): Promise<PageRecord[]> {
  const visited = new Set<string>();
  const queue: string[] = [baseUrl];
  const pages: PageRecord[] = [];

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  let resolvedOrigin: string | null = null;

  while (queue.length > 0) {
    const url = queue.shift()!;
    const key = new URL(url).pathname.replace(/\/$/, "") || "/";

    if (visited.has(key)) continue;
    visited.add(key);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await dismissCookieBanner(page);

      if (!resolvedOrigin) {
        resolvedOrigin = new URL(page.url()).origin;
      }

      const resolvedUrl = page.url();
      const title = (await page.title().catch(() => "")) || "";
      pages.push({ url: resolvedUrl, slug: toSlug(resolvedUrl), title });

      const links = await page.evaluate((origin: string | null) => {
        return Array.from(document.querySelectorAll("a[href]"))
          .map((el) => (el as HTMLAnchorElement).href)
          .map((href) => {
            try {
              const u = new URL(href);
              return u.origin + u.pathname;
            } catch {
              return null;
            }
          })
          .filter((href): href is string => {
            if (!href) return false;
            try {
              const u = new URL(href);
              return (
                (origin === null || u.origin === origin) &&
                !u.pathname.match(/\.(pdf|jpg|jpeg|png|svg|webp|zip|xml|json|ico|txt|css|js|mjs|map)$/i)
              );
            } catch {
              return false;
            }
          });
      }, resolvedOrigin);

      const newLinks: string[] = [];
      for (const link of links) {
        const linkKey = new URL(link).pathname.replace(/\/$/, "") || "/";
        if (!visited.has(linkKey) && !queue.some((q) => new URL(q).pathname.replace(/\/$/, "") === linkKey)) {
          queue.push(link);
          newLinks.push(linkKey);
        }
      }
      const resolvedKey = new URL(page.url()).pathname.replace(/\/$/, "") || "/";
      console.log(`  crawled → ${resolvedKey}  (${links.length} links, ${newLinks.length} new)`);
    } catch (err) {
      console.warn(`  skipped  → ${key}  (${(err as Error).message})`);
    }
  }

  await browser.close();
  return pages;
}

async function shoot(pages: PageRecord[]): Promise<void> {
  const browser = await chromium.launch();

  for (const scheme of COLOR_SCHEMES) {
    for (const vp of VIEWPORTS) {
      fs.mkdirSync(path.join(OUT_DIR, scheme, vp.name), { recursive: true });
    }
  }

  for (const rec of pages) {
    for (const scheme of COLOR_SCHEMES) {
      for (const vp of VIEWPORTS) {
        const ctx = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          colorScheme: scheme,
          reducedMotion: "reduce",
        });
        const page = await ctx.newPage();

        try {
          await page.goto(rec.url, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
          await page.evaluate(() => (document as { fonts?: { ready: Promise<unknown> } }).fonts?.ready).catch(() => {});
          await dismissCookieBanner(page);
          await page.addStyleTag({ content: STILL_CSS }).catch(() => {});
          await page.addStyleTag({ content: HIDE_BANNERS_CSS }).catch(() => {});
          await page.waitForTimeout(500);
          await page.screenshot({
            path: path.join(OUT_DIR, scheme, vp.name, `${rec.slug}.png`),
            fullPage: true,
          });
          console.log(`  ✓ ${rec.slug} @ ${scheme}/${vp.name} (${vp.width}px)`);
        } catch {
          console.warn(`  ✗ ${rec.slug} @ ${scheme}/${vp.name} — failed`);
        } finally {
          await ctx.close();
        }
      }
    }
  }

  await browser.close();
}

function zip(): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(ZIP_PATH);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(OUT_DIR, false);
    archive.finalize();
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`\nCrawling ${BASE_URL}...\n`);
  const pages = await crawl(BASE_URL!);
  console.log(`\nFound ${pages.length} page(s). Shooting...\n`);

  await shoot(pages);

  let scores: Map<string, Scores> | null = null;
  if (!NO_LIGHTHOUSE && pages.length > 0) {
    console.log("\nRunning Lighthouse...\n");
    try {
      const port = await getFreePort();
      scores = await runLighthouse(pages, port, OUT_DIR);
    } catch (err) {
      console.warn(`Lighthouse phase failed: ${(err as Error).message}`);
      scores = null;
    }
  }

  console.log("\nWriting index.html...");
  writeIndexReport(OUT_DIR, SITE_LABEL, RUN_STAMP, pages, scores);

  console.log("Zipping...");
  await zip();

  const mb = (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(2);
  const lhSummary = scores ? `, Lighthouse on ${scores.size}` : ", Lighthouse skipped";
  console.log(`\nDone. ${pages.length} pages × ${VIEWPORTS.length} viewports × ${COLOR_SCHEMES.length} modes${lhSummary}`);
  console.log(`Output: ${OUT_DIR}`);
  console.log(`Zip:    ${ZIP_PATH} (${mb} MB)\n`);
}

main();
