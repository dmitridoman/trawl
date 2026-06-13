import fingerprintsData from "./data/fingerprints.json" with { type: "json" };
import categoriesData from "./data/categories.json" with { type: "json" };
import type { TechFinding, TechResult } from "./util";

// Wappalyzer-style technology fingerprinting over the community-maintained
// fingerprint dataset (enthec/webappanalyzer). Fully passive: it only matches
// patterns against the response headers, cookies, HTML, script URLs, <meta>
// tags, JS globals and URL that the crawl already collected. The `dom` matcher
// is intentionally not implemented (it needs per-selector page evaluation).

const fingerprints = fingerprintsData as Record<string, any>;
const categories = categoriesData as Record<string, { name: string }>;

// Inputs gathered per page during the crawl.
export type TechInput = {
  url: string;
  headers: Record<string, string>; // lower-cased header names
  cookies: { name: string; value: string }[];
  html: string;
  scriptSrc: string[];
  metas: Record<string, string>; // lower-cased meta name/property -> content
  jsGlobals: Record<string, string>; // dotted global path -> stringified value (present only)
};

// Distinct JS global paths referenced by the dataset, so the page can probe
// them all in a single evaluate() and report which exist.
export const JS_GLOBAL_PATHS: string[] = (() => {
  const set = new Set<string>();
  for (const fp of Object.values(fingerprints)) {
    if (fp && typeof fp.js === "object") {
      for (const key of Object.keys(fp.js)) set.add(key);
    }
  }
  return Array.from(set);
})();

type CompiledPattern = { regex: RegExp | null; versionTemplate: string | null; confidence: number };
const patternCache = new Map<string, CompiledPattern>();

function compilePattern(str: string): CompiledPattern {
  const cached = patternCache.get(str);
  if (cached) return cached;
  const parts = str.split("\\;");
  let versionTemplate: string | null = null;
  let confidence = 100;
  for (const p of parts.slice(1)) {
    const idx = p.indexOf(":");
    const k = idx === -1 ? p : p.slice(0, idx);
    const v = idx === -1 ? "" : p.slice(idx + 1);
    if (k === "version") versionTemplate = v;
    else if (k === "confidence") confidence = parseInt(v, 10) || 0;
  }
  let regex: RegExp | null;
  try {
    regex = new RegExp(parts[0] ?? "", "i");
  } catch {
    regex = null;
  }
  const compiled = { regex, versionTemplate, confidence };
  patternCache.set(str, compiled);
  return compiled;
}

function applyVersion(template: string | null, m: RegExpMatchArray): string | null {
  if (!template) return null;
  // Ternary form: \1?trueValue:falseValue
  const tern = /^\\(\d)\?([^:]*):(.*)$/.exec(template);
  if (tern) {
    const g = m[Number(tern[1])];
    return (g ? tern[2] : tern[3]) || null;
  }
  const out = template.replace(/\\(\d)/g, (_, d: string) => m[Number(d)] ?? "");
  return out.trim() || null;
}

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  if (typeof v === "string") return [v];
  return [];
}

type Acc = { confidence: number; version: string | null };

function testInto(acc: Map<string, Acc>, name: string, patternStr: string, value: string): void {
  const { regex, versionTemplate, confidence } = compilePattern(patternStr);
  if (!regex) return;
  const m = regex.exec(value);
  if (!m) return;
  const cur = acc.get(name) ?? { confidence: 0, version: null };
  cur.confidence = Math.min(100, cur.confidence + confidence);
  if (!cur.version) cur.version = applyVersion(versionTemplate, m);
  acc.set(name, cur);
}

function categoryNames(cats: unknown): string[] {
  if (!Array.isArray(cats)) return [];
  return cats.map((id) => categories[String(id)]?.name).filter((n): n is string => Boolean(n));
}

export function detectTech(input: TechInput): TechResult {
  const acc = new Map<string, Acc>();

  for (const [name, fp] of Object.entries(fingerprints)) {
    if (!fp || typeof fp !== "object") continue;

    if (fp.headers && typeof fp.headers === "object") {
      for (const [h, pat] of Object.entries(fp.headers)) {
        const actual = input.headers[h.toLowerCase()];
        if (actual !== undefined && typeof pat === "string") testInto(acc, name, pat, actual);
      }
    }

    if (fp.cookies && typeof fp.cookies === "object") {
      for (const [cName, pat] of Object.entries(fp.cookies)) {
        const cookie = input.cookies.find((c) => c.name === cName);
        if (cookie && typeof pat === "string") testInto(acc, name, pat, cookie.value);
      }
    }

    if (fp.meta && typeof fp.meta === "object") {
      for (const [mName, pat] of Object.entries(fp.meta)) {
        const actual = input.metas[mName.toLowerCase()];
        if (actual !== undefined && typeof pat === "string") testInto(acc, name, pat, actual);
      }
    }

    for (const pat of asArray(fp.scriptSrc)) {
      for (const src of input.scriptSrc) testInto(acc, name, pat, src);
    }

    for (const pat of asArray(fp.html)) testInto(acc, name, pat, input.html);

    for (const pat of asArray(fp.url)) testInto(acc, name, pat, input.url);

    if (fp.js && typeof fp.js === "object") {
      for (const [path, pat] of Object.entries(fp.js)) {
        const val = input.jsGlobals[path];
        if (val !== undefined && typeof pat === "string") testInto(acc, name, pat, val);
      }
    }
  }

  // Keep technologies that reached a reasonable confidence (filters out weak,
  // single low-confidence signals that would otherwise be false positives).
  const detected = new Map<string, TechFinding>();
  for (const [name, a] of acc) {
    if (a.confidence < 50) continue;
    const fp = fingerprints[name];
    detected.set(name, {
      name,
      categories: categoryNames(fp?.cats),
      version: a.version,
      confidence: a.confidence,
      icon: typeof fp?.icon === "string" ? fp.icon : undefined,
      website: typeof fp?.website === "string" ? fp.website : undefined,
      cpe: typeof fp?.cpe === "string" ? fp.cpe : null,
    });
  }

  // Resolve `implies` transitively (e.g. WordPress => PHP, MySQL).
  const worklist = Array.from(detected.keys());
  while (worklist.length > 0) {
    const name = worklist.pop()!;
    const implies = asArray(fingerprints[name]?.implies);
    for (const raw of implies) {
      const impliedName = raw.split("\\;")[0]!;
      if (detected.has(impliedName) || !fingerprints[impliedName]) continue;
      const fp = fingerprints[impliedName];
      detected.set(impliedName, {
        name: impliedName,
        categories: categoryNames(fp?.cats),
        version: null,
        confidence: 100,
        icon: typeof fp?.icon === "string" ? fp.icon : undefined,
        website: typeof fp?.website === "string" ? fp.website : undefined,
        cpe: typeof fp?.cpe === "string" ? fp.cpe : null,
      });
      worklist.push(impliedName);
    }
  }

  return { technologies: Array.from(detected.values()).sort((a, b) => a.name.localeCompare(b.name)) };
}

// Dedupe technologies across all crawled pages into one site-level list,
// keeping the highest confidence and any version that was found.
export function rollupTech(results: (TechResult | null | undefined)[]): TechFinding[] {
  const byName = new Map<string, TechFinding>();
  for (const r of results) {
    if (!r) continue;
    for (const t of r.technologies) {
      const cur = byName.get(t.name);
      if (!cur) {
        byName.set(t.name, { ...t });
      } else {
        cur.confidence = Math.max(cur.confidence, t.confidence);
        if (!cur.version && t.version) cur.version = t.version;
      }
    }
  }
  return Array.from(byName.values()).sort((a, b) => {
    // CMS/e-commerce/framework first (more sales-relevant), then alphabetical.
    return a.name.localeCompare(b.name);
  });
}
