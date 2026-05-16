import type { LinkCheck } from "./util";

const TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 8;

type Source = { fromSlug: string; url: string };

async function checkOne(fromSlug: string, url: string, sameOrigin: (u: string) => boolean): Promise<LinkCheck> {
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
  // Dedupe by URL but keep first source slug
  const seen = new Map<string, string>();
  for (const s of sources) {
    if (!seen.has(s.url)) seen.set(s.url, s.fromSlug);
  }
  const unique: Source[] = Array.from(seen.entries()).map(([url, fromSlug]) => ({ fromSlug, url }));

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
      results[i] = await checkOne(s.fromSlug, s.url, sameOrigin);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export function linkIssues(links: LinkCheck[]): LinkCheck[] {
  return links.filter((l) => !l.ok);
}
