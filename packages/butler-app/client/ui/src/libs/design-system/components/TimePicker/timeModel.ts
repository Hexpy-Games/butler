// Pure TimePicker logic: locale facts from Intl, segment typing and stepping.
export type HourCycle = "h12" | "h23";
export type Segment = "period" | "hour" | "minute";
export interface TimeParts { hours: number; minutes: number }

export function parseTime(value: string): TimeParts {
  const [h, m] = value.split(":").map(Number);
  return { hours: Number.isInteger(h) ? Math.min(23, Math.max(0, h!)) : 0, minutes: Number.isInteger(m) ? Math.min(59, Math.max(0, m!)) : 0 };
}

export const pad = (n: number) => String(n).padStart(2, "0");
export const formatTime = (parts: TimeParts) => `${pad(parts.hours)}:${pad(parts.minutes)}`;

/** h12 for locales that show a day period (ko 오전/오후, en-US AM/PM), h23 otherwise (en-GB, de). */
export function localeHourCycle(locale: string): HourCycle {
  const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h11" || cycle === "h12" ? "h12" : "h23";
}

const sample = (hours: number) => new Date(2000, 0, 1, hours, 0);

/** The locale's own day-period words: ["오전", "오후"] or ["AM", "PM"]. */
export function dayPeriods(locale: string): [string, string] {
  const word = (hours: number) => new Intl.DateTimeFormat(locale, { hour: "numeric", hourCycle: "h12" })
    .formatToParts(sample(hours)).find((part) => part.type === "dayPeriod")?.value ?? (hours < 12 ? "AM" : "PM");
  return [word(9), word(21)];
}

/** Segment order and the separator between hour and minute, as the locale writes a time. */
export function segmentLayout(locale: string, cycle: HourCycle): { order: Segment[]; separator: string } {
  const parts = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: cycle }).formatToParts(sample(9));
  const order = parts.flatMap((part): Segment[] => part.type === "hour" ? ["hour"] : part.type === "minute" ? ["minute"]
    : part.type === "dayPeriod" && cycle === "h12" ? ["period"] : []);
  const hourIndex = parts.findIndex((part) => part.type === "hour");
  const separator = parts[hourIndex + 1]?.type === "literal" ? parts[hourIndex + 1]!.value.trim() || ":" : ":";
  return { order, separator };
}

/** Localized field names ("시", "분", "오전/오후"), used as accessible names. */
export function segmentNames(locale: string): Record<Segment, string> {
  try {
    const names = new Intl.DisplayNames(locale, { type: "dateTimeField" });
    return { hour: names.of("hour") ?? "Hour", minute: names.of("minute") ?? "Minute", period: names.of("dayPeriod") ?? "AM/PM" };
  } catch {
    return { hour: "Hour", minute: "Minute", period: "AM/PM" };
  }
}

export const isPm = (parts: TimeParts) => parts.hours >= 12;
export const hour12 = (hours: number) => (hours % 12) || 12;
export const withHour12 = (parts: TimeParts, h12: number, pm = isPm(parts)): TimeParts => ({ ...parts, hours: (h12 % 12) + (pm ? 12 : 0) });

/** ArrowUp/ArrowDown on one segment; each segment wraps on its own (the hour keeps its day period, as native time fields do). */
export function stepSegment(segment: Segment, cycle: HourCycle, parts: TimeParts, step: number): TimeParts {
  if (segment === "period") return { ...parts, hours: (parts.hours + 12) % 24 };
  if (segment === "minute") return { ...parts, minutes: (parts.minutes + step + 60) % 60 };
  if (cycle === "h23") return { ...parts, hours: (parts.hours + step + 24) % 24 };
  return withHour12(parts, ((hour12(parts.hours) - 1 + step + 12) % 12) + 1);
}

export interface TypeResult { parts: TimeParts; pending: string; advance: boolean }

/** One typed digit (the openstatus/shadcn segment rule): a second digit completes the value, an impossible first digit completes at once. */
export function typeDigit(segment: "hour" | "minute", cycle: HourCycle, parts: TimeParts, pending: string, digit: number): TypeResult {
  if (segment === "minute") {
    if (pending) return { parts: { ...parts, minutes: Number(pending + digit) }, pending: "", advance: true };
    return digit > 5 ? { parts: { ...parts, minutes: digit }, pending: "", advance: true } : { parts: { ...parts, minutes: digit }, pending: String(digit), advance: false };
  }
  if (cycle === "h23") {
    if (pending) {
      const value = Number(pending + digit);
      return value <= 23 ? { parts: { ...parts, hours: value }, pending: "", advance: true } : { parts: { ...parts, hours: digit }, pending: "", advance: digit > 2 };
    }
    return { parts: { ...parts, hours: digit }, pending: digit > 2 ? "" : String(digit), advance: digit > 2 };
  }
  if (pending === "0") return digit === 0 ? { parts, pending, advance: false } : { parts: withHour12(parts, digit), pending: "", advance: true };
  if (pending === "1" && digit <= 2) return { parts: withHour12(parts, 10 + digit), pending: "", advance: true };
  if (digit === 0) return { parts, pending: "0", advance: false };
  if (digit === 1) return { parts: withHour12(parts, 1), pending: "1", advance: false };
  return { parts: withHour12(parts, digit), pending: "", advance: true };
}
