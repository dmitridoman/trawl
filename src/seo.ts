import type { Page } from "playwright";
import type { SeoMeta } from "./util";

export async function extractSeo(page: Page): Promise<SeoMeta> {
  return page.evaluate(() => {
    const text = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? "";
    const attr = (sel: string, name: string) =>
      (document.querySelector(sel) as HTMLElement | null)?.getAttribute(name) ?? null;

    const title = text("title");

    const metaContent = (name: string): string | null => {
      const el =
        document.querySelector(`meta[name="${name}" i]`) ||
        document.querySelector(`meta[property="${name}" i]`);
      return el?.getAttribute("content") ?? null;
    };

    const og: Record<string, string> = {};
    const twitter: Record<string, string> = {};
    document.querySelectorAll("meta").forEach((m) => {
      const prop = m.getAttribute("property") || m.getAttribute("name") || "";
      const content = m.getAttribute("content") || "";
      if (!content) return;
      if (/^og:/i.test(prop)) og[prop.toLowerCase()] = content;
      if (/^twitter:/i.test(prop)) twitter[prop.toLowerCase()] = content;
    });

    const h1s = Array.from(document.querySelectorAll("h1")).map((h) =>
      (h.textContent || "").trim(),
    );

    const imgs = Array.from(document.querySelectorAll("img"));
    const imgWithoutAlt = imgs.filter((i) => {
      const alt = i.getAttribute("alt");
      return alt === null || alt.trim() === "";
    }).length;

    const jsonLdTypes: string[] = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        const parsed = JSON.parse(s.textContent || "null");
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item && typeof item === "object") {
            const t = (item as { "@type"?: string | string[] })["@type"];
            if (Array.isArray(t)) jsonLdTypes.push(...t);
            else if (typeof t === "string") jsonLdTypes.push(t);
          }
        }
      } catch {
        // ignore malformed ld+json
      }
    });

    const description = metaContent("description");

    return {
      title,
      titleLength: title.length,
      description,
      descriptionLength: description?.length ?? 0,
      canonical: attr('link[rel="canonical"]', "href"),
      robots: metaContent("robots"),
      lang: document.documentElement.getAttribute("lang"),
      viewport: metaContent("viewport"),
      h1Count: h1s.length,
      h1Text: h1s.slice(0, 5),
      imgTotal: imgs.length,
      imgWithoutAlt,
      og,
      twitter,
      jsonLdTypes: [...new Set(jsonLdTypes)],
    };
  }) as Promise<SeoMeta>;
}

export type SeoIssue = { slug: string; severity: "warn" | "error"; message: string };

export function seoIssues(slug: string, m: SeoMeta): SeoIssue[] {
  const issues: SeoIssue[] = [];
  if (!m.title) issues.push({ slug, severity: "error", message: "missing <title>" });
  else if (m.titleLength < 10) issues.push({ slug, severity: "warn", message: `title is short (${m.titleLength} chars)` });
  else if (m.titleLength > 70) issues.push({ slug, severity: "warn", message: `title is long (${m.titleLength} chars)` });

  if (!m.description) issues.push({ slug, severity: "error", message: "missing meta description" });
  else if (m.descriptionLength < 50) issues.push({ slug, severity: "warn", message: `description is short (${m.descriptionLength} chars)` });
  else if (m.descriptionLength > 160) issues.push({ slug, severity: "warn", message: `description is long (${m.descriptionLength} chars)` });

  if (!m.canonical) issues.push({ slug, severity: "warn", message: "no canonical link" });
  if (m.h1Count === 0) issues.push({ slug, severity: "error", message: "no <h1>" });
  else if (m.h1Count > 1) issues.push({ slug, severity: "warn", message: `${m.h1Count} <h1> elements` });

  if (m.imgWithoutAlt > 0)
    issues.push({ slug, severity: "warn", message: `${m.imgWithoutAlt}/${m.imgTotal} images missing alt text` });

  if (!m.og["og:title"] && !m.og["og:image"])
    issues.push({ slug, severity: "warn", message: "no Open Graph tags" });

  if (!m.viewport) issues.push({ slug, severity: "error", message: "no viewport meta" });
  if (!m.lang) issues.push({ slug, severity: "warn", message: "no <html lang>" });

  return issues;
}
