import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { format as prettierFormat } from "prettier";

const HELP = `
Trawl AR — capture and inspect browser AR / virtual try-on tools

Usage:
  trawl-ar <url> --click "text=TRY ON" --i-am-authorized [flags]
  trawl-ar <url> --device ios --import-ios-artifacts ./safari-export --i-am-authorized

Core flags:
  --i-am-authorized          required safety gate for full artifact capture
  --click <selector>         click a startup selector; repeatable
  --wait <ms>                capture duration after startup clicks (default 10000)
  --artifact-url <regex>     extra URL capture pattern; repeatable
  --device <name>            desktop, android, ios (default desktop)
  --camera <mode>            real, fake, none (default real)
  --headed                   force headed browser (default for desktop)
  --headless                 force headless browser
  --cdp-url <url>            Chrome remote debugging URL for Android/remote Chrome
  --import-ios-artifacts <dir>
                             merge Safari Web Inspector exports into a report shell
  --auth-storage <path>      Playwright storageState JSON
  --user-agent <ua>          override browser user agent
  --out-dir <path>           explicit output directory
  -h, --help                 show this help
`;

type DeviceName = "desktop" | "android" | "ios";
type CameraMode = "real" | "fake" | "none";
type ArtifactKind = "script" | "sourcemap" | "wasm" | "mnn" | "model" | "json" | "shader" | "media" | "image" | "font" | "style" | "other";

type ArOptions = {
  url: string;
  clicks: string[];
  waitMs: number;
  artifactPatterns: RegExp[];
  device: DeviceName;
  camera: CameraMode;
  headed: boolean;
  cdpUrl: string | null;
  authStorage: string | null;
  userAgent: string;
  outDir: string;
  importIosArtifacts: string | null;
  authorized: boolean;
};

type ConsoleEntry = {
  type: string;
  text: string;
  location?: string;
  stack?: string;
  ts: string;
};

type NetworkEntry = {
  url: string;
  method: string;
  resourceType: string;
  status: number | null;
  contentType: string | null;
  bytes: number | null;
  fromCache: boolean;
  artifact: boolean;
  localPath: string | null;
  error?: string;
};

type ArtifactEntry = {
  url: string;
  localPath: string;
  kind: ArtifactKind;
  contentType: string | null;
  bytes: number;
  sha256: string;
};

type RuntimeMetrics = {
  url: string;
  title: string;
  userAgent: string;
  elapsedMs: number;
  firstCanvasFrameMs: number | null;
  rafCount: number;
  fpsApprox: number | null;
  webgl: Record<string, number>;
  resources: { name: string; initiatorType: string; duration: number; transferSize: number; encodedBodySize: number }[];
  canvases: { index: number; width: number; height: number; clientWidth: number; clientHeight: number; visible: boolean }[];
  videos: { index: number; src: string; width: number; height: number; readyState: number; paused: boolean; visible: boolean }[];
  memory: Record<string, number> | null;
};

type BundleAnalysis = {
  url: string;
  localPath: string;
  prettyPath: string | null;
  sourceMapUrl: string | null;
  sourceMapPath: string | null;
  endpoints: string[];
  modelUrls: string[];
  shaderCandidates: string[];
  symbols: Record<string, number>;
};

type WasmAnalysis = {
  url: string;
  localPath: string;
  watPath: string | null;
  binaryenTextPath: string | null;
  imports: string[];
  exports: string[];
  strings: string[];
  error?: string;
};

type MnnAnalysis = {
  url: string;
  localPath: string;
  bytes: number;
  sha256: string;
  strings: string[];
  likelyNames: string[];
  note: string;
};

type ArResults = {
  schemaVersion: 1;
  kind: "trawl-ar";
  url: string;
  runStamp: string;
  device: DeviceName;
  camera: CameraMode;
  clicks: string[];
  durationMs: number;
  outDir: string;
  summary: {
    network: number;
    artifacts: number;
    scripts: number;
    wasm: number;
    mnn: number;
    shaderCandidates: number;
    consoleErrors: number;
    pageErrors: number;
  };
  artifacts: ArtifactEntry[];
  network: NetworkEntry[];
  console: ConsoleEntry[];
  runtime: RuntimeMetrics | null;
  analysis: {
    bundles: BundleAnalysis[];
    wasm: WasmAnalysis[];
    mnn: MnnAnalysis[];
    endpoints: string[];
    shaders: { source: string; value: string }[];
    sourcemaps: { source: string; url: string; localPath: string | null; status: "found" | "missing" | "error"; error?: string }[];
  };
  notes: string[];
};

const DEFAULT_ARTIFACT_RE = /(\.(?:js|map|wasm|mnn|bin|data|pfm|json|glsl|vert|frag|obj|hdr|ktx2?|basis|png|jpg|jpeg|webp|svg|mp4|webm)(?:[?#]|$)|webconsultation|makeupar|perfectcorp|youcam|model|detector|tracking|shader|pbr|nail|hand|ar|try-on|virtual-try-on|api)/i;
const TEXT_TYPE_RE = /^(text\/|application\/(?:json|javascript|x-javascript|wasm|xml|.*\+json|.*\+xml)|image\/svg)/i;
const URL_RE = /https?:\/\/[^\s"'`<>\\)]+|\/[A-Za-z0-9_./-]+\.(?:wasm|mnn|bin|data|json|pfm|png|jpg|jpeg|svg|mp4|webm|hdr|obj)(?:\?[^"'`\s<>)]*)?|[A-Za-z0-9_-]+\.action(?:\?[^"'`\s<>)]*)?/g;
const SHADER_RE = /(gl_FragColor|gl_Position|precision\s+(?:highp|mediump|lowp)|uniform\s+\w+|varying\s+\w+|attribute\s+\w+|sampler2D|texture2D|void\s+main\s*\()/i;
const MODEL_RE = /\.(?:mnn|wasm|bin|data|pfm|obj|hdr|ktx2?|basis)(?:[?#]|$)|detector|tracking|model|hand|nail/i;
const PRETTIER_MAX_BYTES = 100 * 1024;
const SHADER_SCAN_MAX_BYTES = 100 * 1024;
const BUNDLE_ANALYSIS_MAX_BYTES = 100 * 1024;
const WASM_TEXT_MAX_BYTES = 1024 * 1024;
const SOURCEMAP_FETCH_TIMEOUT_MS = 750;
const RESPONSE_BODY_TIMEOUT_MS = 5000;

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeSeg(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "_";
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function classifyArtifact(url: string, contentType: string | null, resourceType = ""): ArtifactKind {
  const clean = url.split("?")[0]!.toLowerCase();
  if (clean.endsWith(".map")) return "sourcemap";
  if (clean.endsWith(".wasm") || /application\/wasm/i.test(contentType ?? "")) return "wasm";
  if (clean.endsWith(".mnn")) return "mnn";
  if (/\.(bin|data|pfm|obj|hdr|ktx2?|basis)$/.test(clean)) return "model";
  if (clean.endsWith(".json") || /json/i.test(contentType ?? "")) return "json";
  if (clean.endsWith(".js") || /javascript/i.test(contentType ?? "") || resourceType === "script") return "script";
  if (/\.(glsl|vert|frag)$/.test(clean)) return "shader";
  if (/\.(mp4|webm|mov|m3u8|mpd)$/.test(clean) || resourceType === "media" || /^video\//i.test(contentType ?? "")) return "media";
  if (/\.(png|jpg|jpeg|webp|gif|svg)$/.test(clean) || /^image\//i.test(contentType ?? "")) return "image";
  if (/\.(woff2?|ttf|otf|eot)$/.test(clean) || resourceType === "font") return "font";
  if (clean.endsWith(".css") || /text\/css/i.test(contentType ?? "") || resourceType === "stylesheet") return "style";
  return "other";
}

function localPathForUrl(url: string, root: string): string {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean).map(safeSeg);
  let file = parts.pop() ?? "index";
  if (u.search) {
    const h = crypto.createHash("sha1").update(u.search).digest("hex").slice(0, 8);
    const dot = file.lastIndexOf(".");
    file = dot > 0 ? `${file.slice(0, dot)}.q${h}${file.slice(dot)}` : `${file}.q${h}`;
  }
  return path.join(root, safeSeg(u.hostname), ...parts, file);
}

function parseCli(): ArOptions {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      "i-am-authorized": { type: "boolean" },
      click: { type: "string", multiple: true },
      wait: { type: "string" },
      "artifact-url": { type: "string", multiple: true },
      device: { type: "string" },
      camera: { type: "string" },
      headed: { type: "boolean" },
      headless: { type: "boolean" },
      "cdp-url": { type: "string" },
      "import-ios-artifacts": { type: "string" },
      "auth-storage": { type: "string" },
      "user-agent": { type: "string" },
      "out-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (parsed.values.help || parsed.positionals.length === 0) {
    console.log(HELP);
    process.exit(parsed.values.help ? 0 : 1);
  }

  const url = parsed.positionals[0]!;
  try {
    new URL(url);
  } catch {
    console.error(`trawl-ar: expected an absolute URL, got ${url}`);
    process.exit(1);
  }

  const device = (parsed.values.device ?? "desktop") as DeviceName;
  if (!["desktop", "android", "ios"].includes(device)) {
    console.error("trawl-ar: --device must be one of desktop, android, ios");
    process.exit(1);
  }

  const camera = (parsed.values.camera ?? "real") as CameraMode;
  if (!["real", "fake", "none"].includes(camera)) {
    console.error("trawl-ar: --camera must be one of real, fake, none");
    process.exit(1);
  }

  const waitMs = Number(parsed.values.wait ?? "10000");
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    console.error("trawl-ar: --wait must be a non-negative number of milliseconds");
    process.exit(1);
  }

  const artifactPatterns = [DEFAULT_ARTIFACT_RE];
  for (const raw of (parsed.values["artifact-url"] as string[] | undefined) ?? []) {
    try {
      artifactPatterns.push(new RegExp(raw, "i"));
    } catch (err) {
      console.error(`trawl-ar: invalid --artifact-url regex: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const authStorage = parsed.values["auth-storage"] ? path.resolve(String(parsed.values["auth-storage"])) : null;
  if (authStorage && !fs.existsSync(authStorage)) {
    console.error(`trawl-ar: --auth-storage not found: ${authStorage}`);
    process.exit(1);
  }

  const host = new URL(url).hostname.replace(/^www\./, "");
  const outDir = parsed.values["out-dir"]
    ? path.resolve(String(parsed.values["out-dir"]))
    : path.join(os.homedir(), "Downloads", `trawl-ar-${safeSeg(host)}-${nowStamp()}`);

  const headed = parsed.values.headless ? false : parsed.values.headed ? true : device === "desktop";
  const userAgent = parsed.values["user-agent"]
    ? String(parsed.values["user-agent"])
    : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  return {
    url,
    clicks: (parsed.values.click as string[] | undefined) ?? [],
    waitMs,
    artifactPatterns,
    device,
    camera,
    headed,
    cdpUrl: parsed.values["cdp-url"] ? String(parsed.values["cdp-url"]) : null,
    authStorage,
    userAgent,
    outDir,
    importIosArtifacts: parsed.values["import-ios-artifacts"] ? path.resolve(String(parsed.values["import-ios-artifacts"])) : null,
    authorized: Boolean(parsed.values["i-am-authorized"]),
  };
}

function runtimeProbeScript(): string {
  return `
(() => {
  const state = {
    start: performance.now(),
    firstCanvasFrameMs: null,
    rafCount: 0,
    webgl: {
      drawArrays: 0,
      drawElements: 0,
      createShader: 0,
      shaderSource: 0,
      compileShader: 0,
      linkProgram: 0,
      texImage2D: 0,
      readPixels: 0
    },
    shaderSources: []
  };
  Object.defineProperty(window, "__trawlAr", { value: state, configurable: true });
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function(cb) {
    return raf.call(this, function(ts) {
      state.rafCount++;
      return cb(ts);
    });
  };
  const patch = (proto) => {
    if (!proto || proto.__trawlArPatched) return;
    proto.__trawlArPatched = true;
    for (const name of Object.keys(state.webgl)) {
      const original = proto[name];
      if (typeof original !== "function") continue;
      proto[name] = function(...args) {
        state.webgl[name]++;
        if ((name === "drawArrays" || name === "drawElements") && state.firstCanvasFrameMs == null) {
          state.firstCanvasFrameMs = performance.now() - state.start;
        }
        if (name === "shaderSource" && typeof args[1] === "string") {
          state.shaderSources.push(String(args[1]).slice(0, 20000));
        }
        return original.apply(this, args);
      };
    }
  };
  patch(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
  patch(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
})();
`;
}

async function collectRuntime(page: Page): Promise<RuntimeMetrics> {
  return page.evaluate(() => {
    const ar = (window as unknown as { __trawlAr?: { start: number; firstCanvasFrameMs: number | null; rafCount: number; webgl: Record<string, number> } }).__trawlAr;
    const elapsedMs = ar ? performance.now() - ar.start : 0;
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const perf = performance as Performance & { memory?: Record<string, number> };
    return {
      url: location.href,
      title: document.title,
      userAgent: navigator.userAgent,
      elapsedMs,
      firstCanvasFrameMs: ar?.firstCanvasFrameMs ?? null,
      rafCount: ar?.rafCount ?? 0,
      fpsApprox: ar && elapsedMs > 0 ? Math.round((ar.rafCount / elapsedMs) * 100000) / 100 : null,
      webgl: ar?.webgl ?? {},
      resources: performance.getEntriesByType("resource").map((entry) => {
        const r = entry as PerformanceResourceTiming;
        return {
          name: r.name,
          initiatorType: r.initiatorType,
          duration: r.duration,
          transferSize: r.transferSize,
          encodedBodySize: r.encodedBodySize,
        };
      }),
      canvases: Array.from(document.querySelectorAll("canvas")).map((c, index) => ({
        index,
        width: c.width,
        height: c.height,
        clientWidth: c.clientWidth,
        clientHeight: c.clientHeight,
        visible: visible(c),
      })),
      videos: Array.from(document.querySelectorAll("video")).map((v, index) => ({
        index,
        src: v.currentSrc || v.src,
        width: v.videoWidth,
        height: v.videoHeight,
        readyState: v.readyState,
        paused: v.paused,
        visible: visible(v),
      })),
      memory: perf.memory ?? null,
    };
  });
}

async function saveCanvasFrames(page: Page, dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const frames = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("canvas")).map((canvas, index) => {
      try {
        return { index, dataUrl: canvas.toDataURL("image/png") };
      } catch (err) {
        return { index, error: (err as Error).message };
      }
    });
  });
  for (const frame of frames) {
    if ("dataUrl" in frame && typeof frame.dataUrl === "string" && frame.dataUrl.startsWith("data:image/png;base64,")) {
      fs.writeFileSync(path.join(dir, `canvas-${frame.index}.png`), Buffer.from(frame.dataUrl.split(",")[1]!, "base64"));
    } else {
      fs.writeFileSync(path.join(dir, `canvas-${frame.index}.txt`), "error" in frame && frame.error ? frame.error : "unavailable");
    }
  }
}

function shouldCapture(url: string, contentType: string | null, patterns: RegExp[]): boolean {
  if (!/^https?:/i.test(url)) return false;
  return patterns.some((re) => re.test(url)) || (contentType != null && /wasm|javascript|json|image|video|font|css/i.test(contentType));
}

async function responseBodyWithTimeout(resp: Response): Promise<Buffer> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      resp.body(),
      new Promise<Buffer>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`response.body timed out after ${RESPONSE_BODY_TIMEOUT_MS} ms`)), RESPONSE_BODY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function maybeSaveArtifact(
  resp: Response,
  opts: ArOptions,
  assetsDir: string,
  seen: Map<string, ArtifactEntry>,
): Promise<{ artifact: boolean; localPath: string | null; bytes: number | null; error?: string }> {
  const url = resp.url().split("#")[0]!;
  const contentType = resp.headers()["content-type"] ?? null;
  if (!shouldCapture(url, contentType, opts.artifactPatterns)) return { artifact: false, localPath: null, bytes: null };
  if (seen.has(url)) {
    const existing = seen.get(url)!;
    return { artifact: true, localPath: existing.localPath, bytes: existing.bytes };
  }
  try {
    const body = await responseBodyWithTimeout(resp);
    const dest = localPathForUrl(url, assetsDir);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    const entry: ArtifactEntry = {
      url,
      localPath: path.relative(opts.outDir, dest),
      kind: classifyArtifact(url, contentType, resp.request().resourceType()),
      contentType,
      bytes: body.length,
      sha256: sha256(body),
    };
    seen.set(url, entry);
    return { artifact: true, localPath: entry.localPath, bytes: body.length };
  } catch (err) {
    return { artifact: true, localPath: null, bytes: null, error: (err as Error).message };
  }
}

function extractStrings(buf: Buffer, minLen = 4): string[] {
  const text = buf.toString("latin1");
  const matches = text.match(new RegExp(`[ -~]{${minLen},}`, "g")) ?? [];
  return Array.from(new Set(matches.map((s) => s.trim()).filter(Boolean))).slice(0, 500);
}

async function analyzeBundle(entry: ArtifactEntry, outDir: string): Promise<BundleAnalysis> {
  const abs = path.join(outDir, entry.localPath);
  if (entry.bytes > BUNDLE_ANALYSIS_MAX_BYTES) {
    return {
      url: entry.url,
      localPath: entry.localPath,
      prettyPath: null,
      sourceMapUrl: null,
      sourceMapPath: null,
      endpoints: [],
      modelUrls: [],
      shaderCandidates: [],
      symbols: { analysisSkippedBytes: entry.bytes },
    };
  }
  const text = fs.readFileSync(abs, "utf8");
  const analysisDir = path.join(outDir, "analysis", "bundles");
  fs.mkdirSync(analysisDir, { recursive: true });

  let prettyPath: string | null = null;
  if (entry.bytes <= PRETTIER_MAX_BYTES) {
    try {
      const formatted = await prettierFormat(text, { parser: "babel" });
      const prettyAbs = path.join(analysisDir, `${safeSeg(path.basename(abs))}.pretty.js`);
      fs.writeFileSync(prettyAbs, formatted);
      prettyPath = path.relative(outDir, prettyAbs);
    } catch {
      // Minified vendor bundles can contain syntax Prettier does not like; keep raw.
    }
  }

  const sourceMap = /\/\/# sourceMappingURL=([^\s]+)/.exec(text)?.[1] ?? null;
  const urls = Array.from(new Set(text.match(URL_RE) ?? []));
  const shaderCandidates = entry.bytes <= SHADER_SCAN_MAX_BYTES ? extractQuotedShaderCandidates(text) : [];
  const symbols = countSymbols(text, [
    "getUserMedia",
    "mediaDevices",
    "WebGL",
    "WebGL2",
    "THREE",
    "shader",
    "texture",
    "PBR",
    "wasm",
    "mnn",
    "detector",
    "tracking",
    "canvas",
    "readPixels",
    "drawArrays",
    "drawElements",
  ]);

  return {
    url: entry.url,
    localPath: entry.localPath,
    prettyPath,
    sourceMapUrl: sourceMap,
    sourceMapPath: null,
    endpoints: urls.filter((u) => /\.action(?:\?|$)|\/api\//i.test(u)).slice(0, 300),
    modelUrls: urls.filter((u) => MODEL_RE.test(u)).slice(0, 300),
    shaderCandidates: shaderCandidates.slice(0, 100),
    symbols,
  };
}

function extractQuotedShaderCandidates(text: string): string[] {
  const out: string[] = [];
  const quoted = text.match(/(["'`])(?:\\.|(?!\1)[\s\S]){20,4000}\1/g) ?? [];
  for (const raw of quoted) {
    const unwrapped = raw.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    if (SHADER_RE.test(unwrapped)) out.push(unwrapped.slice(0, 4000));
  }
  return Array.from(new Set(out));
}

function countSymbols(text: string, symbols: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sym of symbols) {
    counts[sym] = (text.match(new RegExp(sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) ?? []).length;
  }
  return counts;
}

async function fetchSourceMaps(
  bundles: BundleAnalysis[],
  outDir: string,
  assetsDir: string,
): Promise<ArResults["analysis"]["sourcemaps"]> {
  const withMaps = bundles.filter((bundle) => bundle.sourceMapUrl);
  const checks = withMaps.map(async (bundle): Promise<ArResults["analysis"]["sourcemaps"][number]> => {
    const mapUrl = new URL(bundle.sourceMapUrl!, bundle.url).href;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOURCEMAP_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(mapUrl, { signal: controller.signal });
      if (!res.ok) {
        return { source: bundle.url, url: mapUrl, localPath: null, status: "missing", error: `HTTP ${res.status}` };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const dest = localPathForUrl(mapUrl, assetsDir);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      const rel = path.relative(outDir, dest);
      bundle.sourceMapPath = rel;
      return { source: bundle.url, url: mapUrl, localPath: rel, status: "found" };
    } catch (err) {
      return { source: bundle.url, url: mapUrl, localPath: null, status: "error", error: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  });
  return Promise.all(checks);
}

async function analyzeWasm(entry: ArtifactEntry, outDir: string): Promise<WasmAnalysis> {
  const abs = path.join(outDir, entry.localPath);
  const buf = fs.readFileSync(abs);
  const wasmDir = path.join(outDir, "analysis", "wasm");
  fs.mkdirSync(wasmDir, { recursive: true });
  const strings = extractStrings(buf, 6).filter((s) => /[A-Za-z_]/.test(s)).slice(0, 300);
  const base = safeSeg(path.basename(abs));
  const result: WasmAnalysis = { url: entry.url, localPath: entry.localPath, watPath: null, binaryenTextPath: null, imports: [], exports: [], strings };

  if (entry.bytes > WASM_TEXT_MAX_BYTES) {
    result.error = `wasm text/decompile skipped: ${entry.bytes} bytes exceeds ${WASM_TEXT_MAX_BYTES} byte cap`;
    return result;
  }

  try {
    const wabtModule = (await import("wabt")).default;
    const wabt = await wabtModule();
    const mod = wabt.readWasm(buf, { readDebugNames: true, check: false });
    mod.generateNames();
    mod.applyNames();
    const wat = mod.toText({ foldExprs: false, inlineExport: false });
    mod.destroy();
    const watAbs = path.join(wasmDir, `${base}.wat`);
    fs.writeFileSync(watAbs, wat);
    result.watPath = path.relative(outDir, watAbs);
    result.imports = Array.from(wat.matchAll(/\(import\s+"([^"]+)"\s+"([^"]+)"/g)).map((m) => `${m[1]}.${m[2]}`).slice(0, 500);
    result.exports = Array.from(wat.matchAll(/\(export\s+"([^"]+)"/g)).map((m) => m[1]!).slice(0, 500);
  } catch (err) {
    result.error = `wabt: ${(err as Error).message}`;
  }

  try {
    const binaryenModule = await import("binaryen");
    const binaryen = (binaryenModule.default ?? binaryenModule) as unknown as {
      readBinary(data: Uint8Array): { emitText(): string; dispose(): void };
    };
    const mod = binaryen.readBinary(new Uint8Array(buf));
    const text = mod.emitText();
    mod.dispose();
    const binAbs = path.join(wasmDir, `${base}.binaryen.wat`);
    fs.writeFileSync(binAbs, text);
    result.binaryenTextPath = path.relative(outDir, binAbs);
  } catch (err) {
    result.error = [result.error, `binaryen: ${(err as Error).message}`].filter(Boolean).join("; ");
  }

  return result;
}

function analyzeMnn(entry: ArtifactEntry, outDir: string): MnnAnalysis {
  const abs = path.join(outDir, entry.localPath);
  const buf = fs.readFileSync(abs);
  const strings = extractStrings(buf, 3).filter((s) => /[A-Za-z_]/.test(s)).slice(0, 500);
  const likelyNames = strings
    .filter((s) => /(input|output|conv|pool|relu|softmax|detector|palm|hand|nail|tensor|heatmap|landmark|seg|mask|model)/i.test(s))
    .slice(0, 200);
  const dir = path.join(outDir, "analysis", "mnn");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${safeSeg(path.basename(abs))}.strings.txt`), strings.join("\n"));
  return {
    url: entry.url,
    localPath: entry.localPath,
    bytes: entry.bytes,
    sha256: entry.sha256,
    strings,
    likelyNames,
    note: "MNN graph parsing is metadata-only in trawl-ar. Open this file in Netron or MNN tooling for graph inspection when available.",
  };
}

async function analyzeArtifacts(results: ArResults): Promise<void> {
  const bundles = results.artifacts.filter((a) => a.kind === "script");
  for (const entry of bundles) {
    try {
      results.analysis.bundles.push(await analyzeBundle(entry, results.outDir));
    } catch (err) {
      results.notes.push(`Bundle analysis failed for ${entry.url}: ${(err as Error).message}`);
    }
  }
  results.analysis.sourcemaps = await fetchSourceMaps(results.analysis.bundles, results.outDir, path.join(results.outDir, "assets"));

  for (const entry of results.artifacts.filter((a) => a.kind === "wasm")) {
    results.analysis.wasm.push(await analyzeWasm(entry, results.outDir));
  }
  for (const entry of results.artifacts.filter((a) => a.kind === "mnn")) {
    results.analysis.mnn.push(analyzeMnn(entry, results.outDir));
  }

  const endpointSet = new Set<string>();
  const shaders: { source: string; value: string }[] = [];
  for (const bundle of results.analysis.bundles) {
    for (const endpoint of bundle.endpoints) endpointSet.add(endpoint);
    for (const shader of bundle.shaderCandidates) shaders.push({ source: bundle.url, value: shader });
  }
  results.analysis.endpoints = Array.from(endpointSet).sort();
  results.analysis.shaders = shaders;
}

function writeDeviceNotes(outDir: string, opts: ArOptions): void {
  const text = `# trawl-ar device notes

## Desktop

Run headed Chrome with a real camera:

\`\`\`bash
trawl-ar ${opts.url} --click "text=TRY ON" --i-am-authorized --device desktop --camera real
\`\`\`

## Android Chrome

1. Enable Developer Options and USB debugging.
2. Connect the device and run \`adb forward tcp:9222 localabstract:chrome_devtools_remote\`.
3. Open the AR page in Chrome on the device.
4. Run:

\`\`\`bash
trawl-ar ${opts.url} --device android --cdp-url http://127.0.0.1:9222 --click "text=TRY ON" --i-am-authorized
\`\`\`

## iOS Safari

Safari Web Inspector cannot be automated by Playwright like Chrome. Capture manually:

1. Enable Develop menu in macOS Safari.
2. Enable Web Inspector on iPhone.
3. Open the AR page on iPhone Safari and grant camera permission.
4. Use Safari Develop > iPhone > page to export network data/screenshots/timelines.
5. Merge exported files:

\`\`\`bash
trawl-ar ${opts.url} --device ios --import-ios-artifacts ./safari-export --i-am-authorized
\`\`\`

## Privacy

Full capture may include user camera frames, screenshots, session video, API responses, models, and scripts. Use only with authorization.
`;
  fs.writeFileSync(path.join(outDir, "device-notes.md"), text);
}

function makeInitialResults(opts: ArOptions): ArResults {
  return {
    schemaVersion: 1,
    kind: "trawl-ar",
    url: opts.url,
    runStamp: nowStamp(),
    device: opts.device,
    camera: opts.camera,
    clicks: opts.clicks,
    durationMs: 0,
    outDir: opts.outDir,
    summary: { network: 0, artifacts: 0, scripts: 0, wasm: 0, mnn: 0, shaderCandidates: 0, consoleErrors: 0, pageErrors: 0 },
    artifacts: [],
    network: [],
    console: [],
    runtime: null,
    analysis: { bundles: [], wasm: [], mnn: [], endpoints: [], shaders: [], sourcemaps: [] },
    notes: [],
  };
}

async function importIosArtifacts(opts: ArOptions): Promise<ArResults> {
  const results = makeInitialResults(opts);
  fs.mkdirSync(opts.outDir, { recursive: true });
  writeDeviceNotes(opts.outDir, opts);
  if (!opts.importIosArtifacts || !fs.existsSync(opts.importIosArtifacts)) {
    results.notes.push("No iOS artifact directory found; report shell created with workflow notes only.");
    return results;
  }
  const dest = path.join(opts.outDir, "ios-import");
  fs.cpSync(opts.importIosArtifacts, dest, { recursive: true });
  results.notes.push(`Imported iOS artifacts from ${opts.importIosArtifacts}`);
  results.artifacts = listImportedFiles(dest, opts.outDir);
  await analyzeArtifacts(results);
  finalizeSummary(results);
  return results;
}

function listImportedFiles(root: string, outDir: string): ArtifactEntry[] {
  const entries: ArtifactEntry[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs);
      else {
        const buf = fs.readFileSync(abs);
        const rel = path.relative(outDir, abs);
        entries.push({
          url: rel,
          localPath: rel,
          kind: classifyArtifact(abs, null),
          contentType: null,
          bytes: buf.length,
          sha256: sha256(buf),
        });
      }
    }
  };
  walk(root);
  return entries;
}

async function runCapture(opts: ArOptions): Promise<ArResults> {
  const results = makeInitialResults(opts);
  const started = Date.now();
  const assetsDir = path.join(opts.outDir, "assets");
  const mediaDir = path.join(opts.outDir, "media");
  const screenshotsDir = path.join(mediaDir, "screenshots");
  const framesDir = path.join(mediaDir, "frames");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });
  writeDeviceNotes(opts.outDir, opts);

  const harPath = path.join(opts.outDir, "network.har");
  const seenArtifacts = new Map<string, ArtifactEntry>();
  const pending: Promise<void>[] = [];
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    if (opts.cdpUrl) {
      browser = await chromium.connectOverCDP(opts.cdpUrl);
    } else {
      const args = opts.camera === "fake"
        ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--enable-webgl", "--ignore-gpu-blocklist"]
        : ["--autoplay-policy=no-user-gesture-required", "--enable-webgl", "--ignore-gpu-blocklist"];
      browser = await chromium.launch({ headless: !opts.headed, args });
    }

    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      userAgent: opts.userAgent,
      permissions: opts.camera === "none" ? [] : ["camera"],
      storageState: opts.authStorage ?? undefined,
      recordHar: { path: harPath, content: "embed" },
      recordVideo: { dir: mediaDir, size: { width: 1440, height: 1000 } },
    });
    await context.addInitScript(runtimeProbeScript());
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

    const page = await context.newPage();
    page.on("console", (msg) => {
      results.console.push({
        type: msg.type(),
        text: msg.text(),
        location: msg.location().url ? `${msg.location().url}:${msg.location().lineNumber}:${msg.location().columnNumber}` : undefined,
        ts: new Date().toISOString(),
      });
    });
    page.on("pageerror", (err) => {
      results.console.push({ type: "pageerror", text: err.message, stack: err.stack, ts: new Date().toISOString() });
    });
    page.on("requestfailed", (req) => {
      results.network.push({
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        status: null,
        contentType: null,
        bytes: null,
        fromCache: false,
        artifact: false,
        localPath: null,
        error: req.failure()?.errorText,
      });
    });
    page.on("response", (resp) => {
      const task = (async () => {
        const req = resp.request();
        const contentType = resp.headers()["content-type"] ?? null;
        const saved = await maybeSaveArtifact(resp, opts, assetsDir, seenArtifacts);
        results.network.push({
          url: resp.url(),
          method: req.method(),
          resourceType: req.resourceType(),
          status: resp.status(),
          contentType,
          bytes: saved.bytes ?? (Number(resp.headers()["content-length"] ?? "") || null),
          fromCache: resp.fromServiceWorker(),
          artifact: saved.artifact,
          localPath: saved.localPath,
          error: saved.error,
        });
      })();
      pending.push(task);
    });

    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    for (const selector of opts.clicks) {
      await page.locator(selector).first().click({ timeout: 20000 });
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(opts.waitMs);

    results.runtime = await collectRuntime(page);
    fs.writeFileSync(path.join(opts.outDir, "runtime-metrics.json"), JSON.stringify(results.runtime, null, 2));
    await page.screenshot({ path: path.join(screenshotsDir, "page.png"), fullPage: true }).catch(() => {});
    await saveCanvasFrames(page, framesDir).catch((err) => results.notes.push(`Canvas frame capture failed: ${(err as Error).message}`));
    await context.tracing.stop({ path: path.join(opts.outDir, "trace.zip") }).catch((err) => results.notes.push(`Trace save failed: ${(err as Error).message}`));
  } finally {
    await Promise.allSettled(pending);
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  results.artifacts = Array.from(seenArtifacts.values()).sort((a, b) => a.url.localeCompare(b.url));
  await analyzeArtifacts(results);
  results.durationMs = Date.now() - started;
  finalizeSummary(results);
  return results;
}

function finalizeSummary(results: ArResults): void {
  results.summary.network = results.network.length;
  results.summary.artifacts = results.artifacts.length;
  results.summary.scripts = results.artifacts.filter((a) => a.kind === "script").length;
  results.summary.wasm = results.artifacts.filter((a) => a.kind === "wasm").length;
  results.summary.mnn = results.artifacts.filter((a) => a.kind === "mnn").length;
  results.summary.shaderCandidates = results.analysis.shaders.length;
  results.summary.consoleErrors = results.console.filter((c) => c.type === "error").length;
  results.summary.pageErrors = results.console.filter((c) => c.type === "pageerror").length;
}

function writeReport(results: ArResults): void {
  const out = results.outDir;
  fs.writeFileSync(path.join(out, "console.json"), JSON.stringify(results.console, null, 2));
  fs.writeFileSync(path.join(out, "analysis", "endpoints.json"), JSON.stringify(results.analysis.endpoints, null, 2));
  fs.writeFileSync(path.join(out, "analysis", "shaders.json"), JSON.stringify(results.analysis.shaders, null, 2));
  fs.writeFileSync(path.join(out, "analysis", "sourcemaps.json"), JSON.stringify(results.analysis.sourcemaps, null, 2));
  fs.writeFileSync(path.join(out, "ar-results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(out, "report.html"), renderHtml(results));
}

function renderHtml(results: ArResults): string {
  const chips = [
    ["Artifacts", results.summary.artifacts],
    ["Scripts", results.summary.scripts],
    ["WASM", results.summary.wasm],
    ["MNN", results.summary.mnn],
    ["Shaders", results.summary.shaderCandidates],
    ["Console errors", results.summary.consoleErrors + results.summary.pageErrors],
  ];
  const metric = results.runtime;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>trawl-ar report</title>
  <style>
    body { margin: 0; font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; color: #e5e7eb; background: #111318; }
    main { max-width: 1180px; margin: 0 auto; padding: 28px 20px 60px; }
    h1, h2, h3 { line-height: 1.15; }
    a { color: #93c5fd; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .muted { color: #9ca3af; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0; }
    .chip { border: 1px solid #303642; border-radius: 6px; padding: 8px 10px; background: #181b22; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    section { margin-top: 28px; }
    table { width: 100%; border-collapse: collapse; background: #151820; }
    th, td { border-bottom: 1px solid #2a2f3a; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { color: #cbd5e1; background: #1b1f29; }
    .url { word-break: break-all; }
    pre { overflow: auto; background: #0d0f14; border: 1px solid #2a2f3a; border-radius: 6px; padding: 10px; }
  </style>
</head>
<body><main>
  <h1>trawl-ar report</h1>
  <p class="muted">${escapeHtml(results.url)} · ${escapeHtml(results.device)} · camera ${escapeHtml(results.camera)} · ${Math.round(results.durationMs / 1000)}s</p>
  <div class="chips">${chips.map(([k, v]) => `<div class="chip"><strong>${escapeHtml(String(v))}</strong><br><span class="muted">${escapeHtml(String(k))}</span></div>`).join("")}</div>

  <section>
    <h2>Runtime</h2>
    ${metric ? `<div class="grid">
      <div class="chip"><strong>${metric.fpsApprox ?? "n/a"}</strong><br><span class="muted">Approx FPS</span></div>
      <div class="chip"><strong>${metric.firstCanvasFrameMs == null ? "n/a" : `${Math.round(metric.firstCanvasFrameMs)} ms`}</strong><br><span class="muted">First canvas frame</span></div>
      <div class="chip"><strong>${metric.canvases.length}</strong><br><span class="muted">Canvases</span></div>
      <div class="chip"><strong>${metric.videos.length}</strong><br><span class="muted">Videos</span></div>
    </div>
    <h3>WebGL Calls</h3><pre>${escapeHtml(JSON.stringify(metric.webgl, null, 2))}</pre>` : `<p>No runtime metrics captured.</p>`}
  </section>

  <section>
    <h2>Endpoints</h2>
    <ul>${results.analysis.endpoints.slice(0, 200).map((u) => `<li class="url">${escapeHtml(u)}</li>`).join("")}</ul>
  </section>

  <section>
    <h2>Artifacts</h2>
    <table><thead><tr><th>Kind</th><th>Bytes</th><th>Local</th><th>URL</th></tr></thead><tbody>
      ${results.artifacts.map((a) => `<tr><td>${escapeHtml(a.kind)}</td><td>${a.bytes}</td><td>${escapeHtml(a.localPath)}</td><td class="url">${escapeHtml(a.url)}</td></tr>`).join("")}
    </tbody></table>
  </section>

  <section>
    <h2>Bundles</h2>
    <table><thead><tr><th>Bundle</th><th>Pretty</th><th>Models</th><th>Shader candidates</th></tr></thead><tbody>
      ${results.analysis.bundles.map((b) => `<tr><td class="url">${escapeHtml(b.url)}</td><td>${b.prettyPath ? escapeHtml(b.prettyPath) : "n/a"}</td><td>${b.modelUrls.length}</td><td>${b.shaderCandidates.length}</td></tr>`).join("")}
    </tbody></table>
  </section>

  <section>
    <h2>WASM</h2>
    <table><thead><tr><th>URL</th><th>WAT</th><th>Binaryen</th><th>Imports</th><th>Exports</th></tr></thead><tbody>
      ${results.analysis.wasm.map((w) => `<tr><td class="url">${escapeHtml(w.url)}</td><td>${escapeHtml(w.watPath ?? "n/a")}</td><td>${escapeHtml(w.binaryenTextPath ?? "n/a")}</td><td>${w.imports.length}</td><td>${w.exports.length}</td></tr>`).join("")}
    </tbody></table>
  </section>

  <section>
    <h2>MNN</h2>
    <p class="muted">MNN files are captured and string-indexed. Open them in Netron or MNN tooling for graph inspection.</p>
    <table><thead><tr><th>URL</th><th>Bytes</th><th>Likely names</th></tr></thead><tbody>
      ${results.analysis.mnn.map((m) => `<tr><td class="url">${escapeHtml(m.url)}</td><td>${m.bytes}</td><td>${escapeHtml(m.likelyNames.slice(0, 20).join(", "))}</td></tr>`).join("")}
    </tbody></table>
  </section>

  <section>
    <h2>Notes</h2>
    <ul>${results.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>
  </section>
</main></body></html>`;
}

async function main(): Promise<void> {
  const opts = parseCli();
  if (!opts.authorized) {
    console.error("trawl-ar: full AR capture can include camera frames, screenshots, session video, proprietary model assets, and API responses.");
    console.error("trawl-ar: rerun with --i-am-authorized only when you have permission to capture this target.");
    process.exit(1);
  }

  fs.mkdirSync(path.join(opts.outDir, "analysis"), { recursive: true });
  let results: ArResults;
  if (opts.device === "ios" || opts.importIosArtifacts) {
    results = await importIosArtifacts(opts);
  } else {
    results = await runCapture(opts);
  }
  writeReport(results);
  console.log(`\nDone (trawl-ar). Output: ${opts.outDir}`);
  console.log(`Report: ${path.join(opts.outDir, "report.html")}`);
}

main().catch((err) => {
  console.error(`trawl-ar: ${(err as Error).stack || (err as Error).message}`);
  process.exit(1);
});
