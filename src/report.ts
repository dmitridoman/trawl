import path from "path";
import fs from "fs";
import { VIEWPORTS, COLOR_SCHEMES, type SeoMeta, type AxeSummary, type SecurityHeaders, type ConsoleEvent, type LinkCheck } from "./util";
import type { Scores } from "./lighthouse";
import { seoIssues } from "./seo";
import type { Results, PageResult } from "./results";

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

function tierForScore(value: number): "good" | "ok" | "bad" {
  return value >= 90 ? "good" : value >= 50 ? "ok" : "bad";
}

function scoreChip(label: string, value: number, href?: string): string {
  const tier = tierForScore(value);
  const tag = href ? "a" : "span";
  const hrefAttr = href ? ` href="${escapeHtml(href)}"` : "";
  return `<${tag} class="chip chip-${tier}"${hrefAttr} title="${escapeHtml(label)}">
    <span class="chip-label">${escapeHtml(label)}</span>
    <span class="chip-value">${value}</span>
  </${tag}>`;
}

function secChip(security: SecurityHeaders): string {
  const tier = tierForScore(security.score);
  return `<span class="chip chip-${tier}" title="Security headers (grade ${escapeHtml(security.grade)})">
    <span class="chip-label">Security</span>
    <span class="chip-value">${security.grade} · ${security.score}</span>
  </span>`;
}

function axeChip(axe: AxeSummary, href: string): string {
  const tier = axe.violationCount === 0 ? "good" : axe.byImpact.critical + axe.byImpact.serious > 0 ? "bad" : "ok";
  return `<a class="chip chip-${tier}" href="${escapeHtml(href)}" title="axe-core violations (click for full JSON)">
    <span class="chip-label">axe</span>
    <span class="chip-value">${axe.violationCount} · ${axe.nodeCount} nodes</span>
  </a>`;
}

function consoleChip(events: ConsoleEvent[]): string {
  const errors = events.filter((e) => e.type === "error" || e.type === "pageerror").length;
  const warns = events.filter((e) => e.type === "warning").length;
  if (errors === 0 && warns === 0) return "";
  const tier = errors > 0 ? "bad" : "ok";
  return `<span class="chip chip-${tier}" title="Console errors / warnings captured during crawl">
    <span class="chip-label">Console</span>
    <span class="chip-value">${errors}e / ${warns}w</span>
  </span>`;
}

function statusChip(status: number | null): string {
  if (status === null) return "";
  const tier = status >= 200 && status < 300 ? "good" : status >= 300 && status < 400 ? "ok" : "bad";
  return `<span class="chip chip-${tier}" title="HTTP status from crawl navigation">
    <span class="chip-label">HTTP</span>
    <span class="chip-value">${status}</span>
  </span>`;
}

function seoRow(seo: SeoMeta): string {
  const issues = seoIssues("", seo);
  const issueList = issues.length === 0
    ? `<span class="seo-clean">no issues</span>`
    : issues
        .map((i) => `<li class="seo-issue seo-${i.severity}">${escapeHtml(i.message)}</li>`)
        .join("");

  const kv = (label: string, value: string) =>
    `<div class="seo-cell"><span class="seo-key">${escapeHtml(label)}</span><span class="seo-val">${escapeHtml(value)}</span></div>`;

  return `<div class="seo">
    <div class="seo-grid">
      ${kv("title", `${seo.title || "—"} (${seo.titleLength})`)}
      ${kv("description", seo.description ? `${seo.description.slice(0, 100)}${seo.description.length > 100 ? "…" : ""} (${seo.descriptionLength})` : "—")}
      ${kv("canonical", seo.canonical || "—")}
      ${kv("h1", `${seo.h1Count} (${seo.h1Text[0] ?? "—"})`)}
      ${kv("alt coverage", `${seo.imgTotal - seo.imgWithoutAlt}/${seo.imgTotal}`)}
      ${kv("og", Object.keys(seo.og).length ? `${Object.keys(seo.og).length} tags` : "—")}
      ${kv("lang", seo.lang || "—")}
      ${kv("robots", seo.robots || "—")}
    </div>
    <ul class="seo-issues">${issueList}</ul>
  </div>`;
}

function pageCard(rec: PageResult): string {
  const title = rec.title.trim() || rec.slug;
  const lhHref = `lighthouse/${encodeURIComponent(rec.slug)}.html`;
  const axeHref = `a11y/${encodeURIComponent(rec.slug)}.json`;

  const chips: string[] = [];
  chips.push(statusChip(rec.status));
  if (rec.lighthouse) {
    chips.push(scoreChip(SCORE_LABELS.performance, rec.lighthouse.performance, lhHref));
    chips.push(scoreChip(SCORE_LABELS.accessibility, rec.lighthouse.accessibility, lhHref));
    chips.push(scoreChip(SCORE_LABELS.bestPractices, rec.lighthouse.bestPractices, lhHref));
    chips.push(scoreChip(SCORE_LABELS.seo, rec.lighthouse.seo, lhHref));
  }
  if (rec.axe) chips.push(axeChip(rec.axe, axeHref));
  if (rec.security) chips.push(secChip(rec.security));
  chips.push(consoleChip(rec.console));

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

  const consoleSection = rec.console.length > 0
    ? `<details class="details"><summary>Console (${rec.console.length})</summary>
        <ul class="console-list">
          ${rec.console
            .slice(0, 20)
            .map(
              (e) =>
                `<li class="console-${e.type}"><span class="console-type">${e.type}</span> ${escapeHtml(e.text)}${e.location ? ` <span class="console-loc">${escapeHtml(e.location)}</span>` : ""}</li>`,
            )
            .join("")}
        </ul>${rec.console.length > 20 ? `<p class="more">…${rec.console.length - 20} more in results.json</p>` : ""}
      </details>`
    : "";

  const axeSection = rec.axe && rec.axe.violationCount > 0
    ? `<details class="details"><summary>Accessibility (${rec.axe.violationCount} violations, ${rec.axe.nodeCount} nodes)</summary>
        <ul class="axe-list">
          ${rec.axe.violations
            .slice(0, 10)
            .map(
              (v) =>
                `<li class="axe-${v.impact ?? "minor"}">
                  <span class="axe-impact">${v.impact ?? "minor"}</span>
                  <a href="${escapeHtml(v.helpUrl)}" target="_blank" rel="noopener"><strong>${escapeHtml(v.id)}</strong></a> —
                  ${escapeHtml(v.help)} (${v.nodes} node${v.nodes === 1 ? "" : "s"})
                  ${v.wcag.length > 0 ? `<span class="axe-wcag">${v.wcag.map(escapeHtml).join(", ")}</span>` : ""}
                </li>`,
            )
            .join("")}
        </ul>${rec.axe.violations.length > 10 ? `<p class="more">…${rec.axe.violations.length - 10} more in <a href="${escapeHtml(axeHref)}">a11y/${escapeHtml(rec.slug)}.json</a></p>` : ""}
      </details>`
    : "";

  const securitySection = rec.security && rec.security.checks.some((c) => !c.present)
    ? `<details class="details"><summary>Security headers (${rec.security.grade} · ${rec.security.score})</summary>
        <ul class="sec-list">
          ${rec.security.checks
            .map(
              (c) =>
                `<li class="sec-${c.present ? "ok" : "miss"}">
                  <span class="sec-name">${escapeHtml(c.name)}</span>
                  <span class="sec-state">${c.present ? "✓" : "✗"}</span>
                  ${c.note ? `<span class="sec-note">${escapeHtml(c.note)}</span>` : ""}
                </li>`,
            )
            .join("")}
        </ul>
      </details>`
    : "";

  return `<section class="card" id="page-${escapeHtml(rec.slug)}">
    <header>
      <h2>${escapeHtml(title)}</h2>
      <a class="url" href="${escapeHtml(rec.url)}" target="_blank" rel="noopener">${escapeHtml(rec.url)}</a>
    </header>
    <div class="chips">${chips.join("")}</div>
    ${rec.seo ? seoRow(rec.seo) : ""}
    ${axeSection}
    ${securitySection}
    ${consoleSection}
    <div class="grid">${thumbs}</div>
  </section>`;
}

function issuesPanel(results: Results): string {
  const broken = results.links.filter((l) => !l.ok);
  const slugsWithConsole = results.pages.filter((p) => p.console.some((c) => c.type === "error" || c.type === "pageerror"));
  const slugsWithAxe = results.pages.filter((p) => p.axe && (p.axe.byImpact.critical + p.axe.byImpact.serious) > 0);
  const slugsWithBadStatus = results.pages.filter((p) => p.status !== null && (p.status < 200 || p.status >= 400));

  if (
    broken.length === 0 &&
    slugsWithConsole.length === 0 &&
    slugsWithAxe.length === 0 &&
    slugsWithBadStatus.length === 0
  ) {
    return `<section class="issues issues-clean"><h2>Issues</h2><p>No critical issues found.</p></section>`;
  }

  const linkRows = broken
    .slice(0, 30)
    .map(
      (l) =>
        `<tr>
          <td><a href="#page-${escapeHtml(l.fromSlug)}">${escapeHtml(l.fromSlug)}</a></td>
          <td><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.url)}</a></td>
          <td>${l.status ?? "—"}</td>
          <td>${escapeHtml(l.error ?? "")}</td>
        </tr>`,
    )
    .join("");

  return `<section class="issues">
    <h2>Issues</h2>
    ${
      slugsWithBadStatus.length > 0
        ? `<h3>Bad HTTP status (${slugsWithBadStatus.length})</h3>
           <ul>${slugsWithBadStatus.map((p) => `<li><a href="#page-${escapeHtml(p.slug)}">${escapeHtml(p.slug)}</a> — ${p.status}</li>`).join("")}</ul>`
        : ""
    }
    ${
      slugsWithAxe.length > 0
        ? `<h3>Critical / serious a11y (${slugsWithAxe.length} page${slugsWithAxe.length === 1 ? "" : "s"})</h3>
           <ul>${slugsWithAxe.map((p) => `<li><a href="#page-${escapeHtml(p.slug)}">${escapeHtml(p.slug)}</a> — ${p.axe!.byImpact.critical} critical, ${p.axe!.byImpact.serious} serious</li>`).join("")}</ul>`
        : ""
    }
    ${
      slugsWithConsole.length > 0
        ? `<h3>JS / console errors (${slugsWithConsole.length} page${slugsWithConsole.length === 1 ? "" : "s"})</h3>
           <ul>${slugsWithConsole.map((p) => `<li><a href="#page-${escapeHtml(p.slug)}">${escapeHtml(p.slug)}</a> — ${p.console.filter((c) => c.type === "error" || c.type === "pageerror").length} error${p.console.length === 1 ? "" : "s"}</li>`).join("")}</ul>`
        : ""
    }
    ${
      broken.length > 0
        ? `<h3>Broken links (${broken.length})</h3>
           <table class="links-table">
             <thead><tr><th>From</th><th>URL</th><th>Status</th><th>Error</th></tr></thead>
             <tbody>${linkRows}</tbody>
           </table>
           ${broken.length > 30 ? `<p class="more">…${broken.length - 30} more in results.json</p>` : ""}`
        : ""
    }
  </section>`;
}

function summaryBar(results: Results): string {
  const s = results.summary;
  const lh = s.lighthouseAverages;
  return `<div class="summary">
    <span class="sum-cell"><span class="sum-key">pages</span><span class="sum-val">${s.pages}</span></span>
    ${lh ? `<span class="sum-cell"><span class="sum-key">avg perf</span><span class="sum-val">${lh.performance}</span></span>` : ""}
    ${lh ? `<span class="sum-cell"><span class="sum-key">avg a11y</span><span class="sum-val">${lh.accessibility}</span></span>` : ""}
    ${lh ? `<span class="sum-cell"><span class="sum-key">avg seo</span><span class="sum-val">${lh.seo}</span></span>` : ""}
    ${s.securityAverage !== null ? `<span class="sum-cell"><span class="sum-key">security</span><span class="sum-val">${s.securityAverage}</span></span>` : ""}
    ${s.axe ? `<span class="sum-cell"><span class="sum-key">axe violations</span><span class="sum-val">${s.axe.violations} (${s.axe.nodes} nodes)</span></span>` : ""}
    <span class="sum-cell"><span class="sum-key">links</span><span class="sum-val">${s.links.checked} (${s.links.broken} broken)</span></span>
    <span class="sum-cell"><span class="sum-key">console errors</span><span class="sum-val">${s.errors.console + s.errors.pageErrors}</span></span>
  </div>`;
}

const CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #0e0f12; color: #e7e9ee; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  body { padding: 32px clamp(16px, 4vw, 48px); }
  h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
  h2 { font-size: 16px; font-weight: 600; }
  h3 { font-size: 13px; font-weight: 600; color: #c5cad3; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: 0.04em; }
  a { color: inherit; }
  .meta { color: #9ba2ad; font-size: 13px; margin-bottom: 4px; }
  .legend { color: #9ba2ad; font-size: 12px; margin-bottom: 16px; display: flex; gap: 16px; flex-wrap: wrap; }
  .legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .legend .dot-good { background: #10b981; }
  .legend .dot-ok { background: #f59e0b; }
  .legend .dot-bad { background: #ef4444; }
  .summary { display: flex; gap: 16px; flex-wrap: wrap; padding: 14px 16px; background: #16181d; border: 1px solid #23262d; border-radius: 12px; margin-bottom: 24px; }
  .sum-cell { display: flex; flex-direction: column; gap: 2px; }
  .sum-key { color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  .sum-val { color: #e7e9ee; font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .issues { background: #16181d; border: 1px solid #23262d; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
  .issues-clean { border-color: rgba(16, 185, 129, 0.3); }
  .issues h2 { margin-top: 0; }
  .issues ul { margin: 0; padding-left: 20px; color: #c5cad3; font-size: 13px; }
  .issues li { margin: 4px 0; }
  .links-table { width: 100%; font-size: 12px; border-collapse: collapse; margin-top: 6px; }
  .links-table th, .links-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #23262d; vertical-align: top; }
  .links-table th { color: #6b7280; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; }
  .links-table td { color: #c5cad3; word-break: break-all; }
  .card { background: #16181d; border: 1px solid #23262d; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
  .card header { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  .card h2 { margin: 0; }
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
  .seo { margin-bottom: 16px; padding: 12px 14px; background: #11131a; border: 1px solid #23262d; border-radius: 8px; font-size: 12px; }
  .seo-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 16px; }
  .seo-cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .seo-key { color: #6b7280; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
  .seo-val { color: #c5cad3; font-variant-numeric: tabular-nums; word-break: break-word; overflow-wrap: anywhere; }
  .seo-issues { list-style: none; padding: 0; margin: 10px 0 0; display: flex; flex-wrap: wrap; gap: 6px; }
  .seo-issue { font-size: 11px; padding: 3px 8px; border-radius: 999px; }
  .seo-warn { color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); background: rgba(245, 158, 11, 0.08); }
  .seo-error { color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); background: rgba(239, 68, 68, 0.08); }
  .seo-clean { color: #10b981; font-size: 11px; padding: 3px 8px; border-radius: 999px; border: 1px solid rgba(16, 185, 129, 0.3); background: rgba(16, 185, 129, 0.08); }
  .details { margin-bottom: 12px; }
  .details summary { cursor: pointer; color: #c5cad3; font-size: 13px; padding: 6px 0; user-select: none; }
  .details summary:hover { color: #e7e9ee; }
  .details ul { margin: 8px 0 0; padding-left: 20px; font-size: 12px; color: #c5cad3; }
  .details li { margin: 4px 0; }
  .console-error, .console-pageerror { color: #ef4444; }
  .console-warning { color: #f59e0b; }
  .console-type { display: inline-block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 5px; border-radius: 3px; background: rgba(255, 255, 255, 0.05); margin-right: 6px; }
  .console-loc { color: #6b7280; font-size: 10px; }
  .axe-impact { display: inline-block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 5px; border-radius: 3px; background: rgba(255, 255, 255, 0.05); margin-right: 6px; }
  .axe-critical .axe-impact { background: rgba(239, 68, 68, 0.18); color: #ef4444; }
  .axe-serious .axe-impact { background: rgba(245, 158, 11, 0.18); color: #f59e0b; }
  .axe-moderate .axe-impact { background: rgba(245, 158, 11, 0.10); color: #f59e0b; }
  .axe-minor .axe-impact { background: rgba(255, 255, 255, 0.06); color: #9ba2ad; }
  .axe-wcag { font-size: 10px; color: #6b7280; margin-left: 6px; }
  .sec-list { list-style: none; padding: 0 !important; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 4px 16px; }
  .sec-list li { display: flex; gap: 8px; align-items: baseline; }
  .sec-name { color: #c5cad3; }
  .sec-state { font-weight: 600; }
  .sec-ok .sec-state { color: #10b981; }
  .sec-miss .sec-state { color: #ef4444; }
  .sec-note { color: #f59e0b; font-size: 11px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
  .thumb { display: flex; flex-direction: column; gap: 6px; text-decoration: none; color: inherit; }
  .thumb img { width: 100%; aspect-ratio: 9 / 16; object-fit: cover; object-position: top center; background: #0e0f12; border: 1px solid #23262d; border-radius: 6px; }
  .thumb-cap { font-size: 11px; color: #9ba2ad; text-align: center; font-variant-numeric: tabular-nums; }
  .thumb:hover img { border-color: #3b4250; }
  .more { color: #6b7280; font-size: 11px; margin: 6px 0 0; }
  footer { color: #6b7280; font-size: 12px; margin-top: 32px; text-align: center; }
`;

export function writeIndexReport(outDir: string, results: Results): void {
  const captures = results.pages.length * COLOR_SCHEMES.length * VIEWPORTS.length;
  const cards = results.pages.map(pageCard).join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>crawlshot — ${escapeHtml(results.site.label)} — ${escapeHtml(results.runStamp)}</title>
  <style>${CSS}</style>
</head>
<body>
  <h1>crawlshot — ${escapeHtml(results.site.label)}</h1>
  <div class="meta">${escapeHtml(results.runStamp)} · ${results.pages.length} page${results.pages.length === 1 ? "" : "s"} · ${captures} capture${captures === 1 ? "" : "s"} · ${(results.durationMs / 1000).toFixed(1)}s</div>
  <div class="legend">
    <span><span class="dot dot-good"></span>≥ 90</span>
    <span><span class="dot dot-ok"></span>50–89</span>
    <span><span class="dot dot-bad"></span>&lt; 50</span>
    <span>· click chips for full reports · machine data in <code>results.json</code></span>
  </div>
  ${summaryBar(results)}
  ${issuesPanel(results)}
  ${cards}
  <footer>generated by crawlshot · schema v${results.schemaVersion}</footer>
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, "index.html"), html);
}

// Re-export the legacy type alias so older imports don't break.
export type { Scores };

// LinkCheck re-export for downstream consumers
export type { LinkCheck };
