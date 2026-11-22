// Desktop: components/usage/compactTokens.ts.
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

// Desktop memory operations use crypto.randomUUID; Hermes needs the RFC 4122 v4 equivalent.
export function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, digit => {
    const random = Math.floor(Math.random() * 16);
    return (digit === "x" ? random : (random & 3) | 8).toString(16);
  });
}

// Desktop TimePicker: two-digit hour/minute values.
export function pad2(value: number): string { return String(value).padStart(2, "0"); }

/** "HH:MM" → a local Date on a fixed day. */
export function timeToDate(value: string): Date {
  const [h, m] = value.split(":").map(Number);
  return new Date(2000, 0, 1, h, m);
}
/** Local Date → "HH:MM" (24 h, zero-padded). */
export function dateToTime(date: Date): string { return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`; }
/** Row meta, unchanged from today: ko "오후 10:00". */
export function timeMeta(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(timeToDate(value));
}
