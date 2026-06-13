import jsRepoData from "./data/jsrepository.json" with { type: "json" };
import type { TechFinding, VulnFinding } from "./util";

// Known-vulnerability correlation. Defensible and passive: we read the version
// label a site already exposed and look it up against public vulnerability data.
// No exploitation, no probing.
//
//  - RetireJS dataset  -> high-confidence CVE/GHSA for JS libraries (offline)
//  - NVD API (keyword) -> best-effort, version-keyed hits for CMS/server/etc.

const retire = jsRepoData as Record<string, any>;

type RetireEntry = { vulnerabilities: any[] };
const libIndex = new Map<string, RetireEntry>();
for (const [key, entry] of Object.entries(retire)) {
  if (key === "retire-example" || !entry || !Array.isArray(entry.vulnerabilities)) continue;
  const names = new Set<string>([key.toLowerCase()]);
  if (entry.npmname) names.add(String(entry.npmname).toLowerCase());
  for (const b of entry.bowername ?? []) names.add(String(b).toLowerCase());
  for (const n of names) libIndex.set(n, entry as RetireEntry);
}

function parseVer(v: string): number[] {
  return v
    .split(/[.\-+_]/)
    .map((s) => {
      const n = parseInt(s, 10);
      return Number.isNaN(n) ? 0 : n;
    });
}

function cmpVer(a: string, b: string): number {
  const pa = parseVer(a);
  const pb = parseVer(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function normSeverity(s: unknown): VulnFinding["severity"] {
  const v = String(s ?? "").toLowerCase();
  if (v === "critical" || v === "high" || v === "medium" || v === "low") return v;
  return "unknown";
}

function lookupRetire(name: string): RetireEntry | null {
  const variants = [name.toLowerCase(), name.toLowerCase().replace(/\s+/g, "-"), name.toLowerCase().replace(/\s+/g, "")];
  for (const v of variants) {
    const hit = libIndex.get(v);
    if (hit) return hit;
  }
  return null;
}

function retireFindings(tech: TechFinding): VulnFinding[] {
  if (!tech.version) return [];
  const entry = lookupRetire(tech.name);
  if (!entry) return [];

  const out: VulnFinding[] = [];
  for (const vuln of entry.vulnerabilities) {
    const atOrAbove = vuln.atOrAbove ?? vuln.atOrEqual ?? null;
    const below = vuln.below ?? null;
    const aboveOk = !atOrAbove || cmpVer(tech.version, String(atOrAbove)) >= 0;
    const belowOk = !below || cmpVer(tech.version, String(below)) < 0;
    if (!aboveOk || !belowOk) continue;

    const ids: string[] = [
      ...(Array.isArray(vuln.identifiers?.CVE) ? vuln.identifiers.CVE : []),
      ...(vuln.identifiers?.githubID ? [vuln.identifiers.githubID] : []),
    ];
    out.push({
      component: tech.name,
      version: tech.version,
      severity: normSeverity(vuln.severity),
      ids: ids.length > 0 ? ids : ["(no public ID)"],
      summary: vuln.identifiers?.summary ?? `Known vulnerability in ${tech.name} < ${below ?? "?"}`,
      source: "retirejs",
      info: Array.isArray(vuln.info) ? vuln.info[0] ?? null : null,
      confidence: "confirmed",
    });
  }
  return out;
}

// Categories where a version-keyed NVD keyword search is worth the (rate-limited)
// round-trip. Anything else relies on the RetireJS dataset above.
const NVD_CATEGORIES = new Set(["CMS", "Web servers", "Programming languages", "Web frameworks", "Ecommerce", "Databases", "Web server extensions"]);
const NVD_MAX_COMPONENTS = 6;
const NVD_THROTTLE_MS = 6500; // NVD allows ~5 requests / 30s without a key

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function nvdFindings(tech: TechFinding): Promise<VulnFinding[]> {
  if (!tech.version) return [];
  const query = `${tech.name} ${tech.version}`;
  const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(query)}&resultsPerPage=5`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) return [];
    const data: any = await res.json();
    const items: any[] = Array.isArray(data.vulnerabilities) ? data.vulnerabilities : [];
    return items.slice(0, 3).map((it) => {
      const cve = it.cve ?? {};
      const desc = (cve.descriptions ?? []).find((d: any) => d.lang === "en")?.value ?? "";
      const sev = cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseSeverity ?? cve.metrics?.cvssMetricV30?.[0]?.cvssData?.baseSeverity ?? null;
      return {
        component: tech.name,
        version: tech.version,
        severity: normSeverity(sev),
        ids: [cve.id ?? "(unknown)"],
        summary: desc.slice(0, 240),
        source: "nvd" as const,
        info: cve.id ? `https://nvd.nist.gov/vuln/detail/${cve.id}` : null,
        confidence: "potential" as const,
      };
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const SEVERITY_RANK: Record<VulnFinding["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };

export async function correlateVulnerabilities(
  technologies: TechFinding[],
  opts: { nvd: boolean },
): Promise<VulnFinding[]> {
  const findings: VulnFinding[] = [];

  // RetireJS — offline, fast, high confidence.
  for (const tech of technologies) findings.push(...retireFindings(tech));

  // NVD — throttled, best-effort, only for the most relevant components.
  if (opts.nvd) {
    const candidates = technologies
      .filter((t) => t.version && t.categories.some((c) => NVD_CATEGORIES.has(c)) && !lookupRetire(t.name))
      .slice(0, NVD_MAX_COMPONENTS);
    if (candidates.length > 0) {
      console.log(`  querying NVD for ${candidates.length} component(s) (throttled)...`);
    }
    for (let i = 0; i < candidates.length; i++) {
      if (i > 0) await delay(NVD_THROTTLE_MS);
      findings.push(...(await nvdFindings(candidates[i]!)));
    }
    const skipped = technologies.filter((t) => t.version && t.categories.some((c) => NVD_CATEGORIES.has(c)) && !lookupRetire(t.name)).length - candidates.length;
    if (skipped > 0) console.log(`  (NVD: skipped ${skipped} further component(s) over the per-run cap of ${NVD_MAX_COMPONENTS})`);
  }

  // Dedupe by component+id, then sort by severity.
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const key = `${f.component}|${f.ids.join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.component.localeCompare(b.component));
  return deduped;
}
