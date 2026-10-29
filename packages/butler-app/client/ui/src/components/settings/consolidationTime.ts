/** Local calendar days (including DST boundaries), with app-locale time formatting. */
export function formatConsolidationTime(at: string, locale: string, words: { today: string; yesterday: string }, now = new Date()) {
  const date = new Date(at);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const day = sameDay(date, now) ? words.today : sameDay(date, yesterday) ? words.yesterday
    : new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(date);
  return `${day} ${new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date)}`;
}
