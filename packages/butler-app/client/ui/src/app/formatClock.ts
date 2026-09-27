const CLOCK: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/**
 * The one clock format for message footers: hour and two-digit minute in the
 * app locale ("1:25 PM", "오후 1:25"), with month and day prepended when the
 * time is not today and the year when it is not this year.
 */
export function formatClock(date: Date, locale: string, now: Date = new Date()): string {
  if (date.getFullYear() !== now.getFullYear()) {
    return new Intl.DateTimeFormat(locale, { ...CLOCK, year: "numeric", month: "short", day: "numeric" }).format(date);
  }
  if (date.getMonth() !== now.getMonth() || date.getDate() !== now.getDate()) {
    return new Intl.DateTimeFormat(locale, { ...CLOCK, month: "short", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat(locale, CLOCK).format(date);
}
