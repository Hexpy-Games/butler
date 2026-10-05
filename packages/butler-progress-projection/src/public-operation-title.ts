import { getAppCopy, type AppLocale } from "../../butler-i18n/src/index.ts";

export function publicOperationTitle(capabilityRef?: string, locale: AppLocale = "en-US"): string {
  const copy = getAppCopy(locale);
  const name = capabilityRef?.trim() ?? "";
  return copy.progress.operations[name] ?? copy.guided.tools[name] ?? copy.progress.fallback;
}
