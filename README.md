# crawlshot

One command. Crawls every internal page of a site, screenshots each at mobile/tablet/desktop in light + dark, runs Lighthouse + full axe-core a11y + SEO meta + security header + broken-link audits, and ships the lot as a folder + zip with a single dashboard `index.html`. Pass multiple URLs (or a `.txt` file) and you get a side-by-side comparison.

The dashboard is **self-contained and deep by default**: millisecond Lighthouse metrics, perf opportunities with the offending resources, the actual LCP element, every axe node (selector + fix + contrast values), and full console stack traces are embedded directly in `index.html` — no need to open the side files. That makes the report enough, on its own, for a human or an agent to act on. Third-party pages reached via an off-origin redirect (e.g. an external booking host) are labelled and excluded from your averages.

## Usage

No install — run straight from npm:

```bash
# single site
npx crawlshot http://localhost:3000
npx crawlshot https://example.com
npx crawlshot https://example.com --max-pages 50 --concurrency 6

# multi-site comparison
npx crawlshot https://stripe.com https://plaid.com https://truelayer.com
npx crawlshot ./prospects.txt --max-pages 30
```

Or from GitHub without publishing:

```bash
pnpm dlx github:dmitridoman/crawlshot https://example.com
```

Or install globally:

```bash
npm i -g crawlshot
crawlshot https://example.com
```

## Output

Drops into `~/Downloads/`:

```
crawlshot-<site>-<timestamp>/
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
crawlshot-<site>-<timestamp>.zip
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
- **HTTP status** — status code from each crawled page's main navigation

Scores show as chips in `index.html` (green ≥ 90, amber 50–89, red < 50). Expand any page's detail sections for the millisecond metrics, axe nodes, and console stacks — all inline.

## Machine-readable output

Every run writes `results.json` alongside `index.html`:

```json
{
  "schemaVersion": 2,
  "site": { "label": "example.com", "url": "https://example.com" },
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
      "console": [ { "type": "pageerror", "text": "...", "stack": "..." } ]
    }
  ],
  "links": [ { "fromSlug": "home", "fromSlugs": ["home", "about"], "text": "Read the study", "url": "...", "status": 403, "ok": false, ... } ]
}
```

Averages (`lighthouseAverages`, `securityAverage`, `axe`) reflect your own pages only — pages flagged `external: true` are excluded. Pipe it through `jq` for ad-hoc scripting:

```bash
jq '.summary' ~/Downloads/crawlshot-*/results.json
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

Performance:
  --concurrency <N>      parallel pages in flight (default 4)
```

## Multi-site comparison

Pass two or more URLs and crawlshot produces a side-by-side comparison report:

```bash
crawlshot https://stripe.com https://plaid.com https://truelayer.com --max-pages 30
```

Drops into `~/Downloads/`:

```
crawlshot-compare-<timestamp>/
  compare.html             leaderboard table — perf, a11y, SEO, security, axe, console, broken links
  compare.json             machine-readable comparison
  sites/
    stripe.com/            full single-site report (index.html + results.json + screenshots + …)
    plaid.com/
    truelayer.com/
crawlshot-compare-<timestamp>.zip
```

`compare.html` cells are colour-coded (green/amber/red) so the leaderboard is scannable at a glance. Click any site name to open its full report.

You can also pass a text file with one URL per line (`#` for comments):

```bash
crawlshot ./prospects.txt --max-pages 20 --concurrency 6
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
