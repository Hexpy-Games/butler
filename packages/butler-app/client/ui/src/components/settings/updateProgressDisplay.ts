import { appCopy, getAppLocale } from "@/app/copy";

/** Decimal megabytes, with the active interface locale's unit spacing. */
export function formatUpdateBytes(bytes: number, locale = getAppLocale()): string {
  const megabytes = bytes / 1_000_000;
  return new Intl.NumberFormat(locale, {
    style: "unit", unit: "megabyte", unitDisplay: "short",
    maximumFractionDigits: megabytes < 10 ? 1 : 0,
  }).format(megabytes);
}

export function updateFailureMessage(code: string | null): string {
  const copy = appCopy.settings.updateErrors;
  if (code?.startsWith("update_stage_")) return copy.storage;
  if (code === "update_activation_failed") return copy.apply;
  if (/incompatible|platform_missing|missing_platform/u.test(code ?? "")) return copy.incompatible;
  if (/checksum|sha256|signature/u.test(code ?? "")) return copy.damaged;
  if (/network|unavailable/u.test(code ?? "")) return copy.download;
  return copy.generic;
}

export function updateProgressText(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/gu, (match, key: string) => String(values[key] ?? match));
}
