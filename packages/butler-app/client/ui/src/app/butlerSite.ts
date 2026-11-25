import type { AppLocale } from "./copy.ts";

/** Butler's website; the privacy policy lives there. */
const BUTLER_SITE_URL = "https://butler.hexpy.games";

/** The privacy policy in the app's language: Korean at /privacy/, other languages at /en/privacy/. */
export function privacyPolicyUrl(locale: AppLocale): string {
  return locale === "ko-KR" ? `${BUTLER_SITE_URL}/privacy/` : `${BUTLER_SITE_URL}/en/privacy/`;
}
