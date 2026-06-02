import type { LinkCheck } from "./util";

const TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 8;

type Source = { fromSlug: string; url: string; text?: string };
type UniqueSource = { fromSlug: string; fromSlugs: string[]; text?: string; url: string };

async function checkOne(src: UniqueSource, sameOrigin: (u: string) => boolean): Promise<LinkCheck> {
  const { url, fromSlug, fromSlugs, text } = src;
  const internal = sameOrigin(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let res: Response;
    try {
      res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
      // Some servers reject HEAD with 4xx/405; fall back to GET in that case
      if (res.status === 405 || res.status === 501 || (res.status >= 400 && res.status < 500 && !res.ok)) {
        res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
      }
    } catch {
      res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    }
    return {
      fromSlug,
      fromSlugs,
      text,
      url,
      status: res.status,
      ok: res.ok,
      redirected: res.redirected,
      finalUrl: res.url,
      internal,
    };
  } catch (err) {
    return {
      fromSlug,
      fromSlugs,
      text,
      url,
      status: null,
      ok: false,
      redirected: false,
      finalUrl: null,
      error: (err as Error).message,
      internal,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkLinks(
  sources: Source[],
  baseOrigin: string,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<LinkCheck[]> {
  // Dedupe by URL: accumulate every referring page, keep the first anchor text.
  const seen = new Map<string, { fromSlugs: string[]; text?: string }>();
  for (const s of sources) {
    const e = seen.get(s.url);
    if (e) {
      if (!e.fromSlugs.includes(s.fromSlug)) e.fromSlugs.push(s.fromSlug);
      if (e.text === undefined && s.text) e.text = s.text;
    } else {
      seen.set(s.url, { fromSlugs: [s.fromSlug], text: s.text });
    }
  }
  const unique: UniqueSource[] = Array.from(seen.entries()).map(([url, v]) => ({
    url,
    fromSlug: v.fromSlugs[0] ?? "",
    fromSlugs: v.fromSlugs,
    text: v.text,
  }));

  const sameOrigin = (u: string): boolean => {
    try {
      return new URL(u).origin === baseOrigin;
    } catch {
      return false;
    }
  };

  const results: LinkCheck[] = new Array(unique.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= unique.length) return;
      const s = unique[i]!;
      results[i] = await checkOne(s, sameOrigin);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export function linkIssues(links: LinkCheck[]): LinkCheck[] {
  return links.filter((l) => !l.ok);
}
