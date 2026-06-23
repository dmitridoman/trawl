import path from "path";
import fs from "fs";
import type { Results } from "./results";

export type SiteSummary = {
  label: string;
  url: string;
  dir: string; // relative dir name under sites/
  pages: number;
  durationMs: number;
  lighthouse: { performance: number; accessibility: number; bestPractices: number; seo: number } | null;
  security: number | null;
  axe: { violations: number; nodes: number } | null;
  console: number;
  brokenLinks: number;
  // Off-page / ranking (null when the relevant API key was absent for this run)
  domainRating: number | null; // OpenPageRank 0..10
  fieldLcpMs: number | null; // CrUX field LCP p75
  fieldCwvOverall: "good" | "ni" | "poor" | null;
  rankings: { keyword: string; position: number | null }[] | null;
};

function summarise(results: Results, dir: string): SiteSummary {
  const s = results.summary;
  const intel = results.intel;
  return {
    label: results.site.label,
    url: results.site.url,
    dir,
    pages: s.pages,
    durationMs: results.durationMs,
    lighthouse: s.lighthouseAverages,
    security: s.securityAverage,
    axe: s.axe,
    console: s.errors.console + s.errors.pageErrors,
    brokenLinks: s.links.broken,
    domainRating: intel?.authority?.domainRating ?? null,
    fieldLcpMs: intel?.fieldCwv?.lcp?.p75 ?? null,
    fieldCwvOverall: intel?.fieldCwv?.overall ?? null,
    rankings: intel?.rankings?.map((r) => ({ keyword: r.keyword, position: r.position })) ?? null,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tier(value: number | null, bigIsBad = false): "good" | "ok" | "bad" | "muted" {
  if (value === null) return "muted";
  if (bigIsBad) {
    if (value === 0) return "good";
    if (value < 5) return "ok";
    return "bad";
  }
  if (value >= 90) return "good";
  if (value >= 50) return "ok";
  return "bad";
}

function cell(value: number | null, opts: { bigIsBad?: boolean; suffix?: string } = {}): string {
  const t = tier(value, opts.bigIsBad);
  const display = value === null ? "—" : `${value}${opts.suffix ?? ""}`;
  return `<td class="cell cell-${t}">${escapeHtml(display)}</td>`;
}

// Off-page metrics need their own thresholds (not the 0–100 / count assumptions
// of tier()): authority is bigger-is-better on a 0–10 scale, field LCP is smaller-
// is-better in ms, SERP position is smaller-is-better and 1-based.
function cellRaw(display: string, t: "good" | "ok" | "bad" | "muted"): string {
  return `<td class="cell cell-${t}">${escapeHtml(display)}</td>`;
}

function drTier(dr: number | null): "good" | "ok" | "bad" | "muted" {
  if (dr == null) return "muted";
  return dr >= 5 ? "good" : dr >= 2.5 ? "ok" : "bad";
}

function lcpTier(ms: number | null): "good" | "ok" | "bad" | "muted" {
  if (ms == null) return "muted";
  return ms <= 2500 ? "good" : ms <= 4000 ? "ok" : "bad";
}

function fmtLcp(ms: number | null): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function rankTier(pos: number | null): "good" | "ok" | "bad" | "muted" {
  if (pos == null) return "muted";
  return pos <= 10 ? "good" : pos <= 20 ? "ok" : "bad";
}

function buildHtml(stamp: string, sites: SiteSummary[]): string {
  // The shared keyword list across all sites (same --rank applies to the whole
  // run), preserving first-seen order, so each keyword gets one comparison column.
  const keywords: string[] = [];
  for (const s of sites) for (const r of s.rankings ?? []) if (!keywords.includes(r.keyword)) keywords.push(r.keyword);
  const hasOffpage = sites.some((s) => s.domainRating != null || s.fieldLcpMs != null) || keywords.length > 0;
  const shortKw = (kw: string) => (kw.length > 14 ? kw.slice(0, 13) + "…" : kw);

  // Rank columns we'd want a "best/worst" highlight for. Lower is better for axe/console/broken.
  const rows = sites
    .map(
      (site) => `<tr>
        <th class="site-th">
          <a href="${escapeHtml(`sites/${site.dir}/index.html`)}">${escapeHtml(site.label)}</a>
          <span class="site-url">${escapeHtml(site.url)}</span>
        </th>
        <td class="cell cell-muted">${site.pages}</td>
        ${cell(site.lighthouse?.performance ?? null)}
        ${cell(site.lighthouse?.accessibility ?? null)}
        ${cell(site.lighthouse?.bestPractices ?? null)}
        ${cell(site.lighthouse?.seo ?? null)}
        ${cell(site.security)}
        ${cell(site.axe?.violations ?? null, { bigIsBad: true })}
        ${cell(site.console, { bigIsBad: true })}
        ${cell(site.brokenLinks, { bigIsBad: true })}
        ${hasOffpage ? cellRaw(site.domainRating != null ? site.domainRating.toFixed(1) : "—", drTier(site.domainRating)) : ""}
        ${hasOffpage ? cellRaw(fmtLcp(site.fieldLcpMs), lcpTier(site.fieldLcpMs)) : ""}
        ${keywords
          .map((kw) => {
            const r = site.rankings?.find((x) => x.keyword === kw);
            const pos = r ? r.position : null;
            return cellRaw(pos != null ? `#${pos}` : r ? "20+" : "—", rankTier(pos));
          })
          .join("")}
        <td class="cell cell-muted">${(site.durationMs / 1000).toFixed(1)}s</td>
      </tr>`,
    )
    .join("\n");

  const css = `
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #0e0f12; color: #e7e9ee; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    body { padding: 32px clamp(16px, 4vw, 48px); }
    h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
    .meta { color: #9ba2ad; font-size: 13px; margin-bottom: 24px; }
    .legend { color: #9ba2ad; font-size: 12px; margin-bottom: 16px; display: flex; gap: 16px; flex-wrap: wrap; }
    .legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
    .legend .dot-good { background: #10b981; }
    .legend .dot-ok { background: #f59e0b; }
    .legend .dot-bad { background: #ef4444; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; background: #16181d; border: 1px solid #23262d; border-radius: 12px; overflow: hidden; }
    th, td { padding: 12px 10px; text-align: left; border-bottom: 1px solid #23262d; }
    thead th { background: #11131a; color: #9ba2ad; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
    tbody tr:last-child th, tbody tr:last-child td { border-bottom: none; }
    .site-th { font-size: 13px; font-weight: 600; }
    .site-th a { color: #e7e9ee; text-decoration: none; }
    .site-th a:hover { text-decoration: underline; }
    .site-url { display: block; color: #6b7280; font-size: 11px; font-weight: 400; margin-top: 2px; word-break: break-all; }
    .cell { font-size: 14px; text-align: center; font-weight: 600; }
    .cell-good { color: #10b981; }
    .cell-ok { color: #f59e0b; }
    .cell-bad { color: #ef4444; }
    .cell-muted { color: #6b7280; font-weight: 400; }
    footer { color: #6b7280; font-size: 12px; margin-top: 32px; text-align: center; }
  `;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>trawl — compare ${sites.length} sites — ${escapeHtml(stamp)}</title>
  <style>${css}</style>
</head>
<body>
  <h1>trawl — compare ${sites.length} sites</h1>
  <div class="meta">${escapeHtml(stamp)} · click any site name to open its full report</div>
  <div class="legend">
    <span><span class="dot dot-good"></span>strong</span>
    <span><span class="dot dot-ok"></span>middling</span>
    <span><span class="dot dot-bad"></span>weak</span>
    <span>· lighthouse / security / authority higher is better · axe / console / broken-links / field-LCP / rank lower is better</span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Site</th>
        <th>Pages</th>
        <th>Perf</th>
        <th>A11y</th>
        <th>BP</th>
        <th>SEO</th>
        <th>Sec</th>
        <th>Axe</th>
        <th>Console</th>
        <th>Broken</th>
        ${hasOffpage ? `<th title="Domain authority (OpenPageRank, 0–10 — higher is better)">DR</th>` : ""}
        ${hasOffpage ? `<th title="Field LCP p75 from CrUX — lower is better">Field LCP</th>` : ""}
        ${keywords.map((kw) => `<th title="${escapeHtml(kw)} — SERP position, lower is better">↑ ${escapeHtml(shortKw(kw))}</th>`).join("")}
        <th>Time</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <footer>generated by trawl · machine data in <code>compare.json</code></footer>
</body>
</html>`;
}

export function writeCompareReport(outDir: string, runStamp: string, runs: { results: Results; dir: string }[]): void {
  const sites = runs.map((r) => summarise(r.results, r.dir));
  const compareJson = { schemaVersion: 2, runStamp, sites };
  fs.writeFileSync(path.join(outDir, "compare.json"), JSON.stringify(compareJson, null, 2));
  fs.writeFileSync(path.join(outDir, "compare.html"), buildHtml(runStamp, sites));
}
