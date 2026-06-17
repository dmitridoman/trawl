# Trawl

One command. Crawls every internal page of a site, screenshots each at mobile/tablet/desktop in light + dark, runs Lighthouse + full axe-core a11y + SEO meta + security header + broken-link audits, gathers **passive intelligence** about the site (WHOIS/RDAP, DNS, hosting/geo, technology stack, TLS, email-spoofing posture, and known-vulnerability correlation), and ships the lot as a folder + zip with a single dashboard `index.html`. Pass multiple URLs (or a `.txt` file) and you get a side-by-side comparison.

The dashboard is **self-contained and deep by default**: millisecond Lighthouse metrics, perf opportunities with the offending resources, the actual LCP element, every axe node (selector + fix + contrast values), and full console stack traces are embedded directly in `index.html` — no need to open the side files. That makes the report enough, on its own, for a human or an agent to act on. Third-party pages reached via an off-origin redirect (e.g. an external booking host) are labelled and excluded from your averages.

## Usage

No install — run straight from npm:

```bash
# single site
npx trawl http://localhost:3000
npx trawl https://example.com
npx trawl https://example.com --max-pages 50 --concurrency 6
npx trawl https://staging.example.com --auth-storage ./auth.json

# multi-site comparison
npx trawl https://stripe.com https://plaid.com https://truelayer.com
npx trawl ./prospects.txt --max-pages 30
```

Or from GitHub without publishing:

```bash
pnpm dlx github:dmitridoman/crawlshot https://example.com
```

Or install globally:

```bash
npm i -g trawl
trawl https://example.com
```

## Output

Drops into `~/Downloads/`:

```
trawl-<site>-<timestamp>/
  index.html              dashboard — chips, issues panel, thumbnails
  results.json            machine-readable union of everything
  light/
    phone/                375px screenshots, one PNG per page
    tablet/               768px screenshots
    desktop/              1440px screenshots
  dark/
    phone/                …
    tablet/               …
    desktop/              …
  lighthouse/
    home.html             per-page Lighthouse HTML reports
    about.html
  a11y/
    home.json             per-page axe-core violations + WCAG SCs
    about.json
trawl-<site>-<timestamp>.zip
```

Nested routes use `__` so the folder names stay flat and readable. Open `index.html` to skim every page at every viewport at light/dark with score chips and an issues panel inline.

## Viewports

| name    | width × height |
| ------- | -------------- |
| phone   | 375 × 812      |
| tablet  | 768 × 1024     |
| desktop | 1440 × 900     |

Full-page screenshots at light + dark colour schemes. Fonts are awaited via `document.fonts.ready` and animations are frozen before capture, so output is stable run-to-run.

## What it audits

Each page gets:

- **Lighthouse** — Performance, Accessibility, Best Practices, SEO scores, **plus** the millisecond metrics (LCP, FCP, TBT, CLS, Speed Index, TTI, TTFB), perf **opportunities** with estimated ms/byte savings and the specific offending resources, **diagnostics** (the actual LCP element, layout-shift elements, third-party breakdown, main-thread work), and every other failing audit with Lighthouse's own remediation text — all embedded inline. Full per-page HTML report is still linked.
- **axe-core a11y scan** — every WCAG 2.0/2.1 A & AA + best-practice rule. Each violation lists **every** affected node inline: CSS-selector target, the `failureSummary` fix, the HTML snippet, and structured check data (e.g. color-contrast fg/bg colours + actual vs required ratio). The complete raw dump stays in `a11y/<slug>.json`.
- **SEO meta inventory** — title length, meta description, canonical, Open Graph, Twitter Card, `<h1>` count, alt-text coverage, JSON-LD types, lang, robots, viewport. Issues (e.g. "title too long", "no canonical") are flagged inline.
- **Security headers** — scores CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy, X-Content-Type-Options, COOP, CORP. Grades A–F.
- **Console + page errors** — every JS error and warning logged during crawl, with source location and the **full stack trace** for uncaught exceptions.
- **Broken-link scan** — HEAD-checks every outbound `<a href>` discovered during crawl. Reports 404s, redirect chains, unreachable hosts, with the anchor text and every page that links to it.
- **Technology fingerprint** — Wappalyzer-style detection of the CMS, e-commerce platform, frameworks, JS libraries, analytics, tag managers, CDN, web server and language each page uses, with versions where exposed. Per-page chip + list; rolled up site-wide in the intelligence panel.
- **HTTP status** — status code from each crawled page's main navigation

Scores show as chips in `index.html` (green ≥ 90, amber 50–89, red < 50). Expand any page's detail sections for the millisecond metrics, axe nodes, and console stacks — all inline.

## Site intelligence (passive recon)

Once per site, trawl also assembles an **intelligence panel** at the top of the dashboard — the kind of profile you'd take to a prospect ("your domain's been live since 2009, it's on WordPress 5.2 with 3 known CVEs, anyone can spoof your email, and your TLS still accepts TLS 1.1"):

- **Domain & ownership** — registrar, registration date and **domain age**, expiry, nameservers and registrant org via **RDAP** (the modern JSON successor to WHOIS).
- **Hosting** — server IP, **country**, city, hosting provider/ISP, **ASN**, reverse DNS, DNS host and mail provider — from native DNS lookups + IP geolocation.
- **TLS / certificate** — issuer, negotiated protocol, days-to-expiry, SAN count, and a grade; flags expired/near-expiry certs and hosts that still accept legacy TLS 1.0/1.1.
- **Email security** — SPF, DKIM and DMARC posture with a grade, and a clear **spoofable** flag when SPF/DMARC are missing or unenforced.
- **Technology stack** — the deduped, site-wide technology rollup.
- **Known vulnerabilities** — detected component versions correlated against public databases: **RetireJS** for JS libraries (high-confidence CVE/GHSA) and a best-effort **NVD** keyword lookup for the CMS/server (clearly labelled "potential — verify before reporting").

> **Scope — passive only.** trawl performs *passive reconnaissance*: it reads public registry data (RDAP/DNS), inspects the responses and TLS handshake the target voluntarily returns, and correlates exposed version labels against public vulnerability databases. It does **not** attempt unauthorised access, exploitation, port scanning, exposed-file probing or any active attack. This keeps it lawful (e.g. under the UK Computer Misuse Act 1990) and safe to run against a prospect's site. Anything beyond this would require written authorisation from the site owner.

Recon runs by default. Use `--no-recon` to skip it entirely, or `--no-cve` to keep the recon but skip vulnerability correlation (and its rate-limited NVD calls). The fingerprint and vulnerability datasets are vendored under `src/data/`; refresh them with `npm run update-datasets`.

## Machine-readable output

Every run writes `results.json` alongside `index.html`:

```json
{
  "schemaVersion": 3,
  "site": { "label": "example.com", "url": "https://example.com" },
  "intel": {
    "domain": { "domain": "example.com", "registrar": "...", "createdAt": "2009-03-12T00:00:00Z", "ageYears": 17.2, "nameservers": ["..."], "source": "rdap" },
    "dns": { "a": ["104.18.1.1"], "mx": [{ "exchange": "aspmx.l.google.com", "priority": 1 }], "mailProvider": "Google Workspace", "dnsHost": "Cloudflare", "...": "..." },
    "geo": { "ip": "104.18.1.1", "country": "United States", "countryCode": "US", "isp": "Cloudflare, Inc.", "asn": "AS13335 ..." },
    "email": { "grade": "D", "spoofable": true, "spf": { "severity": "ok" }, "dmarc": { "severity": "bad", "note": "no DMARC record" }, "dkim": { "severity": "warn" } },
    "tls": { "ok": true, "protocol": "TLSv1.3", "grade": "B", "daysToExpiry": 47, "legacyProtocols": [], "issuer": "...", "findings": [...] },
    "technologies": [ { "name": "WordPress", "version": "5.2", "categories": ["CMS"], "confidence": 100 }, ... ],
    "vulnerabilities": [ { "component": "jQuery", "version": "1.7.0", "severity": "medium", "ids": ["CVE-2020-7656"], "source": "retirejs", "confidence": "confirmed", "summary": "..." }, ... ]
  },
  "runStamp": "2026-05-16T14-25-11",
  "durationMs": 18234,
  "summary": {
    "pages": 24,
    "externalPages": 1,
    "errors": { "console": 3, "pageErrors": 1 },
    "links": { "checked": 187, "broken": 4 },
    "axe": { "violations": 12, "nodes": 47 },
    "lighthouseAverages": { "performance": 86, "accessibility": 92, "bestPractices": 91, "seo": 95 },
    "securityAverage": 65
  },
  "pages": [
    {
      "url": "...",
      "slug": "home",
      "title": "...",
      "status": 200,
      "external": false,
      "lighthouse": {
        "scores": { "performance": 92, "accessibility": 100, "bestPractices": 100, "seo": 100 },
        "metrics": [ { "id": "largest-contentful-paint", "numericValue": 3200.4, "numericUnit": "millisecond", "displayValue": "3.2 s", "score": 0.5 }, ... ],
        "opportunities": [ { "id": "render-blocking-resources", "savingsMs": 1240, "savingsBytes": 32000, "description": "...", "items": [ { "url": "...", "wastedMs": 800 } ] }, ... ],
        "diagnostics": { "lcpElement": { "selector": "main > h1.hero", "snippet": "..." }, "thirdParty": [...], "mainThreadWorkMs": 2100, ... },
        "failingAudits": [ { "id": "color-contrast", "title": "...", "description": "...", "score": 0 }, ... ]
      },
      "axe": { "violationCount": 2, "nodeCount": 5, "byImpact": { "critical": 0, "serious": 1, ... },
        "violations": [ { "id": "color-contrast", "impact": "serious", "nodeCount": 2, "nodesTruncated": false,
          "nodes": [ { "target": "a.link", "html": "...", "failureSummary": "...", "checks": [ { "id": "color-contrast", "message": "...", "data": { "fgColor": "#adefd1", "bgColor": "#ffffff", "contrastRatio": 1.3, "expectedContrastRatio": "4.5:1" } } ] } ] } ] },
      "seo": { "title": "...", "titleLength": 42, "h1Count": 1, ... },
      "security": { "score": 65, "grade": "C", "checks": [...] },
      "tech": { "technologies": [ { "name": "WordPress", "version": "5.2", "categories": ["CMS"], "confidence": 100 }, ... ] },
      "console": [ { "type": "pageerror", "text": "...", "stack": "..." } ]
    }
  ],
  "links": [ { "fromSlug": "home", "fromSlugs": ["home", "about"], "text": "Read the study", "url": "...", "status": 403, "ok": false, ... } ]
}
```

Averages (`lighthouseAverages`, `securityAverage`, `axe`) reflect your own pages only — pages flagged `external: true` are excluded. Pipe it through `jq` for ad-hoc scripting:

```bash
jq '.summary' ~/Downloads/trawl-*/results.json
# slowest LCP across own pages
jq -r '.pages[] | select(.external|not) | [.slug, (.lighthouse.metrics[]? | select(.id=="largest-contentful-paint") | .numericValue)] | @tsv' results.json
# every axe node selector to fix
jq -r '.pages[].axe?.violations[]?.nodes[]?.target' results.json
jq '.links[] | select(.ok == false)' results.json
```

## Flags

```
Audit:
  --no-lighthouse        skip the Lighthouse audit phase (faster runs)
  --no-axe               skip the axe-core a11y scan
  --no-links             skip outbound-link HEAD checks

Scope:
  --max-pages <N>        stop after N pages have been crawled
  --max-depth <N>        only follow links up to depth N from the start URL
  --include <regex>      only crawl URLs whose full URL matches this regex
  --exclude <regex>      skip URLs whose full URL matches this regex

Auth:
  --auth-storage <path>  Playwright storageState JSON to use for authenticated crawls

Performance:
  --concurrency <N>      parallel pages in flight (default 4)
```

## Authenticated crawls

Pass a Playwright `storageState` file when the target site needs login cookies or localStorage:

```bash
npx playwright codegen https://staging.example.com --save-storage=auth.json
trawl https://staging.example.com --auth-storage ./auth.json
```

`--auth-storage` applies to the whole run, including crawl discovery, screenshots, axe, videos, Lighthouse, and every site in multi-site comparison mode.

## Multi-site comparison

Pass two or more URLs and trawl produces a side-by-side comparison report:

```bash
trawl https://stripe.com https://plaid.com https://truelayer.com --max-pages 30
```

Drops into `~/Downloads/`:

```
trawl-compare-<timestamp>/
  compare.html             leaderboard table — perf, a11y, SEO, security, axe, console, broken links
  compare.json             machine-readable comparison
  sites/
    stripe.com/            full single-site report (index.html + results.json + screenshots + …)
    plaid.com/
    truelayer.com/
trawl-compare-<timestamp>.zip
```

`compare.html` cells are colour-coded (green/amber/red) so the leaderboard is scannable at a glance. Click any site name to open its full report.

You can also pass a text file with one URL per line (`#` for comments):

```bash
trawl ./prospects.txt --max-pages 20 --concurrency 6
```

## What it handles

- Auto-crawls all reachable internal links from the root
- Skips asset URLs (pdf/jpg/png/svg/webp/zip/xml/json/css/js/etc.)
- Dismisses cookie/consent banners by clicking Accept (OneTrust, Cookiebot, Osano, Quantcast, Iubenda, Didomi, CookieYes, TrustArc, Evidon, HubSpot + multilingual text fallback); hides any that resist as a backup
- 30s timeout per page; failures are logged and skipped, never fatal
- HEAD checks fall back to GET for servers that 405/501 on HEAD
- Flags pages that redirect off-origin as third-party — labelled in the report and excluded from your averages, so an external host's scores never skew your own

## Requirements

Node 20+. Chromium downloads automatically on install via Playwright.

## Control panel & macOS app

Trawl ships a local web control panel — build the flag set from a form, capture
authenticated sessions in a headed browser, stream logs live, and browse past
runs and mirrors:

```bash
trawl-ui            # serves http://127.0.0.1:4317 and opens it in your browser
```

On macOS you can run it as a normal app. Build the icon + bundle and install it:

```bash
node scripts/make-icon.mjs   # renders app/icon.icns (net icon) via Chromium
# then build app/Trawl.app and copy it to /Applications
```

`Trawl.app` launches the control panel and opens it in your browser; if a server
is already running it just brings the panel to the front. Drag it from
`/Applications` to your Dock to pin it. The bundle is machine-specific (it points
at your local checkout) so it is git-ignored, not committed.

## Local development

```bash
pnpm install
pnpm dev http://localhost:3000   # run from source via tsx
pnpm build                       # build to dist/
node dist/index.js <url>         # run the built bin
```

## Publishing

```bash
npm version patch                # or minor / major
npm publish
```

## License

MIT
