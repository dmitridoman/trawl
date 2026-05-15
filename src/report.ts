import path from "path";
import fs from "fs";
import { VIEWPORTS, COLOR_SCHEMES, type PageRecord } from "./util";
import type { Scores } from "./lighthouse";

const SCORE_LABELS: Record<keyof Scores, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  bestPractices: "Best Practices",
  seo: "SEO",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function scoreChip(label: string, value: number, href: string): string {
  const tier = value >= 90 ? "good" : value >= 50 ? "ok" : "bad";
  return `<a class="chip chip-${tier}" href="${escapeHtml(href)}" title="${escapeHtml(label)}">
    <span class="chip-label">${escapeHtml(label)}</span>
    <span class="chip-value">${value}</span>
  </a>`;
}

function pageCard(rec: PageRecord, scores: Scores | undefined): string {
  const title = rec.title.trim() || rec.slug;
  const lhHref = `lighthouse/${encodeURIComponent(rec.slug)}.html`;

  const chips = scores
    ? `<div class="chips">
        ${scoreChip(SCORE_LABELS.performance, scores.performance, lhHref)}
        ${scoreChip(SCORE_LABELS.accessibility, scores.accessibility, lhHref)}
        ${scoreChip(SCORE_LABELS.bestPractices, scores.bestPractices, lhHref)}
        ${scoreChip(SCORE_LABELS.seo, scores.seo, lhHref)}
      </div>`
    : "";

  const thumbs = COLOR_SCHEMES.flatMap((scheme) =>
    VIEWPORTS.map((vp) => {
      const rel = `${scheme}/${vp.name}/${encodeURIComponent(rec.slug)}.png`;
      const cap = `${scheme} · ${vp.name} · ${vp.width}×${vp.height}`;
      return `<a class="thumb" href="${rel}" target="_blank" rel="noopener">
        <img src="${rel}" alt="${escapeHtml(cap)}" loading="lazy" />
        <span class="thumb-cap">${escapeHtml(cap)}</span>
      </a>`;
    }),
  ).join("\n");

  return `<section class="card">
    <header>
      <h2>${escapeHtml(title)}</h2>
      <a class="url" href="${escapeHtml(rec.url)}" target="_blank" rel="noopener">${escapeHtml(rec.url)}</a>
    </header>
    ${chips}
    <div class="grid">${thumbs}</div>
  </section>`;
}

const CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #0e0f12; color: #e7e9ee; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  body { padding: 32px clamp(16px, 4vw, 48px); }
  h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
  .meta { color: #9ba2ad; font-size: 13px; margin-bottom: 4px; }
  .legend { color: #9ba2ad; font-size: 12px; margin-bottom: 32px; display: flex; gap: 16px; flex-wrap: wrap; }
  .legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .legend .dot-good { background: #10b981; }
  .legend .dot-ok { background: #f59e0b; }
  .legend .dot-bad { background: #ef4444; }
  .card { background: #16181d; border: 1px solid #23262d; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
  .card header { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  .card h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .card .url { color: #6b7280; font-size: 12px; text-decoration: none; word-break: break-all; }
  .card .url:hover { color: #9ba2ad; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .chip { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 999px; text-decoration: none; font-size: 12px; border: 1px solid; transition: opacity 120ms; }
  .chip:hover { opacity: 0.85; }
  .chip-label { color: inherit; }
  .chip-value { font-weight: 600; font-variant-numeric: tabular-nums; }
  .chip-good { color: #10b981; border-color: rgba(16, 185, 129, 0.3); background: rgba(16, 185, 129, 0.08); }
  .chip-ok { color: #f59e0b; border-color: rgba(245, 158, 11, 0.3); background: rgba(245, 158, 11, 0.08); }
  .chip-bad { color: #ef4444; border-color: rgba(239, 68, 68, 0.3); background: rgba(239, 68, 68, 0.08); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
  .thumb { display: flex; flex-direction: column; gap: 6px; text-decoration: none; color: inherit; }
  .thumb img { width: 100%; aspect-ratio: 9 / 16; object-fit: cover; object-position: top center; background: #0e0f12; border: 1px solid #23262d; border-radius: 6px; }
  .thumb-cap { font-size: 11px; color: #9ba2ad; text-align: center; font-variant-numeric: tabular-nums; }
  .thumb:hover img { border-color: #3b4250; }
  footer { color: #6b7280; font-size: 12px; margin-top: 32px; text-align: center; }
`;

export function writeIndexReport(
  outDir: string,
  siteLabel: string,
  runStamp: string,
  pages: PageRecord[],
  scores: Map<string, Scores> | null,
): void {
  const captures = pages.length * COLOR_SCHEMES.length * VIEWPORTS.length;
  const cards = pages.map((p) => pageCard(p, scores?.get(p.slug))).join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>crawlshot — ${escapeHtml(siteLabel)} — ${escapeHtml(runStamp)}</title>
  <style>${CSS}</style>
</head>
<body>
  <h1>crawlshot — ${escapeHtml(siteLabel)}</h1>
  <div class="meta">${escapeHtml(runStamp)} · ${pages.length} page${pages.length === 1 ? "" : "s"} · ${captures} capture${captures === 1 ? "" : "s"}${scores ? ` · Lighthouse on ${scores.size}` : " · Lighthouse skipped"}</div>
  <div class="legend">
    <span><span class="dot dot-good"></span>≥ 90</span>
    <span><span class="dot dot-ok"></span>50–89</span>
    <span><span class="dot dot-bad"></span>&lt; 50</span>
    <span>· click a chip to open the full Lighthouse report</span>
    <span>· click a thumbnail to open the full-size screenshot</span>
  </div>
  ${cards}
  <footer>generated by crawlshot</footer>
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, "index.html"), html);
}
