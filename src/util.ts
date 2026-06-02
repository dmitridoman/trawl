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
  // Full stack trace for uncaught exceptions (pageerror). Captured so an agent
  // can locate the throwing frame without re-running the page.
  stack?: string;
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

// A single axe check result attached to a node (from the violation's any/all/none
// arrays). `message` is the human-readable, per-node fix; `data` carries structured
// specifics (e.g. color-contrast: { fgColor, bgColor, contrastRatio, expectedContrastRatio,
// fontSize, fontWeight }).
export type AxeCheck = {
  id: string;
  message: string;
  data?: unknown;
};

// A single DOM node that triggered a violation.
export type AxeNode = {
  target: string;        // CSS selector path to the element
  html: string;          // the element's outerHTML snippet
  failureSummary: string | null; // axe's "Fix any of the following: …" guidance
  checks: AxeCheck[];
};

// Cap on nodes captured per violation in results.json / index.html. The full,
// uncapped set always remains in a11y/<slug>.json.
export const AXE_NODE_CAP = 25;

export type AxeViolation = {
  id: string;
  impact: AxeImpact | null;
  help: string;
  helpUrl: string;
  wcag: string[];
  nodeCount: number;        // total nodes that triggered this rule
  nodes: AxeNode[];         // up to AXE_NODE_CAP of them, with full detail
  nodesTruncated: boolean;  // true when nodeCount > nodes.length
};

export type AxeSummary = {
  violationCount: number;
  nodeCount: number;
  byImpact: Record<AxeImpact, number>;
  violations: AxeViolation[];
};

export type LinkCheck = {
  fromSlug: string;       // first page the link was seen on (back-compat)
  fromSlugs: string[];    // every crawled page that links to this URL
  text?: string;          // anchor text, so an agent can locate the link in source
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
  video: boolean;
  videoPages: RegExp | null;
  videoViewports: string[];
  videoSchemes: string[];
};

export const DEFAULT_CONCURRENCY = 4;

