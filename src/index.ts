import { chromium } from "playwright";
import { ZipArchive } from "archiver";
import path from "path";
import fs from "fs";
import os from "os";

const BASE_URL = process.argv[2];

if (!BASE_URL || BASE_URL === "-h" || BASE_URL === "--help") {
  console.log(`
crawlshot — crawl a site and screenshot every internal page

Usage:
  crawlshot <url>

Examples:
  crawlshot http://localhost:3000
  crawlshot https://example.com

Output:
  ~/Downloads/crawlshot-<site>-<timestamp>/
    light/
      phone/     375px screenshots, one PNG per page
      tablet/    768px screenshots, one PNG per page
      desktop/   1440px screenshots, one PNG per page
    dark/
      phone/     …
      tablet/    …
      desktop/   …
  ~/Downloads/crawlshot-<site>-<timestamp>.zip
`);
  process.exit(BASE_URL ? 0 : 1);
}

const VIEWPORTS = [
  { name: "phone",   width: 375,  height: 812  },
  { name: "tablet",  width: 768,  height: 1024 },
  { name: "desktop", width: 1440, height: 900  },
];

const COLOR_SCHEMES = ["light", "dark"] as const;

const RUN_STAMP  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const SITE_LABEL = new URL(BASE_URL).hostname.replace(/[^a-zA-Z0-9.\-]/g, "-");
const OUT_DIR    = path.join(os.homedir(), "Downloads", `crawlshot-${SITE_LABEL}-${RUN_STAMP}`);
const ZIP_PATH   = path.join(os.homedir(), "Downloads", `crawlshot-${SITE_LABEL}-${RUN_STAMP}.zip`);

function toSlug(url: string): string {
  const u = new URL(url);
  const clean = u.pathname.replace(/^\/|\/$/g, "").replace(/\//g, "__");
  return clean || "home";
}

async function crawl(baseUrl: string): Promise<string[]> {
  const visited = new Set<string>();
  const queue: string[] = [baseUrl];
  const pages: string[] = [];

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Resolve the canonical origin after any www/https redirects on the first load
  let resolvedOrigin: string | null = null;

  while (queue.length > 0) {
    const url = queue.shift()!;
    const key = new URL(url).pathname.replace(/\/$/, "") || "/";

    if (visited.has(key)) continue;
    visited.add(key);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {
        // networkidle may not fire on sites with persistent analytics; proceed anyway
      });

      // capture the real origin from wherever the browser landed (handles www redirects)
      if (!resolvedOrigin) {
        resolvedOrigin = new URL(page.url()).origin;
      }

      pages.push(page.url());

      const links = await page.evaluate((origin: string | null) => {
        return Array.from(document.querySelectorAll("a[href]"))
          .map((el) => (el as HTMLAnchorElement).href)
          .map((href) => {
            try {
              const u = new URL(href);
              // strip fragment + query for crawl canonicalisation
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

async function shoot(pages: string[]): Promise<void> {
  const browser = await chromium.launch();

  // create scheme/viewport folders up-front
  for (const scheme of COLOR_SCHEMES) {
    for (const vp of VIEWPORTS) {
      fs.mkdirSync(path.join(OUT_DIR, scheme, vp.name), { recursive: true });
    }
  }

  for (const url of pages) {
    const slug = toSlug(url);

    for (const scheme of COLOR_SCHEMES) {
      for (const vp of VIEWPORTS) {
        const ctx = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          colorScheme: scheme,
        });
        const page = await ctx.newPage();

        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(500);
          await page.screenshot({
            path: path.join(OUT_DIR, scheme, vp.name, `${slug}.png`),
            fullPage: true,
          });
          console.log(`  ✓ ${slug} @ ${scheme}/${vp.name} (${vp.width}px)`);
        } catch {
          console.warn(`  ✗ ${slug} @ ${scheme}/${vp.name} — failed`);
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
  const pages = await crawl(BASE_URL);
  console.log(`\nFound ${pages.length} page(s). Shooting...\n`);

  await shoot(pages);

  console.log("\nZipping...");
  await zip();

  const mb = (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(2);
  console.log(`\nDone. ${pages.length} pages × ${VIEWPORTS.length} viewports × ${COLOR_SCHEMES.length} modes`);
  console.log(`Output: ${OUT_DIR}`);
  console.log(`Zip:    ${ZIP_PATH} (${mb} MB)\n`);
}

main();
