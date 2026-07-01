import path from "path";
import fs from "fs";
import { VIEWPORTS, COLOR_SCHEMES, type SeoMeta, type AxeSummary, type AxeNode, type SecurityHeaders, type ConsoleEvent, type LinkCheck, type TechResult, type SiteIntel, type VulnFinding, type EmailFinding, type TlsFinding } from "./util";
import type { Scores, LighthouseDetail, LighthouseMetric } from "./lighthouse";
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

function fmtBytes(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${Math.round(v)} B`;
}

function metricTier(score: number | null): "good" | "ok" | "bad" {
  if (score === null) return "ok";
  return score >= 0.9 ? "good" : score >= 0.5 ? "ok" : "bad";
}

// Lighthouse descriptions are markdown; flatten links to "text (url)" and drop
// emphasis/code markers so the guidance reads cleanly as plain text.
function stripMd(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/[`*_]/g, "")
    .trim();
}

function metricRow(m: LighthouseMetric): string {
  const tier = metricTier(m.score);
  const raw = m.numericValue === null
    ? "—"
    : m.numericUnit === "millisecond"
      ? `${Math.round(m.numericValue)} ms`
      : m.numericValue.toFixed(3);
  return `<tr class="metric-${tier}">
    <td class="metric-name">${escapeHtml(m.title)}</td>
    <td class="metric-val">${escapeHtml(m.displayValue ?? "—")}</td>
    <td class="metric-raw">${escapeHtml(raw)}</td>
  </tr>`;
}

function metricValueById(detail: LighthouseDetail, id: string): string | null {
  const m = detail.metrics.find((x) => x.id === id);
  return m?.displayValue ?? null;
}

function performanceSection(detail: LighthouseDetail): string {
  const d = detail.diagnostics;

  const metricsTable = detail.metrics.length > 0
    ? `<table class="metrics-table">
        <thead><tr><th>Metric</th><th>Value</th><th>Exact</th></tr></thead>
        <tbody>${detail.metrics.map(metricRow).join("")}</tbody>
      </table>`
    : "";

  const opps = detail.opportunities.length > 0
    ? `<h4>Opportunities (${detail.opportunities.length})</h4>
       <ul class="opp-list">${detail.opportunities
         .map((o) => {
           const save = [
             o.savingsMs != null ? `~${Math.round(o.savingsMs)} ms` : null,
             o.savingsBytes != null ? `~${fmtBytes(o.savingsBytes)}` : null,
           ].filter(Boolean).join(" · ");
           const items = o.items
             .filter((it) => it.url)
             .slice(0, 6)
             .map((it) => {
               const meta = [
                 it.wastedMs != null ? `${Math.round(it.wastedMs)} ms` : null,
                 it.wastedBytes != null ? fmtBytes(it.wastedBytes) : null,
               ].filter(Boolean).join(" · ");
               return `<li><span class="opp-res">${escapeHtml(it.url ?? "")}</span>${meta ? ` <span class="opp-meta">${escapeHtml(meta)}</span>` : ""}</li>`;
             })
             .join("");
           return `<li class="opp">
             <div class="opp-head"><strong>${escapeHtml(o.title)}</strong>${save ? ` <span class="opp-save">${escapeHtml(save)}</span>` : ""}</div>
             ${items ? `<ul class="opp-items">${items}</ul>` : ""}
           </li>`;
         })
         .join("")}</ul>`
    : "";

  const diagBits: string[] = [];
  if (d.lcpElement && (d.lcpElement.selector || d.lcpElement.snippet)) {
    diagBits.push(`<li><span class="diag-key">LCP element</span> <code>${escapeHtml(d.lcpElement.selector || d.lcpElement.snippet)}</code></li>`);
  }
  if (d.layoutShiftElements.length > 0) {
    const first = d.layoutShiftElements[0]!;
    diagBits.push(`<li><span class="diag-key">Layout shift</span> <code>${escapeHtml(first.selector || first.snippet)}</code>${d.layoutShiftElements.length > 1 ? ` <span class="diag-more">+${d.layoutShiftElements.length - 1}</span>` : ""}</li>`);
  }
  if (d.thirdParty.length > 0) {
    const tp = d.thirdParty
      .slice(0, 6)
      .map((t) => `${escapeHtml(t.entity)}${t.blockingMs != null ? ` (${Math.round(t.blockingMs)} ms)` : ""}`)
      .join(", ");
    diagBits.push(`<li><span class="diag-key">Third-party</span> ${tp}</li>`);
  }
  if (d.mainThreadWorkMs != null) diagBits.push(`<li><span class="diag-key">Main-thread work</span> ${Math.round(d.mainThreadWorkMs)} ms</li>`);
  if (d.bootupTimeMs != null) diagBits.push(`<li><span class="diag-key">JS bootup</span> ${Math.round(d.bootupTimeMs)} ms</li>`);
  if (d.domSize != null) diagBits.push(`<li><span class="diag-key">DOM nodes</span> ${d.domSize}</li>`);
  const diag = diagBits.length > 0 ? `<h4>Diagnostics</h4><ul class="diag-list">${diagBits.join("")}</ul>` : "";

  const failing = detail.failingAudits.length > 0
    ? `<h4>Other failing audits (${detail.failingAudits.length})</h4>
       <ul class="audit-list">${detail.failingAudits
         .map((a) => `<li>
           <strong>${escapeHtml(a.title)}</strong>${a.displayValue ? ` <span class="audit-val">${escapeHtml(a.displayValue)}</span>` : ""}
           ${a.description ? `<div class="audit-desc">${escapeHtml(stripMd(a.description))}</div>` : ""}
         </li>`)
         .join("")}</ul>`
    : "";

  return `${metricsTable}${opps}${diag}${failing}`;
}

function axeNodeBlock(n: AxeNode): string {
  const contrast = n.checks.find((c) => c.id === "color-contrast");
  let contrastInfo = "";
  if (contrast && contrast.data && typeof contrast.data === "object") {
    const dat = contrast.data as Record<string, unknown>;
    const fg = typeof dat.fgColor === "string" ? dat.fgColor : null;
    const bg = typeof dat.bgColor === "string" ? dat.bgColor : null;
    const ratio = typeof dat.contrastRatio === "number" ? dat.contrastRatio : null;
    const expected = dat.expectedContrastRatio != null ? String(dat.expectedContrastRatio) : null;
    const parts: string[] = [];
    if (ratio != null) parts.push(`ratio ${ratio}:1`);
    if (expected) parts.push(`needs ${expected}`);
    if (fg) parts.push(`fg ${fg}`);
    if (bg) parts.push(`bg ${bg}`);
    if (parts.length > 0) {
      const swatches = `${fg ? `<span class="swatch" style="background:${escapeHtml(fg)}"></span>` : ""}${bg ? `<span class="swatch" style="background:${escapeHtml(bg)}"></span>` : ""}`;
      contrastInfo = `<div class="axe-contrast">${escapeHtml(parts.join(" · "))} ${swatches}</div>`;
    }
  }
  return `<li class="axe-node">
    <code class="axe-target">${escapeHtml(n.target)}</code>
    ${n.failureSummary ? `<div class="axe-fix">${escapeHtml(n.failureSummary)}</div>` : ""}
    ${contrastInfo}
    <pre class="axe-html">${escapeHtml(n.html)}</pre>
  </li>`;
}

function externalChip(): string {
  return `<span class="chip chip-ext" title="Off-origin (third-party) page reached via redirect — excluded from averages; issues here are not yours to fix">
    <span class="chip-label">third-party</span>
  </span>`;
}

// ── Passive recon rendering ────────────────────────────────────────────────

const RECON_TIER: Record<"ok" | "warn" | "bad", "good" | "ok" | "bad"> = { ok: "good", warn: "ok", bad: "bad" };

function severityTier(sev: VulnFinding["severity"]): "good" | "ok" | "bad" | "neutral" {
  if (sev === "critical" || sev === "high") return "bad";
  if (sev === "medium") return "ok";
  if (sev === "low") return "neutral";
  return "neutral";
}

function techChip(tech: TechResult | null): string {
  if (!tech || tech.technologies.length === 0) return "";
  return `<span class="chip chip-neutral" title="Technologies detected on this page">
    <span class="chip-label">Tech</span>
    <span class="chip-value">${tech.technologies.length}</span>
  </span>`;
}

function techSection(tech: TechResult | null): string {
  if (!tech || tech.technologies.length === 0) return "";
  const rows = tech.technologies
    .map(
      (t) =>
        `<li><span class="tech-name">${escapeHtml(t.name)}</span>${t.version ? ` <span class="tech-ver">${escapeHtml(t.version)}</span>` : ""}<span class="tech-cats">${escapeHtml(t.categories.join(" · "))}</span></li>`,
    )
    .join("");
  return `<details class="details"><summary>Technologies (${tech.technologies.length})</summary>
      <ul class="tech-list">${rows}</ul>
    </details>`;
}

function reconCell(label: string, value: string | null | undefined): string {
  return `<div class="intel-cell"><span class="intel-key">${escapeHtml(label)}</span><span class="intel-val">${value ? escapeHtml(value) : "—"}</span></div>`;
}

function emailFindingChip(f: EmailFinding): string {
  const tier = RECON_TIER[f.severity];
  return `<span class="chip chip-${tier}" title="${escapeHtml(f.note ?? f.name)}">
    <span class="chip-label">${escapeHtml(f.name)}</span>
    <span class="chip-value">${f.present ? "✓" : "✗"}</span>
  </span>`;
}

function tlsFindingChip(f: TlsFinding): string {
  const tier = RECON_TIER[f.severity];
  return `<span class="chip chip-${tier}" title="${escapeHtml(f.detail)}"><span class="chip-label">${escapeHtml(f.name)}</span></span>`;
}

function siteIntelCard(intel: SiteIntel): string {
  const d = intel.domain;
  const dns = intel.dns;
  const geo = intel.geo;
  const tls = intel.tls;
  const email = intel.email;

  const age = d.ageYears != null ? `${d.ageYears} yr${d.ageYears === 1 ? "" : "s"}` : null;
  const created = d.createdAt ? d.createdAt.slice(0, 10) : null;
  const expires = d.expiresAt ? d.expiresAt.slice(0, 10) : null;
  const flag = geo?.countryCode
    ? geo.countryCode.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)))
    : "";

  const domainGrid = `<div class="intel-grid">
    ${reconCell("domain", d.domain)}
    ${reconCell("registrar", d.registrar)}
    ${reconCell("registered", created ? `${created}${age ? ` (${age} ago)` : ""}` : null)}
    ${reconCell("expires", expires)}
    ${reconCell("registrant", d.registrantOrg)}
    ${reconCell("nameservers", dns.dnsHost || (dns.ns[0] ?? null))}
  </div>`;

  const hostGrid = `<div class="intel-grid">
    ${reconCell("server IP", dns.a[0] ?? null)}
    ${reconCell("country", geo ? `${flag ? flag + " " : ""}${geo.country ?? geo.countryCode ?? "—"}${geo.city ? ` · ${geo.city}` : ""}` : null)}
    ${reconCell("hosting", geo?.isp || geo?.org)}
    ${reconCell("ASN", geo?.asn)}
    ${reconCell("mail provider", dns.mailProvider)}
    ${reconCell("reverse DNS", geo?.reverse)}
  </div>`;

  const tlsBlock = tls
    ? `<div class="intel-block">
        <div class="intel-block-head"><h3>TLS / certificate</h3>${gradePill(tls.grade)}</div>
        <div class="intel-grid">
          ${reconCell("protocol", tls.protocol)}
          ${reconCell("issuer", tls.issuer)}
          ${reconCell("expires", tls.daysToExpiry != null ? `${tls.daysToExpiry} day(s)` : null)}
          ${reconCell("SAN names", tls.san.length ? String(tls.san.length) : null)}
        </div>
        <div class="chips intel-chips">${tls.findings.map(tlsFindingChip).join("")}</div>
        ${tls.note ? `<p class="intel-note">${escapeHtml(tls.note)}</p>` : ""}
      </div>`
    : "";

  const emailBlock = `<div class="intel-block">
      <div class="intel-block-head"><h3>Email security</h3>${gradePill(email.grade)}${email.spoofable ? `<span class="intel-warn-tag">spoofable</span>` : ""}</div>
      <div class="chips intel-chips">${[email.spf, email.dmarc, email.dkim].map(emailFindingChip).join("")}</div>
      <ul class="intel-notes">${[email.spf, email.dmarc, email.dkim]
        .filter((f) => f.note)
        .map((f) => `<li class="intel-note-${RECON_TIER[f.severity]}">${escapeHtml(f.name)}: ${escapeHtml(f.note!)}</li>`)
        .join("")}</ul>
    </div>`;

  const techRollup = intel.technologies.length > 0
    ? `<div class="intel-block">
        <h3>Technology stack (${intel.technologies.length})</h3>
        <div class="chips intel-chips">${intel.technologies
          .map((t) => `<span class="chip chip-neutral" title="${escapeHtml(t.categories.join(", "))}"><span class="chip-label">${escapeHtml(t.name)}</span>${t.version ? `<span class="chip-value">${escapeHtml(t.version)}</span>` : ""}</span>`)
          .join("")}</div>
      </div>`
    : "";

  const offpage = offpageSection(intel);

  return `<section class="intel">
    <h2>Site intelligence <span class="intel-sub">passive recon — public records &amp; what the site exposes</span></h2>
    <div class="intel-cols">
      <div class="intel-block"><h3>Domain &amp; ownership</h3>${domainGrid}${d.source === "unavailable" ? `<p class="intel-note">${escapeHtml(d.note ?? "WHOIS/RDAP unavailable")}</p>` : ""}</div>
      <div class="intel-block"><h3>Hosting</h3>${hostGrid}</div>
    </div>
    <div class="intel-cols">${tlsBlock}${emailBlock}</div>
    ${techRollup}
    ${offpage}
  </section>`;
}

// Off-page / ranking signals (free external APIs). Each block is omitted when its
// signal is null (no key / not in dataset), so the section appears only with data.
function cwvTier(rating: "good" | "ni" | "poor" | null): "good" | "ok" | "bad" | "muted" {
  return rating === "good" ? "good" : rating === "ni" ? "ok" : rating === "poor" ? "bad" : "muted";
}

function fmtCwvMs(v: number | null): string {
  if (v == null) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

function offpageSection(intel: SiteIntel): string {
  const authority = intel.authority;
  const cwv = intel.fieldCwv;
  const rankings = intel.rankings;
  const sc = intel.searchConsole;
  if (!authority && !cwv && (!rankings || rankings.length === 0) && !sc) return "";

  const drTier = (dr: number | null) => (dr == null ? "ok" : dr >= 5 ? "good" : dr >= 2.5 ? "ok" : "bad");
  const authorityBlock = authority
    ? `<div class="intel-block">
        <div class="intel-block-head"><h3>Domain authority</h3><span class="grade-pill grade-${drTier(authority.domainRating)}">${authority.domainRating != null ? authority.domainRating.toFixed(1) : "—"}</span></div>
        <div class="intel-grid">
          ${reconCell("page rank (0–10)", authority.domainRating != null ? authority.domainRating.toFixed(2) : null)}
          ${reconCell("global rank", authority.rank != null ? `#${authority.rank.toLocaleString()}` : null)}
          ${reconCell("source", "OpenPageRank")}
        </div>
        <p class="intel-note">Backlink-derived authority. Low here alongside healthy on-page scores points the SEO problem off-page (links / content), not at the build.</p>
      </div>`
    : "";

  const cwvCell = (label: string, m: { p75: number | null; rating: "good" | "ni" | "poor" | null }, fmt: (v: number) => string) =>
    `<div class="intel-cell"><span class="intel-key">${escapeHtml(label)}</span><span class="intel-val intel-cwv-${cwvTier(m.rating)}">${m.p75 != null ? escapeHtml(fmt(m.p75)) : "—"}</span></div>`;
  const cwvBlock = cwv
    ? `<div class="intel-block">
        <div class="intel-block-head"><h3>Field Core Web Vitals</h3><span class="grade-pill grade-${cwvTier(cwv.overall)}">${cwv.overall ? cwv.overall.toUpperCase() : "—"}</span></div>
        <div class="intel-grid">
          ${cwvCell("LCP (p75)", cwv.lcp, fmtCwvMs)}
          ${cwvCell("INP (p75)", cwv.inp, fmtCwvMs)}
          ${cwvCell("CLS (p75)", cwv.cls, (v) => v.toFixed(2))}
        </div>
        <p class="intel-note">Real Chrome-user data (CrUX) — the field metrics Google actually ranks on, distinct from the per-page lab Lighthouse scores below.</p>
      </div>`
    : "";

  const rankTier = (r: { position: number | null; found: boolean }) =>
    !r.found || r.position == null ? "bad" : r.position <= 10 ? "good" : r.position <= 20 ? "ok" : "bad";
  const hasVolume = !!rankings?.some((r) => r.volume != null);
  const rankBlock = rankings && rankings.length > 0
    ? `<div class="intel-block">
        <h3>Search rankings <span class="intel-sub">Brave Search position${hasVolume ? " · Keywords Everywhere demand" : ""}</span></h3>
        ${hasVolume
          ? `<table class="links-table intel-sc-table"><thead><tr><th>Keyword</th><th>Position</th><th>Volume/mo</th><th>CPC</th><th>Competition</th></tr></thead><tbody>${rankings
              .map(
                (r) =>
                  `<tr><td>${escapeHtml(r.keyword)}</td><td class="intel-cwv-${rankTier(r)}">${r.found && r.position != null ? `#${r.position}` : "not in top 20"}</td><td>${r.volume != null ? r.volume.toLocaleString() : "—"}</td><td>${r.cpc != null ? `$${r.cpc.toFixed(2)}` : "—"}</td><td>${r.competition != null ? `${Math.round(r.competition * 100)}%` : "—"}</td></tr>`,
              )
              .join("")}</tbody></table>`
          : `<div class="intel-grid">
              ${rankings
                .map((r) => `<div class="intel-cell"><span class="intel-key">${escapeHtml(r.keyword)}</span><span class="intel-val intel-cwv-${rankTier(r)}">${r.found && r.position != null ? `#${r.position}` : "not in top 20"}</span></div>`)
                .join("")}
            </div>`}
        <p class="intel-note">Where this domain sits in Brave's organic results for each keyword${hasVolume ? ", alongside average monthly search volume, CPC and ad competition from Keywords Everywhere" : ""}. Brave is an independent index, so read position as directional rather than exact Google position.</p>
      </div>`
    : "";

  const scBlock = sc
    ? `<div class="intel-block">
        <h3>Search Console <span class="intel-sub">owner data · last ${sc.rangeDays} days</span></h3>
        <div class="intel-grid">
          ${reconCell("clicks", sc.clicks.toLocaleString())}
          ${reconCell("impressions", sc.impressions.toLocaleString())}
          ${reconCell("avg position", sc.position ? sc.position.toFixed(1) : null)}
          ${reconCell("CTR", `${(sc.ctr * 100).toFixed(1)}%`)}
        </div>
        ${sc.topQueries.length > 0
          ? `<table class="links-table intel-sc-table"><thead><tr><th>Query</th><th>Clicks</th><th>Impr.</th><th>Pos.</th></tr></thead><tbody>${sc.topQueries
              .map((q) => `<tr><td>${escapeHtml(q.query)}</td><td>${q.clicks}</td><td>${q.impressions}</td><td>${q.position.toFixed(1)}</td></tr>`)
              .join("")}</tbody></table>`
          : ""}
      </div>`
    : "";

  return `<h2 class="intel-offpage-head">Off-page &amp; ranking <span class="intel-sub">authority, field performance &amp; SERP position — the half a crawler can't see</span></h2>
    <div class="intel-cols">${authorityBlock}${cwvBlock}</div>
    <div class="intel-cols">${rankBlock}${scBlock}</div>`;
}

function gradePill(grade: string): string {
  const tier = grade === "A" ? "good" : grade === "B" || grade === "C" ? "ok" : "bad";
  return `<span class="grade-pill grade-${tier}">${escapeHtml(grade)}</span>`;
}

function vulnPanel(intel: SiteIntel | null): string {
  if (!intel || intel.vulnerabilities.length === 0) return "";
  const v = intel.vulnerabilities;
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } as Record<VulnFinding["severity"], number>;
  for (const f of v) counts[f.severity]++;
  const summary = (["critical", "high", "medium", "low", "unknown"] as const)
    .filter((s) => counts[s] > 0)
    .map((s) => `<span class="vuln-count vuln-${severityTier(s)}">${counts[s]} ${s}</span>`)
    .join("");

  const rows = v
    .map((f) => {
      const ids = f.ids
        .map((id) => (/^CVE-/.test(id) ? `<a href="https://nvd.nist.gov/vuln/detail/${escapeHtml(id)}" target="_blank" rel="noopener">${escapeHtml(id)}</a>` : /^GHSA-/.test(id) ? `<a href="https://github.com/advisories/${escapeHtml(id)}" target="_blank" rel="noopener">${escapeHtml(id)}</a>` : escapeHtml(id)))
        .join(", ");
      return `<tr class="vuln-row vuln-${severityTier(f.severity)}">
        <td><span class="vuln-sev">${escapeHtml(f.severity)}</span></td>
        <td>${escapeHtml(f.component)}${f.version ? ` <span class="vuln-ver">${escapeHtml(f.version)}</span>` : ""}</td>
        <td>${ids}</td>
        <td>${escapeHtml(f.summary)}</td>
        <td><span class="vuln-src" title="${f.confidence === "confirmed" ? "version matched against vulnerable range" : "keyword match — verify before reporting"}">${escapeHtml(f.source)} · ${escapeHtml(f.confidence)}</span></td>
      </tr>`;
    })
    .join("");

  return `<section class="issues vuln-panel">
    <h2>Known vulnerabilities <span class="vuln-summary">${summary}</span></h2>
    <p class="intel-note">Detected from publicly exposed version labels and correlated against public databases (RetireJS, NVD). "potential" findings are keyword matches — verify before acting.</p>
    <table class="links-table vuln-table">
      <thead><tr><th>Severity</th><th>Component</th><th>Identifiers</th><th>Summary</th><th>Source</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function pageCard(rec: PageResult): string {
  const title = rec.title.trim() || rec.slug;
  const lhHref = `lighthouse/${encodeURIComponent(rec.slug)}.html`;
  const axeHref = `a11y/${encodeURIComponent(rec.slug)}.json`;

  const chips: string[] = [];
  chips.push(statusChip(rec.status));
  if (rec.lighthouse) {
    const sc = rec.lighthouse.scores;
    chips.push(scoreChip(SCORE_LABELS.performance, sc.performance, lhHref));
    chips.push(scoreChip(SCORE_LABELS.accessibility, sc.accessibility, lhHref));
    chips.push(scoreChip(SCORE_LABELS.bestPractices, sc.bestPractices, lhHref));
    chips.push(scoreChip(SCORE_LABELS.seo, sc.seo, lhHref));
  }
  if (rec.axe) chips.push(axeChip(rec.axe, axeHref));
  if (rec.security) chips.push(secChip(rec.security));
  chips.push(techChip(rec.tech));
  chips.push(consoleChip(rec.console));
  if (rec.external) chips.unshift(externalChip());

  let perfSection = "";
  if (rec.lighthouse) {
    const lh = rec.lighthouse;
    const lcp = metricValueById(lh, "largest-contentful-paint");
    perfSection = `<details class="details"><summary>Performance detail${lcp ? ` — LCP ${escapeHtml(lcp)}` : ""}</summary>
        ${performanceSection(lh)}
        <p class="more"><a href="${lhHref}">full Lighthouse report ↗</a></p>
      </details>`;
  }

  const thumbs = COLOR_SCHEMES.flatMap((scheme) =>
    VIEWPORTS.map((vp) => {
      const rel = `${scheme}/${vp.name}/${encodeURIComponent(rec.slug)}.png`;
      const cap = `${scheme} · ${vp.name} · ${vp.width}×${vp.height}`;
      const thumb = `<a class="thumb" href="${rel}" target="_blank" rel="noopener">
        <img src="${rel}" alt="${escapeHtml(cap)}" loading="lazy" />
        <span class="thumb-cap">${escapeHtml(cap)}</span>
      </a>`;

      const screenCount = rec.screenCounts?.[`${scheme}/${vp.name}`] ?? 0;
      if (screenCount <= 1) return thumb;

      const screens = Array.from({ length: screenCount }, (_, i) => {
        const n = i + 1;
        const screenRel = `${scheme}/${vp.name}/${encodeURIComponent(rec.slug)}@screen-${n}.png`;
        const screenCap = `${cap} · screen ${n}/${screenCount}`;
        return `<a class="thumb thumb-screen" href="${screenRel}" target="_blank" rel="noopener">
          <img src="${screenRel}" alt="${escapeHtml(screenCap)}" loading="lazy" />
          <span class="thumb-cap">screen ${n}/${screenCount}</span>
        </a>`;
      }).join("\n");

      return `${thumb}
      <details class="details thumb-screens">
        <summary>Screens (${screenCount})</summary>
        <div class="grid thumb-filmstrip">${screens}</div>
      </details>`;
    }),
  ).join("\n");

  const consoleSection = rec.console.length > 0
    ? `<details class="details"><summary>Console (${rec.console.length})</summary>
        <ul class="console-list">
          ${rec.console
            .map(
              (e) =>
                `<li class="console-${e.type}"><span class="console-type">${e.type}</span> ${escapeHtml(e.text)}${e.location ? ` <span class="console-loc">${escapeHtml(e.location)}</span>` : ""}${e.stack ? `<pre class="console-stack">${escapeHtml(e.stack)}</pre>` : ""}</li>`,
            )
            .join("")}
        </ul>
      </details>`
    : "";

  const axeSection = rec.axe && rec.axe.violationCount > 0
    ? `<details class="details"><summary>Accessibility (${rec.axe.violationCount} violations, ${rec.axe.nodeCount} nodes)</summary>
        <ul class="axe-list">
          ${rec.axe.violations
            .map(
              (v) =>
                `<li class="axe-${v.impact ?? "minor"}">
                  <div class="axe-head">
                    <span class="axe-impact">${v.impact ?? "minor"}</span>
                    <a href="${escapeHtml(v.helpUrl)}" target="_blank" rel="noopener"><strong>${escapeHtml(v.id)}</strong></a> —
                    ${escapeHtml(v.help)} (${v.nodeCount} node${v.nodeCount === 1 ? "" : "s"})
                    ${v.wcag.length > 0 ? `<span class="axe-wcag">${v.wcag.map(escapeHtml).join(", ")}</span>` : ""}
                  </div>
                  <ul class="axe-nodes">${v.nodes.map(axeNodeBlock).join("")}</ul>
                  ${v.nodesTruncated ? `<p class="more">…${v.nodeCount - v.nodes.length} more node${v.nodeCount - v.nodes.length === 1 ? "" : "s"} in <a href="${escapeHtml(axeHref)}">a11y/${escapeHtml(rec.slug)}.json</a></p>` : ""}
                </li>`,
            )
            .join("")}
        </ul>
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

  return `<section class="card${rec.external ? " card-external" : ""}" id="page-${escapeHtml(rec.slug)}">
    <header>
      <h2>${escapeHtml(title)}</h2>
      <a class="url" href="${escapeHtml(rec.url)}" target="_blank" rel="noopener">${escapeHtml(rec.url)}</a>
    </header>
    ${rec.external ? `<p class="ext-banner">Third-party page (off-origin, reached via redirect). Excluded from site averages — issues below belong to the external host, not this site.</p>` : ""}
    <div class="chips">${chips.join("")}</div>
    ${perfSection}
    ${rec.seo ? seoRow(rec.seo) : ""}
    ${techSection(rec.tech)}
    ${axeSection}
    ${securitySection}
    ${consoleSection}
    <div class="grid">${thumbs}</div>
  </section>`;
}

function extTag(p: PageResult): string {
  return p.external ? ` <span class="ext-tag">third-party</span>` : "";
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
    .map((l) => {
      const from = l.fromSlugs.length > 0
        ? l.fromSlugs.map((s) => `<a href="#page-${escapeHtml(s)}">${escapeHtml(s)}</a>`).join(", ")
        : escapeHtml(l.fromSlug);
      const finalUrl = l.finalUrl && l.finalUrl !== l.url ? escapeHtml(l.finalUrl) : "—";
      return `<tr>
          <td>${from}</td>
          <td>${l.text ? escapeHtml(l.text) : "—"}</td>
          <td><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.url)}</a></td>
          <td>${l.status ?? "—"}</td>
          <td>${finalUrl}</td>
          <td>${escapeHtml(l.error ?? "")}</td>
        </tr>`;
    })
    .join("");

  return `<section class="issues">
    <h2>Issues</h2>
    ${
      slugsWithBadStatus.length > 0
        ? `<h3>Bad HTTP status (${slugsWithBadStatus.length})</h3>
           <ul>${slugsWithBadStatus.map((p) => `<li><a href="#page-${escapeHtml(p.slug)}">${escapeHtml(p.slug)}</a> — ${p.status}${extTag(p)}</li>`).join("")}</ul>`
        : ""
    }
    ${
      slugsWithAxe.length > 0
        ? `<h3>Critical / serious a11y (${slugsWithAxe.length} page${slugsWithAxe.length === 1 ? "" : "s"})</h3>
           <ul>${slugsWithAxe.map((p) => `<li><a href="#page-${escapeHtml(p.slug)}">${escapeHtml(p.slug)}</a> — ${p.axe!.byImpact.critical} critical, ${p.axe!.byImpact.serious} serious${extTag(p)}</li>`).join("")}</ul>`
        : ""
    }
    ${
      slugsWithConsole.length > 0
        ? `<h3>JS / console errors (${slugsWithConsole.length} page${slugsWithConsole.length === 1 ? "" : "s"})</h3>
           <ul>${slugsWithConsole.map((p) => `<li><a href="#page-${escapeHtml(p.slug)}">${escapeHtml(p.slug)}</a> — ${p.console.filter((c) => c.type === "error" || c.type === "pageerror").length} error${p.console.length === 1 ? "" : "s"}${extTag(p)}</li>`).join("")}</ul>`
        : ""
    }
    ${
      broken.length > 0
        ? `<h3>Broken links (${broken.length})</h3>
           <table class="links-table">
             <thead><tr><th>From</th><th>Anchor</th><th>URL</th><th>Status</th><th>Final</th><th>Error</th></tr></thead>
             <tbody>${linkRows}</tbody>
           </table>`
        : ""
    }
  </section>`;
}

function summaryBar(results: Results): string {
  const s = results.summary;
  const lh = s.lighthouseAverages;
  const intel = results.intel;
  return `<div class="summary">
    <span class="sum-cell"><span class="sum-key">pages</span><span class="sum-val">${s.pages}</span></span>
    ${s.externalPages > 0 ? `<span class="sum-cell"><span class="sum-key">third-party</span><span class="sum-val">${s.externalPages}</span></span>` : ""}
    ${intel?.domain.ageYears != null ? `<span class="sum-cell"><span class="sum-key">domain age</span><span class="sum-val">${intel.domain.ageYears}y</span></span>` : ""}
    ${intel?.authority?.domainRating != null ? `<span class="sum-cell"><span class="sum-key">authority</span><span class="sum-val">${intel.authority.domainRating.toFixed(1)}/10</span></span>` : ""}
    ${intel?.fieldCwv?.overall ? `<span class="sum-cell"><span class="sum-key">field CWV</span><span class="sum-val">${intel.fieldCwv.overall.toUpperCase()}</span></span>` : ""}
    ${intel?.tls ? `<span class="sum-cell"><span class="sum-key">TLS</span><span class="sum-val">${intel.tls.grade}</span></span>` : ""}
    ${intel ? `<span class="sum-cell"><span class="sum-key">email</span><span class="sum-val">${intel.email.grade}${intel.email.spoofable ? " ⚠" : ""}</span></span>` : ""}
    ${intel ? `<span class="sum-cell"><span class="sum-key">tech</span><span class="sum-val">${intel.technologies.length}</span></span>` : ""}
    ${intel && intel.vulnerabilities.length > 0 ? `<span class="sum-cell"><span class="sum-key">vulnerabilities</span><span class="sum-val">${intel.vulnerabilities.length}</span></span>` : ""}
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
  .thumb-screens { grid-column: 1 / -1; margin-top: -4px; }
  .thumb-screens summary { cursor: pointer; font-size: 12px; color: #9ba2ad; }
  .thumb-filmstrip { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); margin-top: 10px; }
  .thumb-screen img { aspect-ratio: auto; object-fit: contain; }
  .more { color: #6b7280; font-size: 11px; margin: 6px 0 0; }
  .details h4 { font-size: 12px; font-weight: 600; color: #c5cad3; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: 0.04em; }
  .chip-ext { color: #c084fc; border-color: rgba(192, 132, 252, 0.35); background: rgba(192, 132, 252, 0.10); }
  .card-external { border-color: rgba(192, 132, 252, 0.35); }
  .ext-banner { margin: 0 0 12px; padding: 8px 12px; font-size: 12px; color: #c084fc; background: rgba(192, 132, 252, 0.08); border: 1px solid rgba(192, 132, 252, 0.25); border-radius: 8px; }
  .ext-tag { display: inline-block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #c084fc; border: 1px solid rgba(192, 132, 252, 0.3); border-radius: 999px; padding: 1px 6px; margin-left: 6px; }
  .metrics-table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 4px 0 4px; }
  .metrics-table th, .metrics-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #23262d; }
  .metrics-table th { color: #6b7280; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; }
  .metrics-table .metric-name { color: #c5cad3; }
  .metrics-table .metric-val, .metrics-table .metric-raw { font-variant-numeric: tabular-nums; text-align: right; }
  .metric-good .metric-val, .metric-good .metric-raw { color: #10b981; }
  .metric-ok .metric-val, .metric-ok .metric-raw { color: #f59e0b; }
  .metric-bad .metric-val, .metric-bad .metric-raw { color: #ef4444; }
  .opp-list, .diag-list, .audit-list { list-style: none; padding: 0; margin: 4px 0 0; font-size: 12px; color: #c5cad3; }
  .opp { padding: 6px 0; border-bottom: 1px solid #1d2027; }
  .opp-head strong { font-weight: 600; }
  .opp-save { color: #f59e0b; font-variant-numeric: tabular-nums; margin-left: 6px; }
  .opp-items { list-style: none; padding: 4px 0 0 12px; margin: 0; }
  .opp-items li { margin: 2px 0; }
  .opp-res { color: #9ba2ad; word-break: break-all; }
  .opp-meta { color: #6b7280; font-variant-numeric: tabular-nums; }
  .diag-list li { margin: 3px 0; }
  .diag-key { color: #6b7280; text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; margin-right: 6px; }
  .diag-list code { color: #93c5fd; word-break: break-all; }
  .diag-more { color: #6b7280; }
  .audit-list li { margin: 6px 0; }
  .audit-val { color: #f59e0b; font-variant-numeric: tabular-nums; margin-left: 4px; }
  .audit-desc { color: #9ba2ad; font-size: 11px; margin-top: 2px; }
  .axe-head { margin-bottom: 6px; }
  .axe-nodes { list-style: none; padding: 0 0 0 8px; margin: 0 0 6px; border-left: 2px solid #23262d; }
  .axe-node { margin: 8px 0; }
  .axe-target { display: block; color: #93c5fd; font-size: 11px; word-break: break-all; }
  .axe-fix { color: #c5cad3; font-size: 11px; margin: 2px 0; white-space: pre-wrap; }
  .axe-contrast { font-size: 11px; color: #f59e0b; font-variant-numeric: tabular-nums; }
  .axe-html { background: #0e0f12; border: 1px solid #23262d; border-radius: 6px; padding: 6px 8px; margin: 4px 0 0; font-size: 11px; color: #c5cad3; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .swatch { display: inline-block; width: 11px; height: 11px; border-radius: 2px; border: 1px solid rgba(255,255,255,0.2); vertical-align: middle; margin-left: 2px; }
  .console-stack { background: #0e0f12; border: 1px solid #23262d; border-radius: 6px; padding: 6px 8px; margin: 4px 0 0; font-size: 11px; color: #9ba2ad; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  footer { color: #6b7280; font-size: 12px; margin-top: 32px; text-align: center; }
  .chip-neutral { color: #93c5fd; border-color: rgba(147, 197, 253, 0.3); background: rgba(147, 197, 253, 0.08); }
  .intel { background: #16181d; border: 1px solid #23262d; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
  .intel h2 { margin: 0 0 14px; }
  .intel-sub { color: #6b7280; font-size: 12px; font-weight: 400; text-transform: none; letter-spacing: 0; margin-left: 8px; }
  .intel-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 4px; }
  .intel-block { background: #11131a; border: 1px solid #23262d; border-radius: 8px; padding: 14px; margin-bottom: 16px; }
  .intel-block h3 { margin: 0 0 10px; }
  .intel-block-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .intel-block-head h3 { margin: 0; }
  .intel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px 16px; }
  .intel-cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .intel-key { color: #6b7280; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
  .intel-val { color: #e7e9ee; font-size: 13px; font-variant-numeric: tabular-nums; word-break: break-word; overflow-wrap: anywhere; }
  .intel-chips { margin: 10px 0 0; }
  .intel-note { color: #9ba2ad; font-size: 11px; margin: 8px 0 0; }
  .intel-notes { list-style: none; padding: 0; margin: 8px 0 0; font-size: 11px; }
  .intel-notes li { margin: 3px 0; }
  .intel-note-good { color: #10b981; }
  .intel-note-ok { color: #f59e0b; }
  .intel-note-bad { color: #ef4444; }
  .intel-offpage-head { margin: 18px 0 12px; font-size: 16px; }
  .intel-cwv-good { color: #10b981; }
  .intel-cwv-ok { color: #f59e0b; }
  .intel-cwv-bad { color: #ef4444; }
  .intel-cwv-muted { color: #6b7280; }
  .intel-sc-table { margin-top: 12px; }
  .grade-pill { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 6px; font-size: 13px; font-weight: 700; }
  .grade-good { color: #10b981; background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.35); }
  .grade-ok { color: #f59e0b; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); }
  .grade-bad { color: #ef4444; background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35); }
  .intel-warn-tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.35); border-radius: 999px; padding: 2px 8px; }
  .tech-list { list-style: none; padding: 0 !important; display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 4px 16px; }
  .tech-list li { display: flex; gap: 8px; align-items: baseline; font-size: 12px; }
  .tech-name { color: #e7e9ee; font-weight: 600; }
  .tech-ver { color: #93c5fd; font-variant-numeric: tabular-nums; }
  .tech-cats { color: #6b7280; font-size: 11px; margin-left: auto; text-align: right; }
  .vuln-panel { border-color: rgba(239, 68, 68, 0.3); }
  .vuln-summary { font-weight: 400; font-size: 12px; margin-left: 8px; }
  .vuln-count { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; margin-left: 6px; }
  .vuln-count.vuln-bad { color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.35); }
  .vuln-count.vuln-ok { color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.35); }
  .vuln-count.vuln-neutral { color: #9ba2ad; border: 1px solid rgba(255, 255, 255, 0.15); }
  .vuln-table td { vertical-align: top; }
  .vuln-sev { display: inline-block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 4px; }
  .vuln-bad .vuln-sev { background: rgba(239, 68, 68, 0.18); color: #ef4444; }
  .vuln-ok .vuln-sev { background: rgba(245, 158, 11, 0.16); color: #f59e0b; }
  .vuln-neutral .vuln-sev { background: rgba(255, 255, 255, 0.06); color: #9ba2ad; }
  .vuln-ver { color: #93c5fd; font-variant-numeric: tabular-nums; }
  .vuln-src { color: #6b7280; font-size: 11px; }
`;

export function writeIndexReport(outDir: string, results: Results): void {
  const captures = results.pages.length * COLOR_SCHEMES.length * VIEWPORTS.length;
  const cards = results.pages.map(pageCard).join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>trawl — ${escapeHtml(results.site.label)} — ${escapeHtml(results.runStamp)}</title>
  <style>${CSS}</style>
</head>
<body>
  <h1>trawl — ${escapeHtml(results.site.label)}</h1>
  <div class="meta">${escapeHtml(results.runStamp)} · ${results.pages.length} page${results.pages.length === 1 ? "" : "s"} · ${captures} capture${captures === 1 ? "" : "s"} · ${(results.durationMs / 1000).toFixed(1)}s</div>
  <div class="legend">
    <span><span class="dot dot-good"></span>≥ 90</span>
    <span><span class="dot dot-ok"></span>50–89</span>
    <span><span class="dot dot-bad"></span>&lt; 50</span>
    <span>· click chips for full reports · averages exclude third-party pages · machine data in <code>results.json</code></span>
  </div>
  ${summaryBar(results)}
  ${results.intel ? siteIntelCard(results.intel) : ""}
  ${vulnPanel(results.intel)}
  ${issuesPanel(results)}
  ${cards}
  <footer>generated by trawl · schema v${results.schemaVersion}</footer>
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, "index.html"), html);
}

// Re-export the legacy type alias so older imports don't break.
export type { Scores };

// LinkCheck re-export for downstream consumers
export type { LinkCheck };
