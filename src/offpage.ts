import fs from "fs";
import crypto from "crypto";
import { registrableDomain } from "./domain";
import type { AuthorityInfo, FieldCwvInfo, CwvMetric, RankingResult, SearchConsoleInfo } from "./util";

// Off-page / ranking intelligence. The on-page half of SEO (titles, meta, lab
// Lighthouse, broken links) is already covered by the crawl + recon. This module
// adds the signals a crawler structurally cannot compute from the page itself,
// each from a free external API, each chosen so it does NOT duplicate anything
// trawl already measures:
//
//   - OpenPageRank   -> domain authority (backlink-derived strength)        [key]
//   - Google CrUX    -> real-world FIELD Core Web Vitals (not lab)          [key]
//   - Brave Search   -> external keyword ranking position                   [key]
//   - Search Console -> the owner's actual Google performance               [oauth]
//
// All four are optional: a missing key (or, for GSC, a missing --gsc-credentials)
// makes the corresponding fetcher return null with a one-line hint, mirroring how
// the NVD lookup degrades. Nothing here is fatal.

type FetchOpts = { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number };

async function fetchJson(url: string, opts: FetchOpts = {}): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: { Accept: "application/json", ...opts.headers },
      body: opts.body,
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hostnameOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// --- OpenPageRank: domain authority (0–10) ---------------------------------

async function fetchAuthority(domain: string): Promise<AuthorityInfo> {
  const key = process.env.CRAWLSHOT_OPENPAGERANK_KEY;
  if (!key) {
    console.log("  (authority: set CRAWLSHOT_OPENPAGERANK_KEY to add a domain-rating signal — free at domcop.com/openpagerank)");
    return null;
  }
  const url = `https://openpagerank.com/api/v1.0/getPageRank?domains%5B0%5D=${encodeURIComponent(domain)}`;
  const data = await fetchJson(url, { headers: { "API-OPR": key } });
  const row = data?.response?.[0];
  if (!row || row.status_code !== 200) return null;
  const drRaw = row.page_rank_decimal;
  const dr = typeof drRaw === "number" ? drRaw : drRaw != null ? Number(drRaw) : null;
  const rankNum = row.rank != null && row.rank !== "" ? Number(String(row.rank).replace(/[^0-9]/g, "")) : NaN;
  return {
    domainRating: Number.isFinite(dr as number) ? (dr as number) : null,
    rank: Number.isFinite(rankNum) && rankNum > 0 ? rankNum : null,
    source: "openpagerank",
  };
}

// --- Google CrUX: real-world field Core Web Vitals -------------------------

function rate(value: number | null, good: number, poor: number): "good" | "ni" | "poor" | null {
  if (value == null) return null;
  if (value <= good) return "good";
  if (value <= poor) return "ni";
  return "poor";
}

async function fetchFieldCwv(origin: string): Promise<FieldCwvInfo> {
  const key = process.env.CRAWLSHOT_GOOGLE_KEY;
  if (!key) {
    console.log("  (field CWV: set CRAWLSHOT_GOOGLE_KEY to add real-world Core Web Vitals from CrUX — free Google API key)");
    return null;
  }
  const data = await fetchJson(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin }),
  });
  const metrics = data?.record?.metrics;
  if (!metrics) return null; // origin has too little real-user traffic to be in CrUX

  const p75 = (m: any): number | null => {
    const v = m?.percentiles?.p75;
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const lcpMs = p75(metrics.largest_contentful_paint);
  const inpMs = p75(metrics.interaction_to_next_paint ?? metrics.experimental_interaction_to_next_paint);
  const clsVal = p75(metrics.cumulative_layout_shift);

  const lcp: CwvMetric = { p75: lcpMs, rating: rate(lcpMs, 2500, 4000) };
  const inp: CwvMetric = { p75: inpMs, rating: rate(inpMs, 200, 500) };
  const cls: CwvMetric = { p75: clsVal, rating: rate(clsVal, 0.1, 0.25) };

  const ratings = [lcp.rating, inp.rating, cls.rating].filter((r): r is "good" | "ni" | "poor" => r !== null);
  const overall = ratings.length === 0 ? null : ratings.includes("poor") ? "poor" : ratings.includes("ni") ? "ni" : "good";
  return { lcp, inp, cls, overall, source: "crux" };
}

// --- Brave Search: external keyword ranking position -----------------------

const BRAVE_THROTTLE_MS = 1100; // free tier is ~1 request / second
const BRAVE_MAX_KEYWORDS = 10;

async function rankFor(domain: string, keyword: string, key: string): Promise<RankingResult> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(keyword)}&count=20`;
  const data = await fetchJson(url, { headers: { "X-Subscription-Token": key } });
  const results: any[] = Array.isArray(data?.web?.results) ? data.web.results : [];
  let position: number | null = null;
  for (let i = 0; i < results.length; i++) {
    const host = hostnameOf(results[i]?.url);
    if (host && registrableDomain(host) === domain) {
      position = i + 1;
      break;
    }
  }
  return { keyword, position, found: position !== null };
}

async function fetchRankings(domain: string, keywords: string[]): Promise<RankingResult[] | null> {
  const key = process.env.CRAWLSHOT_BRAVE_KEY;
  if (!key) {
    console.log("  (rankings: set CRAWLSHOT_BRAVE_KEY to add keyword positions from Brave Search — free tier at brave.com/search/api)");
    return null;
  }
  const list = keywords.slice(0, BRAVE_MAX_KEYWORDS);
  const skipped = keywords.length - list.length;
  if (skipped > 0) console.log(`  (rankings: capped at ${BRAVE_MAX_KEYWORDS} keyword(s), skipped ${skipped})`);
  if (list.length > 0) console.log(`  checking ${list.length} keyword ranking(s) via Brave (throttled ~1/s)...`);

  const out: RankingResult[] = [];
  for (let i = 0; i < list.length; i++) {
    if (i > 0) await delay(BRAVE_THROTTLE_MS);
    out.push(await rankFor(domain, list[i]!, key));
  }
  return out;
}

// --- Google Search Console: the owner's real Google performance ------------

function lastNDays(n: number): { startDate: string; endDate: string; days: number } {
  const day = 24 * 3600 * 1000;
  // GSC data lags ~2 days, so end the window a few days back for complete data.
  const end = new Date(Date.now() - 3 * day);
  const start = new Date(end.getTime() - n * day);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end), days: n };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Self-contained service-account JWT (RS256) -> access token, so GSC works
// without pulling in googleapis. Also accepts a creds file that already carries
// an `access_token`.
function signServiceAccountJwt(creds: any): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = crypto.createSign("RSA-SHA256").update(signingInput).sign(creds.private_key).toString("base64url");
  return `${signingInput}.${sig}`;
}

async function gscAccessToken(creds: any): Promise<string | null> {
  if (creds.access_token) return String(creds.access_token);
  if (creds.type === "service_account" && creds.client_email && creds.private_key) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signServiceAccountJwt(creds),
      }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return data.access_token ?? null;
  }
  return null;
}

async function fetchSearchConsole(origin: string, credsPath: string): Promise<SearchConsoleInfo> {
  let creds: any;
  try {
    creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
  } catch (e) {
    console.warn(`  (search console: cannot read ${credsPath}: ${(e as Error).message})`);
    return null;
  }
  const token = await gscAccessToken(creds).catch((e) => {
    console.warn(`  (search console auth failed: ${(e as Error).message})`);
    return null;
  });
  if (!token) {
    console.warn("  (search console: no usable credentials — need access_token or a service-account key with the property shared to it)");
    return null;
  }

  const siteUrl: string = creds.siteUrl || `${origin}/`;
  const { startDate, endDate, days } = lastNDays(28);
  const base = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const totals = await fetchJson(base, { method: "POST", headers, body: JSON.stringify({ startDate, endDate }) });
  const byQuery = await fetchJson(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ startDate, endDate, dimensions: ["query"], rowLimit: 10 }),
  });

  const t = totals?.rows?.[0];
  const queryRows: any[] = Array.isArray(byQuery?.rows) ? byQuery.rows : [];
  if (!t && queryRows.length === 0) return null;

  const topQueries = queryRows.map((r) => ({
    query: r.keys?.[0] ?? "",
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    position: round1(r.position ?? 0),
  }));

  return {
    clicks: t?.clicks ?? topQueries.reduce((s, q) => s + q.clicks, 0),
    impressions: t?.impressions ?? topQueries.reduce((s, q) => s + q.impressions, 0),
    ctr: t?.ctr ?? 0,
    position: round1(t?.position ?? 0),
    topQueries,
    rangeDays: days,
    source: "search-console",
  };
}

// --- Orchestrator ----------------------------------------------------------

export type OffpageIntel = {
  authority: AuthorityInfo;
  fieldCwv: FieldCwvInfo;
  rankings: RankingResult[] | null;
  searchConsole: SearchConsoleInfo;
};

export type OffpageOptions = {
  noPagerank: boolean;
  noCrux: boolean;
  rankKeywords: string[] | null;
  gscCredentials: string | null;
};

export async function gatherOffpageIntel(origin: string, opts: OffpageOptions): Promise<OffpageIntel> {
  let domain: string;
  try {
    domain = registrableDomain(new URL(origin).hostname);
  } catch {
    return { authority: null, fieldCwv: null, rankings: null, searchConsole: null };
  }

  const [authority, fieldCwv, rankings, searchConsole] = await Promise.all([
    opts.noPagerank ? Promise.resolve(null) : fetchAuthority(domain),
    opts.noCrux ? Promise.resolve(null) : fetchFieldCwv(origin),
    opts.rankKeywords && opts.rankKeywords.length > 0 ? fetchRankings(domain, opts.rankKeywords) : Promise.resolve(null),
    opts.gscCredentials ? fetchSearchConsole(origin, opts.gscCredentials) : Promise.resolve(null),
  ]);

  return { authority, fieldCwv, rankings, searchConsole };
}
