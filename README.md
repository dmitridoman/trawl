# crawlshot

One command. Crawls every internal page of a site, screenshots each at mobile/tablet/desktop in light + dark, runs Lighthouse + full axe-core a11y + SEO meta + security header + broken-link audits, and ships the lot as a folder + zip with a single dashboard `index.html`. Pass multiple URLs (or a `.txt` file) and you get a side-by-side comparison.

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

- **Lighthouse** — Performance, Accessibility, Best Practices, SEO scores + full HTML report
- **axe-core a11y scan** — every WCAG 2.0/2.1 A & AA + best-practice rule. Per-violation JSON with WCAG SC mapping, impact level, sample selector & HTML. Click the `axe` chip for the full JSON.
- **SEO meta inventory** — title length, meta description, canonical, Open Graph, Twitter Card, `<h1>` count, alt-text coverage, JSON-LD types, lang, robots, viewport. Issues (e.g. "title too long", "no canonical") are flagged inline.
- **Security headers** — scores CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy, X-Content-Type-Options, COOP, CORP. Grades A–F.
- **Console + page errors** — every JS error and warning logged during crawl, per page
- **Broken-link scan** — HEAD-checks every outbound `<a href>` discovered during crawl. Reports 404s, redirect chains, unreachable hosts.
- **HTTP status** — status code from each crawled page's main navigation

Scores show as chips in `index.html` (green ≥ 90, amber 50–89, red < 50). Click a chip to open the full per-page report.

## Machine-readable output

Every run writes `results.json` alongside `index.html`:

```json
{
  "schemaVersion": 1,
  "site": { "label": "example.com", "url": "https://example.com" },
  "runStamp": "2026-05-16T14-25-11",
  "durationMs": 18234,
  "summary": {
    "pages": 24,
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
      "lighthouse": { "performance": 92, ... },
      "axe": { "violationCount": 2, "byImpact": { "critical": 0, "serious": 1, ... }, "violations": [...] },
      "seo": { "title": "...", "titleLength": 42, "h1Count": 1, ... },
      "security": { "score": 65, "grade": "C", "checks": [...] },
      "console": [...]
    }
  ],
  "links": [ { "fromSlug": "home", "url": "...", "status": 200, "ok": true, ... } ]
}
```

Pipe it through `jq` for ad-hoc scripting:

```bash
jq '.summary' ~/Downloads/crawlshot-*/results.json
jq '.pages[] | select(.axe.violationCount > 0) | .slug' results.json
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
