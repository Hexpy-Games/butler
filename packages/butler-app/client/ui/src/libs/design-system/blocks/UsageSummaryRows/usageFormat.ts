const DASH = "—";
const usdCents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdSubCent = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 });

/**
 * USD in every locale: two decimals from one cent, four below one cent,
 * "<$0.0001" for a smaller non-zero amount, "—" for a missing number.
 */
export function formatUsageUsd(value: number): string {
  if (!Number.isFinite(value)) return DASH;
  const amount = Math.max(0, value);
  if (amount === 0 || amount >= 0.01) return usdCents.format(amount);
  if (amount < 0.00005) return "<$0.0001";
  return usdSubCent.format(amount);
}

function documentLocale(): string | undefined {
  return typeof document === "undefined" ? undefined : document.documentElement.lang || undefined;
}

/** Compact token count: en "12.3k", ko "1.2만"; below 1,000 the plain number. */
export function formatUsageTokens(value: number, locale: string | undefined = documentLocale()): string {
  if (!Number.isFinite(value)) return DASH;
  const count = Math.max(0, Math.round(value));
  const formatted = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(count);
  return locale?.toLowerCase().startsWith("en") || !locale ? formatted.replace(/K$/u, "k") : formatted;
}
