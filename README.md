# crawlshot

One command. Crawls every internal page of a site, screenshots each at mobile/tablet/desktop, zips it.

## Usage

No install — run straight from npm:

```bash
npx crawlshot http://localhost:3000
npx crawlshot https://example.com
npx crawlshot https://example.com --no-lighthouse
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
  index.html              report — thumbnails + Lighthouse score chips
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
    services__web-design.html
crawlshot-<site>-<timestamp>.zip
```

Nested routes use `__` so the folder names stay flat and readable. Open `index.html` to skim every page at every viewport at light/dark with Lighthouse scores inline.

## Viewports

| name    | width × height |
| ------- | -------------- |
| phone   | 375 × 812      |
| tablet  | 768 × 1024     |
| desktop | 1440 × 900     |

Full-page screenshots at light + dark colour schemes. Fonts are awaited via `document.fonts.ready` and animations are frozen before capture, so output is stable run-to-run.

## What it audits

Each page gets a Lighthouse pass with four categories:

- **Performance** — LCP, CLS, TBT, etc.
- **Accessibility** — colour contrast, ARIA, semantic HTML
- **Best Practices** — HTTPS, JS errors, deprecated APIs
- **SEO** — meta tags, crawlability, structured data

Scores show as chips in `index.html` (green ≥ 90, amber 50–89, red < 50). Click a chip to open the full per-page report. Pass `--no-lighthouse` to skip the audit phase for faster runs.

## What it handles

- Auto-crawls all reachable internal links from the root
- Skips anchors, asset URLs (pdf/jpg/png/svg/webp/zip/xml/json)
- Dismisses cookie/consent banners by clicking Accept (OneTrust, Cookiebot, Osano, Quantcast, Iubenda, Didomi, CookieYes, TrustArc, Evidon, HubSpot + multilingual text fallback); hides any that resist as a backup
- 30s timeout per page; failures are logged and skipped, never fatal

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
