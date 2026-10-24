/** Shared Usage-page token notation; Korean never falls back to Latin units. */
export function compactTokens(value: number, locale: string): string {
  const amount = Math.max(0, Math.round(value));
  if (amount < 1000) return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(amount);
  const korean = locale.split("-")[0] === "ko";
  const units: [number, string][] = korean
    ? [[1e8, "억"], [1e4, "만"], [1e3, "천"]]
    : [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  let index = units.findIndex(([threshold]) => amount >= threshold);
  const rounded = (scaled: number) => korean
    ? Number(scaled.toFixed(scaled >= 100 ? 0 : 1))
    : Number(scaled.toPrecision(3));
  while (index > 0 && rounded(amount / units[index]![0]) * units[index]![0] >= units[index - 1]![0]) index--;
  const [divisor, suffix] = units[index]!;
  const scaled = amount / divisor;
  const options: Intl.NumberFormatOptions = korean
    ? { maximumFractionDigits: scaled >= 100 ? 0 : 1 }
    : { maximumSignificantDigits: 3 };
  return `${new Intl.NumberFormat(locale, options).format(scaled)}${suffix}`;
}
