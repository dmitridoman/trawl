# crawlshot

One command. Crawls every internal page of a site, screenshots each at mobile/tablet/desktop, zips it.

## Usage

No install — run straight from npm:

```bash
npx crawlshot http://localhost:3000
npx crawlshot https://example.com
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

Drops into the current working directory:

```
screenshots/
  home/
    mobile.png
    tablet.png
    desktop.png
  about/
    mobile.png
    ...
  services__web-design/
    ...
screenshots.zip
```

Nested routes use `__` so the folder names stay flat and readable.

## Viewports

| name    | width × height |
| ------- | -------------- |
| mobile  | 375 × 812      |
| tablet  | 768 × 1024     |
| desktop | 1440 × 900     |

Full-page screenshots, 500ms settle delay per page for animations.

## What it handles

- Auto-crawls all reachable internal links from the root
- Skips anchors, asset URLs (pdf/jpg/png/svg/webp/zip/xml/json)
- 20s timeout per page; failures are logged and skipped, never fatal
- Cleans up previous run before starting

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
