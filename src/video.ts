import { chromium } from "playwright";
import path from "path";
import fs from "fs";
import { VIEWPORTS, COLOR_SCHEMES, type PageRecord, type RunOptions } from "./util";
import { dismissCookieBanner } from "./cookies";

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

export async function recordVideos(
  pages: PageRecord[],
  outDir: string,
  opts: RunOptions,
): Promise<void> {
  const targetPages = opts.videoPages
    ? pages.filter((p) => opts.videoPages!.test(p.url))
    : pages;

  if (targetPages.length === 0) {
    console.log("  (no pages matched --video-pages filter)");
    return;
  }

  const targetViewports = VIEWPORTS.filter((vp) => opts.videoViewports.includes(vp.name));
  const targetSchemes = (COLOR_SCHEMES as readonly string[]).filter((s) =>
    opts.videoSchemes.includes(s),
  ) as typeof COLOR_SCHEMES[number][];

  for (const scheme of targetSchemes) {
    for (const vp of targetViewports) {
      fs.mkdirSync(path.join(outDir, "video", scheme, vp.name), { recursive: true });
    }
  }

  const browser = await chromium.launch();

  for (const rec of targetPages) {
    for (const scheme of targetSchemes) {
      for (const vp of targetViewports) {
        const finalPath = path.join(outDir, "video", scheme, vp.name, `${rec.slug}.webm`);
        const tmpDir = path.join(outDir, "video", scheme, vp.name, `.tmp-${rec.slug}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        let ctx;
        try {
          ctx = await browser.newContext({
            storageState: opts.authStorage ?? undefined,
            viewport: { width: vp.width, height: vp.height },
            colorScheme: scheme,
            recordVideo: { dir: tmpDir, size: { width: vp.width, height: vp.height } },
          });
          const page = await ctx.newPage();

          await page.goto(rec.url, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
          await dismissCookieBanner(page);
          await page.addStyleTag({ content: HIDE_BANNERS_CSS }).catch(() => {});

          // Slow-scroll to capture the full page
          const pageHeight = await page.evaluate(() => document.body.scrollHeight);
          const steps = Math.ceil(pageHeight / vp.height);
          for (let i = 1; i <= steps; i++) {
            await page.evaluate((y) => window.scrollTo({ top: y, behavior: "smooth" }), i * vp.height);
            await page.waitForTimeout(600);
          }
          // Scroll back to top
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
          await page.waitForTimeout(400);
        } catch (err) {
          console.warn(`  ✗ ${rec.slug} @ ${scheme}/${vp.name} — video failed: ${(err as Error).message}`);
        } finally {
          await ctx?.close().catch(() => {});
        }

        // Playwright names the file automatically inside tmpDir — move it to the final path
        const recorded = fs.readdirSync(tmpDir).find((f) => f.endsWith(".webm"));
        if (recorded) {
          fs.renameSync(path.join(tmpDir, recorded), finalPath);
          console.log(`  ✓ ${rec.slug} @ ${scheme}/${vp.name}`);
        } else {
          console.warn(`  ✗ ${rec.slug} @ ${scheme}/${vp.name} — no video file produced`);
        }
        fs.rmdirSync(tmpDir, { recursive: true } as Parameters<typeof fs.rmdirSync>[1]);
      }
    }
  }

  await browser.close();
}
