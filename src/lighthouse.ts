import { chromium, type Page } from "playwright";
import path from "path";
import fs from "fs";
import os from "os";
import { setTimeout as sleep } from "node:timers/promises";
import type { PageRecord, RunOptions } from "./util";
import { dismissCookieBanner } from "./cookies";

export type Scores = {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
};

// A single Core-Web-Vital / timing metric, with its raw numeric value (ms, or
// unitless for CLS) so an agent can reason about the actual cost, not just a 0-100.
export type LighthouseMetric = {
  id: string;
  title: string;
  numericValue: number | null;
  numericUnit: string | null;
  displayValue: string | null;
  score: number | null; // 0..1
};

export type LighthouseOpportunityItem = {
  url?: string;
  wastedMs?: number;
  wastedBytes?: number;
  totalBytes?: number;
};

// A perf opportunity (render-blocking, unused JS, oversized images, …) with the
// estimated savings and the specific offending resources.
export type LighthouseOpportunity = {
  id: string;
  title: string;
  description: string; // Lighthouse's own remediation guidance (markdown)
  savingsMs: number | null;
  savingsBytes: number | null;
  displayValue: string | null;
  items: LighthouseOpportunityItem[];
};

// Any failing audit not already surfaced as a metric/opportunity. `description`
// is Lighthouse's verbatim fix guidance — the most agent-actionable field.
export type LighthouseAudit = {
  id: string;
  title: string;
  description: string;
  score: number | null;
  displayValue: string | null;
};

export type LighthouseDiagnostics = {
  lcpElement: { selector: string; snippet: string } | null;
  layoutShiftElements: { selector: string; snippet: string; score: number | null }[];
  thirdParty: { entity: string; blockingMs: number | null; transferBytes: number | null }[];
  mainThreadWorkMs: number | null;
  bootupTimeMs: number | null;
  domSize: number | null;
};

export type LighthouseDetail = {
  scores: Scores;
  metrics: LighthouseMetric[];
  opportunities: LighthouseOpportunity[];
  diagnostics: LighthouseDiagnostics;
  failingAudits: LighthouseAudit[];
  // Where the "full report" link should point: a relative path to a saved
  // HTML report (local Lighthouse) or an external pagespeed.web.dev URL (PSI —
  // it's an API, not a report renderer, so there's no local HTML to save).
  reportUrl: string;
  source: "local" | "psi";
};

// --- Minimal local shape of the Lighthouse result (lhr) ----------------------
// We read a handful of fields out of an elaborate, version-volatile union type.
// Casting `result.lhr` to this keeps our code type-safe and resilient to LH minor
// releases without depending on LH's exported internal types.
type RawAuditItem = Record<string, unknown>;
type RawAudit = {
  id?: string;
  title?: string;
  description?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  numericValue?: number;
  numericUnit?: string;
  displayValue?: string;
  details?: {
    type?: string;
    overallSavingsMs?: number;
    overallSavingsBytes?: number;
    items?: RawAuditItem[];
  };
};
type RawLhr = {
  categories: Record<string, { score?: number | null } | undefined>;
  audits: Record<string, RawAudit | undefined>;
};

const METRIC_IDS = [
  "first-contentful-paint",
  "largest-contentful-paint",
  "total-blocking-time",
  "cumulative-layout-shift",
  "speed-index",
  "interactive",
  "max-potential-fid",
  "server-response-time",
];

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function scoreOf(a: RawAudit): number | null {
  return typeof a.score === "number" ? a.score : null;
}
function itemsOf(a: RawAudit | undefined): RawAuditItem[] {
  const items = a?.details?.items;
  return Array.isArray(items) ? items : [];
}

// Recursively find the first Lighthouse "node" value (element pointer) within an
// audit's details — handles LCP-element / layout-shift items regardless of nesting.
function findNodeValue(value: unknown): { selector: string; snippet: string } | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj.type === "node" && (typeof obj.selector === "string" || typeof obj.snippet === "string")) {
    return { selector: str(obj.selector) ?? "", snippet: str(obj.snippet) ?? "" };
  }
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const el of v) {
        const found = findNodeValue(el);
        if (found) return found;
      }
    } else if (v && typeof v === "object") {
      const found = findNodeValue(v);
      if (found) return found;
    }
  }
  return null;
}

function entityName(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return str(o.text) ?? str(o.name) ?? "";
  }
  return "";
}

function buildDiagnostics(audits: Record<string, RawAudit | undefined>): LighthouseDiagnostics {
  const lcpEl = audits["largest-contentful-paint-element"];
  const lcpElement = lcpEl?.details ? findNodeValue(lcpEl.details) : null;

  const layoutShiftElements = itemsOf(audits["layout-shift-elements"])
    .slice(0, 8)
    .map((it) => {
      const node = findNodeValue(it);
      return { selector: node?.selector ?? "", snippet: node?.snippet ?? "", score: num(it.score) };
    })
    .filter((e) => e.selector || e.snippet);

  const thirdParty = itemsOf(audits["third-party-summary"])
    .slice(0, 10)
    .map((it) => ({
      entity: entityName(it.entity),
      blockingMs: num(it.blockingTime),
      transferBytes: num(it.transferSize),
    }))
    .filter((e) => e.entity);

  return {
    lcpElement,
    layoutShiftElements,
    thirdParty,
    mainThreadWorkMs: num(audits["mainthread-work-breakdown"]?.numericValue),
    bootupTimeMs: num(audits["bootup-time"]?.numericValue),
    domSize: num(audits["dom-size"]?.numericValue),
  };
}

export function buildLighthouseDetail(lhr: RawLhr, scores: Scores, reportUrl: string, source: "local" | "psi"): LighthouseDetail {
  const audits = lhr.audits ?? {};
  const metricIds = new Set(METRIC_IDS);

  const metrics: LighthouseMetric[] = [];
  for (const id of METRIC_IDS) {
    const a = audits[id];
    if (!a) continue;
    metrics.push({
      id,
      title: str(a.title) ?? id,
      numericValue: num(a.numericValue),
      numericUnit: str(a.numericUnit),
      displayValue: str(a.displayValue),
      score: scoreOf(a),
    });
  }

  const opportunities: LighthouseOpportunity[] = [];
  const capturedAsOpp = new Set<string>();
  for (const [id, a] of Object.entries(audits)) {
    if (!a) continue;
    const score = scoreOf(a);
    if (a.details?.type !== "opportunity" || score === null || score >= 1) continue;
    opportunities.push({
      id,
      title: str(a.title) ?? id,
      description: str(a.description) ?? "",
      savingsMs: num(a.details.overallSavingsMs),
      savingsBytes: num(a.details.overallSavingsBytes),
      displayValue: str(a.displayValue),
      items: itemsOf(a)
        .slice(0, 8)
        .map((it) => ({
          url: str(it.url) ?? undefined,
          wastedMs: num(it.wastedMs) ?? undefined,
          wastedBytes: num(it.wastedBytes) ?? undefined,
          totalBytes: num(it.totalBytes) ?? undefined,
        })),
    });
    capturedAsOpp.add(id);
  }
  opportunities.sort((x, y) => (y.savingsMs ?? 0) - (x.savingsMs ?? 0));

  const failingAudits: LighthouseAudit[] = [];
  for (const [id, a] of Object.entries(audits)) {
    if (!a || metricIds.has(id) || capturedAsOpp.has(id)) continue;
    const mode = a.scoreDisplayMode;
    if (mode !== "binary" && mode !== "numeric") continue;
    const score = scoreOf(a);
    if (score === null || score >= 0.9) continue;
    failingAudits.push({
      id,
      title: str(a.title) ?? id,
      description: str(a.description) ?? "",
      score,
      displayValue: str(a.displayValue),
    });
  }
  failingAudits.sort((x, y) => (x.score ?? 1) - (y.score ?? 1));

  return { scores, metrics, opportunities, diagnostics: buildDiagnostics(audits), failingAudits, reportUrl, source };
}

// Jittered delay between Lighthouse audits. Lighthouse fires many requests per
// page; back-to-back audits without a breather will trip rate-limiters on
// small/shared hosts (Vercel, Wix, low-tier shared shosts), producing all-zero
// scores. 2–4s with jitter keeps per-server QPS sane.
const AUDIT_DELAY_MIN_MS = 2000;
const AUDIT_DELAY_MAX_MS = 4000;
const MAX_LIGHTHOUSE_ATTEMPTS = 2;

function auditDelayMs(): number {
  return Math.floor(Math.random() * (AUDIT_DELAY_MAX_MS - AUDIT_DELAY_MIN_MS + 1)) + AUDIT_DELAY_MIN_MS;
}

function categoryScores(lhr: RawLhr): Scores | null {
  const cats = lhr.categories;
  const score = (key: string): number | null => {
    const raw = cats[key]?.score;
    return raw == null ? null : Math.round(raw * 100);
  };

  const performance = score("performance");
  const accessibility = score("accessibility");
  const bestPractices = score("best-practices");
  const seo = score("seo");
  if (performance === null || accessibility === null || bestPractices === null || seo === null) {
    return null;
  }
  return { performance, accessibility, bestPractices, seo };
}

// --- PageSpeed Insights: hosted Lighthouse, no local Chrome needed ----------
// PSI runs the exact same Lighthouse engine server-side and returns the same
// `lhr` JSON shape, so buildLighthouseDetail()/categoryScores() work unchanged.
// It can only reach publicly-resolvable URLs and can't carry a --auth-storage
// session, so it's only attempted when neither applies (see runLighthouse).

function psiReportUrl(url: string): string {
  return `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(url)}&form_factor=mobile`;
}

async function fetchPsiLighthouseDetail(url: string, key: string): Promise<LighthouseDetail | null> {
  const params = new URLSearchParams({ url, key, strategy: "mobile" });
  for (const cat of ["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO"]) params.append("category", cat);

  const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`);
  if (!res.ok) throw new Error(`PSI ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data: any = await res.json();
  const lhr = data?.lighthouseResult as RawLhr | undefined;
  if (!lhr) throw new Error("PSI response missing lighthouseResult");

  const s = categoryScores(lhr);
  if (!s) throw new Error("missing Lighthouse category scores in PSI response");

  return buildLighthouseDetail(lhr, s, psiReportUrl(url), "psi");
}

export async function runLighthouse(
  pages: PageRecord[],
  port: number,
  outDir: string,
  options: Pick<RunOptions, "authStorage">,
): Promise<Map<string, LighthouseDetail>> {
  const details = new Map<string, LighthouseDetail>();
  const lhDir = path.join(outDir, "lighthouse");

  // Prefer PageSpeed Insights — no local Chrome, no risk of this machine's own
  // load skewing scores. Unusable for authenticated crawls (PSI has no session)
  // or URLs Google can't publicly resolve (localhost/staging), so those always
  // go to local Lighthouse; a per-page PSI failure also falls back to local.
  const psiKey = process.env.CRAWLSHOT_PSI_KEY;
  const psiEligible = !!psiKey && !options.authStorage;

  // Lighthouse v11+ is ESM-only; we're built to CJS via tsup. Dynamic import
  // keeps the build config untouched and resolves the ESM at runtime under
  // Node 20+. Only loaded if local Lighthouse actually runs for some page.
  let lighthouseFn: typeof import("lighthouse").default | null = null;

  const launchBrowser = async (): Promise<{ newPage: () => Promise<Page>; close: () => Promise<void> }> => {
    if (options.authStorage) {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trawl-lighthouse-"));
      const context = await chromium.launchPersistentContext(userDataDir, {
        args: [`--remote-debugging-port=${port}`],
        ignoreHTTPSErrors: true,
        storageState: options.authStorage,
      });
      const launched = {
        newPage: () => context.newPage(),
        close: async () => {
          await context.close();
          fs.rmSync(userDataDir, { recursive: true, force: true });
        },
      };
      await warmupLighthouseBrowser(launched);
      return launched;
    }

    const browser = await chromium.launch({
      args: [`--remote-debugging-port=${port}`],
    });
    const launched = {
      newPage: () => browser.newPage(),
      close: () => browser.close(),
    };
    await warmupLighthouseBrowser(launched);
    return launched;
  };

  const warmupLighthouseBrowser = async (launched: { newPage: () => Promise<Page> }): Promise<void> => {
    if (pages.length === 0) return;
    const warmupPage = await launched.newPage();
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
  };

  async function runLocal(rec: PageRecord): Promise<void> {
    if (!lighthouseFn) {
      ({ default: lighthouseFn } = await import("lighthouse"));
      fs.mkdirSync(lhDir, { recursive: true });
    }

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_LIGHTHOUSE_ATTEMPTS; attempt++) {
      let launched: { close: () => Promise<void> } | null = null;
      try {
        launched = await launchBrowser();
        const result = await lighthouseFn!(
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
          throw new Error("no Lighthouse result");
        }

        const html = Array.isArray(result.report) ? result.report[0]! : result.report;
        fs.writeFileSync(path.join(lhDir, `${rec.slug}.html`), html);

        const lhr = result.lhr as unknown as RawLhr;
        const s = categoryScores(lhr);
        if (!s) {
          throw new Error("missing Lighthouse category scores");
        }

        details.set(rec.slug, buildLighthouseDetail(lhr, s, `lighthouse/${encodeURIComponent(rec.slug)}.html`, "local"));
        console.log(
          `  ✓ ${rec.slug} — perf ${s.performance} / a11y ${s.accessibility} / bp ${s.bestPractices} / seo ${s.seo}`,
        );
        lastError = null;
        break;
      } catch (err) {
        lastError = err as Error;
        if (attempt < MAX_LIGHTHOUSE_ATTEMPTS) {
          console.warn(`  ↻ ${rec.slug} — Lighthouse retry ${attempt + 1}/${MAX_LIGHTHOUSE_ATTEMPTS}: ${lastError.message}`);
          await sleep(auditDelayMs());
        }
      } finally {
        await launched?.close().catch(() => {});
      }
    }

    if (lastError) {
      console.warn(`  ✗ ${rec.slug} — Lighthouse failed: ${lastError.message}`);
    }
  }

  let isFirstLocal = true;
  for (const rec of pages) {
    if (psiEligible) {
      try {
        const detail = await fetchPsiLighthouseDetail(rec.url, psiKey!);
        if (detail) {
          details.set(rec.slug, detail);
          const s = detail.scores;
          console.log(
            `  ✓ ${rec.slug} (PSI) — perf ${s.performance} / a11y ${s.accessibility} / bp ${s.bestPractices} / seo ${s.seo}`,
          );
          continue;
        }
      } catch (err) {
        console.warn(`  ↻ ${rec.slug} — PSI failed (${(err as Error).message}), falling back to local Lighthouse`);
      }
    }

    // Local Lighthouse launches a real browser per attempt, so keep the
    // inter-audit jitter that protects small/shared target hosts from a
    // burst of full page loads back to back.
    if (!isFirstLocal) await sleep(auditDelayMs());
    isFirstLocal = false;
    await runLocal(rec);
  }

  return details;
}
