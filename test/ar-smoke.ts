// Smoke test for the trawl-ar CLI. Run with:
//   npm run test:ar
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const wasmEmptyModule = Buffer.from("0061736d01000000", "hex");

function serveFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
<html>
  <head><title>AR fixture</title></head>
  <body>
    <button id="try">TRY ON</button>
    <script src="/app.js"></script>
  </body>
</html>`);
      return;
    }
    if (url === "/app.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(`
const fragmentShader = "precision mediump float; uniform sampler2D nailTexture; void main(){ gl_FragColor = texture2D(nailTexture, vec2(0.5)); }";
async function loadArtifacts() {
  await fetch('/config.json');
  await fetch('/models/nail_detector.mnn');
  await fetch('/venus.wasm');
}
document.getElementById('try').addEventListener('click', async () => {
  await loadArtifacts();
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 240;
  document.body.appendChild(canvas);
  const gl = canvas.getContext('webgl');
  const shader = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(shader, fragmentShader);
  gl.compileShader(shader);
  gl.clearColor(1, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  requestAnimationFrame(() => gl.drawArrays(gl.POINTS, 0, 1));
});
//# sourceMappingURL=/app.js.map
`);
      return;
    }
    if (url === "/app.js.map") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: 3, sources: ["app.ts"], mappings: "" }));
      return;
    }
    if (url === "/config.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ features: { handar: "1", snapshot: "1" }, endpoint: "/api/webconsultation/authorize.action" }));
      return;
    }
    if (url === "/models/nail_detector.mnn") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from("MNN nail_detector input_tensor output_heatmap conv relu hand palm mask", "utf8"));
      return;
    }
    if (url === "/venus.wasm") {
      res.writeHead(200, { "content-type": "application/wasm" });
      res.end(wasmEmptyModule);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert(addr && typeof addr === "object");
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        close: () => new Promise<void>((done, reject) => server.close((err) => err ? reject(err) : done())),
      });
    });
  });
}

function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/ar.js", ...args], { cwd: path.resolve(import.meta.dirname, "..") });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`trawl-ar exited ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    });
  });
}

async function main() {
  const fixture = await serveFixture();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "trawl-ar-smoke-"));
  try {
    await runCli([
      fixture.url,
      "--click",
      "#try",
      "--wait",
      "1200",
      "--camera",
      "fake",
      "--headless",
      "--i-am-authorized",
      "--out-dir",
      outDir,
    ]);

    for (const rel of [
      "ar-results.json",
      "report.html",
      "network.har",
      "trace.zip",
      "console.json",
      "runtime-metrics.json",
      "analysis/endpoints.json",
      "analysis/shaders.json",
      "analysis/sourcemaps.json",
      "device-notes.md",
    ]) {
      assert(fs.existsSync(path.join(outDir, rel)), `${rel} should exist`);
    }

    const results = JSON.parse(fs.readFileSync(path.join(outDir, "ar-results.json"), "utf8"));
    assert(results.summary.artifacts >= 4, "should capture fixture artifacts");
    assert(results.summary.scripts >= 1, "should capture script");
    assert(results.summary.wasm >= 1, "should capture wasm");
    assert(results.summary.mnn >= 1, "should capture mnn");
    assert(results.summary.shaderCandidates >= 1, "should extract shader candidate");
    assert(results.runtime.canvases.length >= 1, "should observe canvas");
    console.log(`trawl-ar smoke passed: ${outDir}`);
  } finally {
    await fixture.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
