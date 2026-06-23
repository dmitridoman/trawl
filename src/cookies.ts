import type { Page } from "playwright";

const VENDOR_SELECTORS = [
  "#onetrust-accept-btn-handler",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#CybotCookiebotDialogBodyLevelButtonAccept",
  ".osano-cm-accept-all",
  ".osano-cm-accept",
  '.qc-cmp2-summary-buttons button[mode="primary"]',
  ".iubenda-cs-accept-btn",
  "#didomi-notice-agree-button",
  ".cky-btn-accept",
  ".truste-button2",
  ".truste-consent-button",
  ".evidon-banner-acceptbutton",
  "#hs-eu-confirmation-button",
];

const ACCEPT_TEXT_RE =
  /^\s*(accept all|accept|i accept|agree|i agree|allow all|allow|got it|ok|okay|continue|accepter tout|tout accepter|accepter|j['’]accepte|aceptar todo|aceptar|acepto|akzeptieren|alle akzeptieren|zustimmen|accetta tutto|accetta|accetto|alles accepteren|accepteren|akkoord|aceitar tudo|aceitar|concordo)\s*$/i;

// In-page accept matcher — kept loose because custom banners label the button
// in many ways. Mirrors ACCEPT_TEXT_RE but as a source string for evaluate().
const ACCEPT_SOURCE =
  "^\\s*(accept all|accept|i accept|agree|i agree|allow all|allow|got it|ok|okay|continue|yes,? i('m| am) happy|that's ok|sounds good|accepter tout|tout accepter|accepter|j['’]accepte|aceptar todo|aceptar|acepto|akzeptieren|alle akzeptieren|zustimmen|accetta tutto|accetta|accetto|alles accepteren|accepteren|akkoord|aceitar tudo|aceitar|concordo)\\s*$";

export async function dismissCookieBanner(page: Page): Promise<boolean> {
  try {
    for (const sel of VENDOR_SELECTORS) {
      try {
        const loc = page.locator(sel).first();
        await loc.click({ timeout: 800 });
        await page.waitForTimeout(300);
        return true;
      } catch {
        // try next
      }
    }

    // Role-based accept (covers <button>, role="button", inputs).
    try {
      await page
        .getByRole("button", { name: ACCEPT_TEXT_RE })
        .first()
        .click({ timeout: 600 });
      await page.waitForTimeout(300);
      return true;
    } catch {
      // no match
    }

    // Custom banners often use <a> / <div> / <span> for the accept control,
    // which role="button" misses. Sweep clickable elements in-page and click
    // the first visible one whose text reads like an accept action and that
    // lives inside a cookie/consent container.
    try {
      const clicked = await page.evaluate((acceptSource) => {
        const accept = new RegExp(acceptSource, "i");
        const KW = /(cookie|consent|gdpr|ccpa|privacy)/i;
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            'button, a, [role="button"], input[type="button"], input[type="submit"], [class*="accept" i], [id*="accept" i]',
          ),
        );
        for (const el of candidates) {
          const label = (el.textContent || (el as HTMLInputElement).value || "").trim();
          if (!accept.test(label)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          // Only accept if it sits within something that looks consent-related,
          // to avoid clicking an unrelated "OK"/"Continue" button elsewhere.
          let ctx: HTMLElement | null = el;
          let inBanner = false;
          for (let i = 0; i < 6 && ctx; i++) {
            const id = ctx.id || "";
            const cls = typeof ctx.className === "string" ? ctx.className : "";
            if (KW.test(id) || KW.test(cls) || KW.test((ctx.textContent || "").slice(0, 300))) {
              inBanner = true;
              break;
            }
            ctx = ctx.parentElement;
          }
          if (!inBanner) continue;
          (el as HTMLElement).click();
          return true;
        }
        return false;
      }, ACCEPT_SOURCE);
      if (clicked) {
        await page.waitForTimeout(300);
        return true;
      }
    } catch {
      // ignore
    }

    return false;
  } catch {
    return false;
  }
}

// Belt-and-braces for screenshots: hide any fixed/sticky overlay that reads like
// a cookie/consent banner, regardless of vendor. Runs after the click attempt so
// banners that re-render or appear late don't end up in the shot.
export async function hideCookieBanners(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      // Specific, low-false-positive phrasing for consent UI.
      const STRONG =
        /(we use[^.]{0,60}cookies|uses? cookies|this (site|website) uses cookies|cookie (settings|preferences|consent|policy|notice|choices)|manage cookies|analytics cookies|accept[^.]{0,20}cookies|consent (preferences|manager)|your privacy choices)/i;
      const ACCEPTISH = /^(accept|allow|agree|got it|ok|okay|i accept|i agree)/i;
      const els = Array.from(
        document.querySelectorAll<HTMLElement>("div, section, aside, footer, form, dialog"),
      );
      for (const el of els) {
        const style = getComputedStyle(el);
        if (style.position !== "fixed" && style.position !== "sticky") continue;
        if (style.display === "none" || style.visibility === "hidden") continue;
        const txt = (el.textContent || "").slice(0, 600);
        if (!STRONG.test(txt)) continue;
        // Soft confirmation: most real banners carry an accept-style control.
        const hasAccept = Array.from(
          el.querySelectorAll<HTMLElement>('button, a, [role="button"], input'),
        ).some((b) => ACCEPTISH.test((b.textContent || (b as HTMLInputElement).value || "").trim()));
        // Hide if it has an accept control, or is anchored to a screen edge
        // (the classic bottom/top cookie bar) — either is a strong banner signal.
        const rect = el.getBoundingClientRect();
        const edgeAnchored =
          rect.top <= 4 || Math.abs(rect.bottom - window.innerHeight) <= 4 || rect.bottom <= 4;
        if (hasAccept || edgeAnchored) {
          el.style.setProperty("display", "none", "important");
        }
      }
    });
  } catch {
    // best effort
  }
}
