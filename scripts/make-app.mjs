#!/usr/bin/env node
// Builds app/Trawl.app — a minimal macOS application bundle that launches the
// trawl control panel server (dist/server.js) and opens it in the browser.
//
// The bundle is machine-specific (it hard-codes the path to this checkout) and
// is git-ignored. Run this script once, then copy Trawl.app to /Applications.
//
// Usage:
//   node scripts/make-app.mjs              # build only
//   node scripts/make-app.mjs --install    # build and copy to /Applications

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(ROOT, "app");
const APP_BUNDLE = path.join(APP_DIR, "Trawl.app");
const INSTALL = process.argv.includes("--install");

// Resolve the node binary used to run this script so the app uses the same one.
const NODE_BIN = process.execPath;
const SERVER_JS = path.join(ROOT, "dist", "server.js");
const ICON_SRC = path.join(APP_DIR, "icon.icns");

// ---------------------------------------------------------------------------
// Validate prerequisites
// ---------------------------------------------------------------------------
if (!fs.existsSync(SERVER_JS)) {
  console.log("dist/server.js not found — running build first…");
  spawnSync("node", ["node_modules/.bin/tsup"], { cwd: ROOT, stdio: "inherit" });
  if (!fs.existsSync(SERVER_JS)) {
    console.error("ERROR: build failed. Run 'pnpm build' manually and retry.");
    process.exit(1);
  }
}
if (!fs.existsSync(ICON_SRC)) {
  console.log("app/icon.icns not found — running make-icon first…");
  spawnSync("node", [path.join(ROOT, "scripts", "make-icon.mjs")], { cwd: ROOT, stdio: "inherit" });
  if (!fs.existsSync(ICON_SRC)) {
    console.error("ERROR: icon build failed. Run 'node scripts/make-icon.mjs' manually and retry.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Create the .app directory structure
// ---------------------------------------------------------------------------
const CONTENTS = path.join(APP_BUNDLE, "Contents");
const MACOS = path.join(CONTENTS, "MacOS");
const RESOURCES = path.join(CONTENTS, "Resources");

fs.rmSync(APP_BUNDLE, { recursive: true, force: true });
fs.mkdirSync(MACOS, { recursive: true });
fs.mkdirSync(RESOURCES, { recursive: true });

// ---------------------------------------------------------------------------
// Info.plist
// ---------------------------------------------------------------------------
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Trawl</string>
  <key>CFBundleDisplayName</key>
  <string>Trawl</string>
  <key>CFBundleIdentifier</key>
  <string>com.dmitridoman.trawl</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleExecutable</key>
  <string>trawl-launcher</string>
  <key>CFBundleIconFile</key>
  <string>icon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <false/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
fs.writeFileSync(path.join(CONTENTS, "Info.plist"), plist);

// ---------------------------------------------------------------------------
// Launcher shell script — the actual executable inside MacOS/
// Starts the server (if not already running) and opens the browser.
// Detects stale servers and restarts them if the built server is newer.
// ---------------------------------------------------------------------------
const launcher = `#!/bin/bash
# Trawl launcher — machine-specific, points at the local checkout.
NODE="${NODE_BIN}"
SERVER="${SERVER_JS}"
DOPPLER="$(command -v doppler || echo /opt/homebrew/bin/doppler)"
PORT=\${TRAWL_PORT:-4317}
URL="http://127.0.0.1:\${PORT}"

# Check if a server is already listening on the port
if lsof -i ":\${PORT}" -sTCP:LISTEN -t &>/dev/null 2>&1; then
  # Server is running — check if it's stale by comparing build timestamps
  BUILT_MTIME=\$(stat -f %m "\${SERVER}" 2>/dev/null || echo 0)
  RUNNING_MTIME=\$(curl -s "http://127.0.0.1:\${PORT}/version" | grep -o '"timestamp":[0-9]*' | grep -o '[0-9]*\$' 2>/dev/null || echo 0)

  # Convert running mtime from milliseconds to seconds (built mtime is already in seconds)
  RUNNING_MTIME=\$((RUNNING_MTIME / 1000))

  if [ \$BUILT_MTIME -gt \$RUNNING_MTIME ]; then
    # Built server is newer — kill the old one
    lsof -i ":\${PORT}" -sTCP:LISTEN -t | xargs kill -9 2>/dev/null || true
    sleep 0.2
  else
    # Server is current — just open the browser
    open "\${URL}"
    exit 0
  fi
fi

# Launch the server in the background, redirect output to a log file.
# Secrets come from the "trawl" Doppler project (config: prd) so API keys
# never need to live in a local .env file. Falls back to a bare launch (no
# secrets) if the doppler CLI isn't installed or isn't logged in.
LOG="$HOME/.trawl/server.log"
mkdir -p "$HOME/.trawl"
if [ -x "\${DOPPLER}" ] && "\${DOPPLER}" secrets --project trawl --config prd --json &>/dev/null; then
  "\${DOPPLER}" run --project trawl --config prd -- "\${NODE}" "\${SERVER}" >> "\${LOG}" 2>&1 &
else
  echo "$(date): doppler CLI not found or not authorized for trawl/prd — starting without secrets" >> "\${LOG}"
  "\${NODE}" "\${SERVER}" >> "\${LOG}" 2>&1 &
fi

# Wait up to 8 seconds for the server to start, then open the browser.
for i in $(seq 1 16); do
  sleep 0.5
  if lsof -i ":\${PORT}" -sTCP:LISTEN -t &>/dev/null 2>&1; then
    open "\${URL}"
    exit 0
  fi
done

# Fallback: open anyway and let the browser retry.
open "\${URL}"
`;
const launcherPath = path.join(MACOS, "trawl-launcher");
fs.writeFileSync(launcherPath, launcher);
fs.chmodSync(launcherPath, 0o755);

// ---------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------
fs.copyFileSync(ICON_SRC, path.join(RESOURCES, "icon.icns"));

console.log(`✓ Built ${APP_BUNDLE}`);

// ---------------------------------------------------------------------------
// Optionally install to /Applications
// ---------------------------------------------------------------------------
if (INSTALL) {
  const dest = "/Applications/Trawl.app";
  try {
    fs.rmSync(dest, { recursive: true, force: true });
  } catch {}
  execFileSync("cp", ["-R", APP_BUNDLE, dest], { stdio: "inherit" });
  console.log(`✓ Installed to ${dest}`);
}
