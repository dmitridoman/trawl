// Generates the Trawl app icon: an ocean-gradient squircle with a diamond-mesh
// trawl net scooping up glowing "catches". Renders the SVG with the bundled
// Chromium at every macOS iconset size, then compiles icon.icns via iconutil.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "app");
const ICONSET = path.join(ASSETS, "Trawl.iconset");

// ---- Build the SVG --------------------------------------------------------
const S = 1024;

// Diamond mesh: a square grid rotated 45° around the centre, clipped to the
// net bag. Two line families through one rotated grid → diamonds.
let mesh = "";
for (let c = -480; c <= 1504; c += 58) {
  mesh += `<line x1="${c}" y1="-480" x2="${c}" y2="1504"/>`; // verticals
  mesh += `<line x1="-480" y1="${c}" x2="1504" y2="${c}"/>`; // horizontals
}

// Net bag: a mouth ellipse (rim) tapering to a rounded cod-end below.
const BAG =
  "M 240 372 " +
  "C 240 588, 392 808, 512 808 " +
  "C 632 808, 784 588, 784 372 " +
  "A 272 96 0 0 1 240 372 Z";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2DD4BF"/>
      <stop offset="0.45" stop-color="#0E7C86"/>
      <stop offset="1" stop-color="#0B2D4A"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#FDE68A" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#FDE68A" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="bag"><path d="${BAG}"/></clipPath>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="20" flood-color="#021018" flood-opacity="0.35"/>
    </filter>
  </defs>

  <!-- squircle background -->
  <rect x="0" y="0" width="${S}" height="${S}" rx="230" ry="230" fill="url(#bg)"/>
  <!-- top sheen -->
  <rect x="0" y="0" width="${S}" height="${S}" rx="230" ry="230" fill="#ffffff" opacity="0.06"/>

  <!-- the net -->
  <g filter="url(#soft)">
    <!-- bag fill -->
    <path d="${BAG}" fill="#06202F" opacity="0.30"/>

    <!-- glowing catches gathered in the cod-end -->
    <circle cx="500" cy="690" r="90" fill="url(#glow)"/>
    <circle cx="476" cy="676" r="26" fill="#FDE68A"/>
    <circle cx="540" cy="700" r="22" fill="#FFFFFF"/>
    <circle cx="498" cy="724" r="18" fill="#7DD3FC"/>

    <!-- diamond mesh -->
    <g clip-path="url(#bag)">
      <g transform="rotate(45 512 512)" stroke="#EAFBFF" stroke-width="9" stroke-opacity="0.85" fill="none">
        ${mesh}
      </g>
    </g>

    <!-- mouth rim (front lip + back) -->
    <ellipse cx="512" cy="372" rx="272" ry="96" fill="none" stroke="#EAFBFF" stroke-width="22" stroke-opacity="0.95"/>
    <!-- bag outline -->
    <path d="${BAG}" fill="none" stroke="#EAFBFF" stroke-width="16" stroke-opacity="0.6"/>
  </g>
</svg>`;

// ---- Rasterise + compile --------------------------------------------------
fs.rmSync(ICONSET, { recursive: true, force: true });
fs.mkdirSync(ICONSET, { recursive: true });
fs.writeFileSync(path.join(ASSETS, "icon.svg"), svg);

const sizes = [
  ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: S, height: S }, deviceScaleFactor: 1 });
await page.setContent(
  `<style>html,body{margin:0;padding:0;background:transparent}</style>${svg}`,
  { waitUntil: "networkidle" }
);
const el = await page.$("svg");
for (const [name, px] of sizes) {
  await page.setViewportSize({ width: px, height: px });
  await page.evaluate((p) => {
    const s = document.querySelector("svg");
    s.setAttribute("width", p); s.setAttribute("height", p);
  }, px);
  await el.screenshot({ path: path.join(ICONSET, name), omitBackground: true });
}
await browser.close();

execFileSync("iconutil", ["-c", "icns", ICONSET, "-o", path.join(ASSETS, "icon.icns")], { stdio: "inherit" });
console.log("icon.icns written to", path.join(ASSETS, "icon.icns"));
