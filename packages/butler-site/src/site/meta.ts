/** Site-wide facts. The version comes from the repository VERSION file (astro.config.ts). */
export const REPOSITORY_URL = "https://github.com/Hexpy-Games/butler";
export const BUTLER_VERSION: string = import.meta.env.BUTLER_VERSION ?? "";

/** Support mailbox: the privacy policy's contact. */
export const SUPPORT_MAILBOX = "support@hexpy.games";

/** A build-time value, or undefined when it is unset or blank. */
function buildValue(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/**
 * Privacy policy facts shown on /privacy/ and /en/privacy/. The officer's
 * names come from the build environment (site.yml passes the repository
 * variables SITE_PRIVACY_OFFICER_KO and SITE_PRIVACY_OFFICER_EN), so they are
 * not stored in the repository. An unset value leaves that part of the page out.
 */
export const PRIVACY_POLICY: { effectiveDate?: string; officer: { ko?: string; en?: string } } = {
  /** The app's Store publication date (YYYY-MM-DD), shown as is; while unset the page has no effective-date line. */
  effectiveDate: undefined,
  officer: { ko: buildValue(process.env.SITE_PRIVACY_OFFICER_KO), en: buildValue(process.env.SITE_PRIVACY_OFFICER_EN) },
};
