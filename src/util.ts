export const VIEWPORTS = [
  { name: "phone",   width: 375,  height: 812  },
  { name: "tablet",  width: 768,  height: 1024 },
  { name: "desktop", width: 1440, height: 900  },
] as const;

export const COLOR_SCHEMES = ["light", "dark"] as const;

export type PageRecord = { url: string; slug: string; title: string };

export function toSlug(url: string): string {
  const u = new URL(url);
  const clean = u.pathname.replace(/^\/|\/$/g, "").replace(/\//g, "__");
  return clean || "home";
}
