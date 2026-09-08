import { getAppCopy, type AppLocale } from "../../butler-i18n/src/index.ts";

export function publicOperationTitle(capabilityRef?: string, locale: AppLocale = "en-US"): string {
  const copy = getAppCopy(locale).progress;
  return copy.operations[capabilityRef?.trim() ?? ""] ?? copy.fallback;
}
