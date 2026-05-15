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

    return false;
  } catch {
    return false;
  }
}
