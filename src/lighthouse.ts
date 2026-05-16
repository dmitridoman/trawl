import { chromium } from "playwright";
import path from "path";
import fs from "fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { PageRecord } from "./util";
import { dismissCookieBanner } from "./cookies";

export type Scores = {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
};

// Jittered delay between Lighthouse audits. Lighthouse fires many requests per
// page; back-to-back audits without a breather will trip rate-limiters on
// small/shared hosts (Vercel, Wix, low-tier shared shosts), producing all-zero
// scores. 2–4s with jitter keeps per-server QPS sane.
const AUDIT_DELAY_MIN_MS = 2000;
const AUDIT_DELAY_MAX_MS = 4000;

function auditDelayMs(): number {
  return Math.floor(Math.random() * (AUDIT_DELAY_MAX_MS - AUDIT_DELAY_MIN_MS + 1)) + AUDIT_DELAY_MIN_MS;
}

export async function runLighthouse(
  pages: PageRecord[],
  port: number,
  outDir: string,
): Promise<Map<string, Scores>> {
  // Lighthouse v11+ is ESM-only; we're built to CJS via tsup. Dynamic import
  // keeps the build config untouched and resolves the ESM at runtime under Node 20+.
  const { default: lighthouse } = await import("lighthouse");

  const scores = new Map<string, Scores>();
  const lhDir = path.join(outDir, "lighthouse");
  fs.mkdirSync(lhDir, { recursive: true });

  const browser = await chromium.launch({
    args: [`--remote-debugging-port=${port}`],
  });

  if (pages.length > 0) {
    const warmupPage = await browser.newPage();
    try {
      const baseOrigin = new URL(pages[0]!.url).origin;
      await warmupPage.goto(baseOrigin, { waitUntil: "domcontentloaded", timeout: 30000 });
      await warmupPage.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await dismissCookieBanner(warmupPage);
    } catch {
      // non-fatal: lighthouse still runs, just may see the banner
    } finally {
      await warmupPage.close().catch(() => {});
    }
  }

  try {
    let isFirst = true;
    for (const rec of pages) {
      if (!isFirst) await sleep(auditDelayMs());
      isFirst = false;
      try {
        const result = await lighthouse(
          rec.url,
          {
            port,
            output: "html",
            onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
            logLevel: "error",
            disableStorageReset: true,
          },
        );

        if (!result) {
          console.warn(`  ✗ ${rec.slug} — no Lighthouse result`);
          continue;
        }

        const html = Array.isArray(result.report) ? result.report[0]! : result.report;
        fs.writeFileSync(path.join(lhDir, `${rec.slug}.html`), html);

        const cats = result.lhr.categories;
        const score = (key: string): number => {
          const raw = cats[key]?.score;
          return raw == null ? 0 : Math.round(raw * 100);
        };

        const s: Scores = {
          performance: score("performance"),
          accessibility: score("accessibility"),
          bestPractices: score("best-practices"),
          seo: score("seo"),
        };
        scores.set(rec.slug, s);
        console.log(
          `  ✓ ${rec.slug} — perf ${s.performance} / a11y ${s.accessibility} / bp ${s.bestPractices} / seo ${s.seo}`,
        );
      } catch (err) {
        console.warn(`  ✗ ${rec.slug} — Lighthouse failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await browser.close();
  }

  return scores;
}
