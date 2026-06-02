import path from "path";
import fs from "fs";
import type {
  AxeSummary,
  ConsoleEvent,
  LinkCheck,
  PageRecord,
  SecurityHeaders,
  SeoMeta,
} from "./util";
import type { LighthouseDetail } from "./lighthouse";

// v2: per-page Lighthouse detail (millisecond metrics, opportunities, diagnostics,
// failing audits), full axe node detail, console stacks, link anchor text/referrers,
// and an `external` flag for off-origin (third-party) pages.
export const RESULTS_SCHEMA_VERSION = 2;

export type PageResult = {
  url: string;
  slug: string;
  title: string;
  status: number | null;
  external: boolean; // true when the (post-redirect) origin differs from the site origin
  lighthouse: LighthouseDetail | null;
  axe: AxeSummary | null;
  seo: SeoMeta | null;
  security: SecurityHeaders | null;
  console: ConsoleEvent[];
};

export type ResultsSummary = {
  pages: number;
  externalPages: number;
  errors: { console: number; pageErrors: number };
  links: { checked: number; broken: number };
  axe: { violations: number; nodes: number } | null;
  lighthouseAverages: { performance: number; accessibility: number; bestPractices: number; seo: number } | null;
  securityAverage: number | null;
};

export type Results = {
  schemaVersion: number;
  site: { label: string; url: string };
  runStamp: string;
  durationMs: number;
  pages: PageResult[];
  links: LinkCheck[];
  summary: ResultsSummary;
};

export type ResultsInputs = {
  outDir: string;
  siteLabel: string;
  siteUrl: string;
  runStamp: string;
  durationMs: number;
  pages: PageRecord[];
  pageStatus: Map<string, number | null>;
  lighthouse: Map<string, LighthouseDetail> | null;
  baseOrigin: string;
  axe: Map<string, AxeSummary>;
  seo: Map<string, SeoMeta>;
  security: Map<string, SecurityHeaders>;
  consoleEvents: Map<string, ConsoleEvent[]>;
  links: LinkCheck[];
};

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round(nums.reduce((s, n) => s + n, 0) / nums.length);
}

export function buildResults(inputs: ResultsInputs): Results {
  const originOf = (u: string): string | null => {
    try {
      return new URL(u).origin;
    } catch {
      return null;
    }
  };

  const pageResults: PageResult[] = inputs.pages.map((p) => ({
    url: p.url,
    slug: p.slug,
    title: p.title,
    status: inputs.pageStatus.get(p.slug) ?? null,
    external: originOf(p.url) !== inputs.baseOrigin,
    lighthouse: inputs.lighthouse?.get(p.slug) ?? null,
    axe: inputs.axe.get(p.slug) ?? null,
    seo: inputs.seo.get(p.slug) ?? null,
    security: inputs.security.get(p.slug) ?? null,
    console: inputs.consoleEvents.get(p.slug) ?? [],
  }));

  const consoleErrors = pageResults.reduce((s, p) => s + p.console.filter((c) => c.type === "error").length, 0);
  const pageErrors = pageResults.reduce((s, p) => s + p.console.filter((c) => c.type === "pageerror").length, 0);
  const broken = inputs.links.filter((l) => !l.ok).length;

  // Averages reflect the owner's own site only — third-party pages (reached via an
  // off-origin redirect, e.g. an external booking host) would otherwise skew them.
  const ownPages = pageResults.filter((p) => !p.external);
  const lhPages = ownPages.filter((p) => p.lighthouse !== null);
  const secPages = ownPages.filter((p) => p.security !== null);

  const lighthouseAverages = lhPages.length > 0
    ? {
        performance: avg(lhPages.map((p) => p.lighthouse!.scores.performance)),
        accessibility: avg(lhPages.map((p) => p.lighthouse!.scores.accessibility)),
        bestPractices: avg(lhPages.map((p) => p.lighthouse!.scores.bestPractices)),
        seo: avg(lhPages.map((p) => p.lighthouse!.scores.seo)),
      }
    : null;

  const securityAverage = secPages.length > 0 ? avg(secPages.map((p) => p.security!.score)) : null;

  const axePages = ownPages.filter((p) => p.axe !== null);
  const axeSummary = axePages.length > 0
    ? {
        violations: axePages.reduce((s, p) => s + p.axe!.violationCount, 0),
        nodes: axePages.reduce((s, p) => s + p.axe!.nodeCount, 0),
      }
    : null;

  const summary: ResultsSummary = {
    pages: pageResults.length,
    externalPages: pageResults.filter((p) => p.external).length,
    errors: { console: consoleErrors, pageErrors },
    links: { checked: inputs.links.length, broken },
    axe: axeSummary,
    lighthouseAverages,
    securityAverage,
  };

  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    site: { label: inputs.siteLabel, url: inputs.siteUrl },
    runStamp: inputs.runStamp,
    durationMs: inputs.durationMs,
    pages: pageResults,
    links: inputs.links,
    summary,
  };
}

export function writeResults(outDir: string, results: Results): void {
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
}
