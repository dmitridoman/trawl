export const VIEWPORTS = [
  { name: "phone",   width: 375,  height: 812  },
  { name: "tablet",  width: 768,  height: 1024 },
  { name: "desktop", width: 1440, height: 900  },
] as const;

export const COLOR_SCHEMES = ["light", "dark"] as const;

export type PageRecord = { url: string; slug: string; title: string };

export function toSlug(url: string): string {
  const u = new URL(url);
  const clean = u.pathname.replace(/^\/|\/$/g, "").replace(/\//g, "__");
  return clean || "home";
}

export type ConsoleEvent = {
  type: "error" | "warning" | "pageerror";
  text: string;
  location?: string;
};

export type SeoMeta = {
  title: string;
  titleLength: number;
  description: string | null;
  descriptionLength: number;
  canonical: string | null;
  robots: string | null;
  lang: string | null;
  viewport: string | null;
  h1Count: number;
  h1Text: string[];
  imgTotal: number;
  imgWithoutAlt: number;
  og: Record<string, string>;
  twitter: Record<string, string>;
  jsonLdTypes: string[];
};

export type SecurityHeaders = {
  status: number | null;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  checks: { name: string; present: boolean; value: string | null; note?: string }[];
};

export type AxeImpact = "minor" | "moderate" | "serious" | "critical";

export type AxeViolation = {
  id: string;
  impact: AxeImpact | null;
  help: string;
  helpUrl: string;
  wcag: string[];
  nodes: number;
  sampleSelector: string | null;
  sampleHtml: string | null;
};

export type AxeSummary = {
  violationCount: number;
  nodeCount: number;
  byImpact: Record<AxeImpact, number>;
  violations: AxeViolation[];
};

export type LinkCheck = {
  fromSlug: string;
  url: string;
  status: number | null;
  ok: boolean;
  redirected: boolean;
  finalUrl: string | null;
  error?: string;
  internal: boolean;
};

export type RunOptions = {
  noLighthouse: boolean;
  noAxe: boolean;
  noLinks: boolean;
  maxPages: number | null;
  maxDepth: number | null;
  include: RegExp | null;
  exclude: RegExp | null;
  concurrency: number;
};

export const DEFAULT_CONCURRENCY = 4;

