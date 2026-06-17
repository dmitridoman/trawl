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

// ---------------------------------------------------------------------------
// Passive reconnaissance (site-level intelligence)
//
// Everything below is gathered from public registries (RDAP/DNS), the TLS
// handshake, and responses the target voluntarily returns — no active probing.
// Most of it is site-level (one domain, one cert) rather than per-page; the
// exception is `TechResult`, which is collected per page and rolled up.
// ---------------------------------------------------------------------------

export type DomainInfo = {
  domain: string;
  registrar: string | null;
  createdAt: string | null; // ISO date
  updatedAt: string | null;
  expiresAt: string | null;
  ageYears: number | null; // derived from createdAt
  nameservers: string[];
  registrantOrg: string | null;
  registrantCountry: string | null;
  statuses: string[]; // EPP statuses
  source: "rdap" | "unavailable";
  note?: string;
};

export type DnsRecords = {
  a: string[];
  aaaa: string[];
  mx: { exchange: string; priority: number }[];
  ns: string[];
  txt: string[];
  cname: string[];
  caa: string[];
  soa: string | null;
  mailProvider: string | null; // derived from MX
  dnsHost: string | null; // derived from NS
};

export type GeoInfo = {
  ip: string | null;
  country: string | null;
  countryCode: string | null;
  city: string | null;
  isp: string | null;
  org: string | null;
  asn: string | null;
  reverse: string | null;
} | null;

export type ReconSeverity = "ok" | "warn" | "bad";

export type EmailFinding = { name: string; present: boolean; value: string | null; note?: string; severity: ReconSeverity };

export type EmailSecurity = {
  spf: EmailFinding;
  dmarc: EmailFinding;
  dkim: EmailFinding;
  grade: "A" | "B" | "C" | "D" | "F";
  spoofable: boolean; // true when SPF or DMARC is missing/weak
};

export type TlsFinding = { name: string; severity: ReconSeverity; detail: string };

export type TlsInfo = {
  ok: boolean; // handshake succeeded
  protocol: string | null; // negotiated protocol
  cipher: string | null;
  issuer: string | null;
  subject: string | null;
  validFrom: string | null;
  validTo: string | null;
  daysToExpiry: number | null;
  san: string[];
  selfSigned: boolean;
  legacyProtocols: string[]; // legacy protocols the host still accepts, e.g. ["TLSv1.1"]
  grade: "A" | "B" | "C" | "D" | "F";
  findings: TlsFinding[];
  note?: string;
} | null;

export type TechFinding = {
  name: string;
  categories: string[];
  version: string | null;
  confidence: number; // 0..100
  icon?: string;
  website?: string;
  cpe?: string | null;
};

export type TechResult = {
  technologies: TechFinding[];
};

export type VulnFinding = {
  component: string;
  version: string | null;
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  ids: string[]; // CVE / GHSA identifiers
  summary: string;
  source: "retirejs" | "nvd";
  info: string | null; // a reference URL
  confidence: "confirmed" | "potential";
};

export type SiteIntel = {
  domain: DomainInfo;
  dns: DnsRecords;
  geo: GeoInfo;
  email: EmailSecurity;
  tls: TlsInfo;
  technologies: TechFinding[]; // site-level rollup, deduped across pages
  vulnerabilities: VulnFinding[];
};

export type RunOptions = {
  noLighthouse: boolean;
  noAxe: boolean;
  noLinks: boolean;
  noRecon: boolean;
  noCve: boolean;
  maxPages: number | null;
  maxDepth: number | null;
  include: RegExp | null;
  exclude: RegExp | null;
  concurrency: number;
  authStorage: string | null;
  video: boolean;
  videoPages: RegExp | null;
  videoViewports: string[];
  videoSchemes: string[];
  verifyIp: boolean;
  homeIp: string | null;
  // Mirror mode: download the site's own assets to disk (asset extraction /
  // design reference) instead of running the audit grid. See src/mirror.ts.
  mirror: boolean;
  mirrorVideo: boolean;        // also download self-hosted media + reassemble HLS/DASH
  mirrorCrossOrigin: boolean;  // also download cross-origin (CDN) assets
  mirrorRewrite: boolean;      // rewrite saved HTML/CSS URLs to local paths for offline browsing
  mirrorMedia: boolean;        // media-only: just images + video/audio (skip HTML/CSS/JS/fonts)
};

// Public exit IP + geo/ASN as the world sees this machine, with ip-api's
// proxy/hosting/mobile flags. Used by the --verify-ip VPN pre-flight check.
export type ExitIp = {
  ip: string | null;
  country: string | null;
  countryCode: string | null;
  city: string | null;
  isp: string | null;
  org: string | null;
  asn: string | null;
  proxy: boolean;
  hosting: boolean;
  mobile: boolean;
};

export const DEFAULT_CONCURRENCY = 4;
