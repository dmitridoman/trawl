import { chromium } from "playwright";
import archiver from "archiver";
import path from "path";
import fs from "fs";
import { URL } from "url";

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
  ./screenshots/        per-page folders with mobile/tablet/desktop PNGs
  ./screenshots.zip     zipped bundle
`);
  process.exit(BASE_URL ? 0 : 1);
}

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

const OUT_DIR = path.join(process.cwd(), "screenshots");
const ZIP_PATH = path.join(process.cwd(), "screenshots.zip");

function toSlug(url: string): string {
  const u = new URL(url);
  const clean = u.pathname.replace(/^\/|\/$/g, "").replace(/\//g, "__");
  return clean || "home";
}

async function crawl(baseUrl: string): Promise<string[]> {
  const base = new URL(baseUrl);
  const visited = new Set<string>();
  const queue: string[] = [baseUrl];
  const pages: string[] = [];

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  while (queue.length > 0) {
    const url = queue.shift()!;
    const key = new URL(url).pathname.replace(/\/$/, "") || "/";

    if (visited.has(key)) continue;
    visited.add(key);

    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
      pages.push(url);
      console.log(`  crawled → ${key}`);

      const links = await page.evaluate((origin: string) => {
        return Array.from(document.querySelectorAll("a[href]"))
          .map((el) => (el as HTMLAnchorElement).href)
          .filter((href) => {
            try {
              const u = new URL(href);
              return (
                u.origin === origin &&
                !href.includes("#") &&
                !href.match(/\.(pdf|jpg|jpeg|png|svg|webp|zip|xml|json)$/i)
              );
            } catch {
              return false;
            }
          });
      }, base.origin);

      for (const link of links) {
        const linkKey = new URL(link).pathname.replace(/\/$/, "") || "/";
        if (!visited.has(linkKey)) queue.push(link);
      }
    } catch {
      console.warn(`  skipped  → ${key}`);
    }
  }

  await browser.close();
  return pages;
}

async function shoot(pages: string[]): Promise<void> {
  const browser = await chromium.launch();

  for (const url of pages) {
    const slug = toSlug(url);
    const dir = path.join(OUT_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });

    for (const vp of VIEWPORTS) {
      const page = await browser.newPage({
        viewport: { width: vp.width, height: vp.height },
      });

      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
        await page.waitForTimeout(500);
        await page.screenshot({
          path: path.join(dir, `${vp.name}.png`),
          fullPage: true,
        });
        console.log(`  ✓ ${slug} @ ${vp.name} (${vp.width}px)`);
      } catch {
        console.warn(`  ✗ ${slug} @ ${vp.name} — failed`);
      } finally {
        await page.close();
      }
    }
  }

  await browser.close();
}

function zip(): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(ZIP_PATH);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(OUT_DIR, "screenshots");
    archive.finalize();
  });
}

async function main() {
  if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true });
  if (fs.existsSync(ZIP_PATH)) fs.rmSync(ZIP_PATH);
  fs.mkdirSync(OUT_DIR);

  console.log(`\nCrawling ${BASE_URL}...\n`);
  const pages = await crawl(BASE_URL);
  console.log(`\nFound ${pages.length} page(s). Shooting...\n`);

  await shoot(pages);

  console.log("\nZipping...");
  await zip();

  const mb = (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(2);
  console.log(`\nDone. ${pages.length} pages × 3 viewports`);
  console.log(`Zip: ${ZIP_PATH} (${mb} MB)\n`);
}

main();
