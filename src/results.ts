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
import type { Scores } from "./lighthouse";

export const RESULTS_SCHEMA_VERSION = 1;

export type PageResult = {
  url: string;
  slug: string;
  title: string;
  status: number | null;
  lighthouse: Scores | null;
  axe: AxeSummary | null;
  seo: SeoMeta | null;
  security: SecurityHeaders | null;
  console: ConsoleEvent[];
};

export type ResultsSummary = {
  pages: number;
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
  scores: Map<string, Scores> | null;
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
  const pageResults: PageResult[] = inputs.pages.map((p) => ({
    url: p.url,
    slug: p.slug,
    title: p.title,
    status: inputs.pageStatus.get(p.slug) ?? null,
    lighthouse: inputs.scores?.get(p.slug) ?? null,
    axe: inputs.axe.get(p.slug) ?? null,
    seo: inputs.seo.get(p.slug) ?? null,
    security: inputs.security.get(p.slug) ?? null,
    console: inputs.consoleEvents.get(p.slug) ?? [],
  }));

  const consoleErrors = pageResults.reduce((s, p) => s + p.console.filter((c) => c.type === "error").length, 0);
  const pageErrors = pageResults.reduce((s, p) => s + p.console.filter((c) => c.type === "pageerror").length, 0);
  const broken = inputs.links.filter((l) => !l.ok).length;

  const lhPages = pageResults.filter((p) => p.lighthouse !== null);
  const secPages = pageResults.filter((p) => p.security !== null);

  const lighthouseAverages = lhPages.length > 0
    ? {
        performance: avg(lhPages.map((p) => p.lighthouse!.performance)),
        accessibility: avg(lhPages.map((p) => p.lighthouse!.accessibility)),
        bestPractices: avg(lhPages.map((p) => p.lighthouse!.bestPractices)),
        seo: avg(lhPages.map((p) => p.lighthouse!.seo)),
      }
    : null;

  const securityAverage = secPages.length > 0 ? avg(secPages.map((p) => p.security!.score)) : null;

  const axePages = pageResults.filter((p) => p.axe !== null);
  const axeSummary = axePages.length > 0
    ? {
        violations: axePages.reduce((s, p) => s + p.axe!.violationCount, 0),
        nodes: axePages.reduce((s, p) => s + p.axe!.nodeCount, 0),
      }
    : null;

  const summary: ResultsSummary = {
    pages: pageResults.length,
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
