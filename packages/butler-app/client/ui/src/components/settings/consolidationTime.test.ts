// test-category: pure-logic
import { expect, test } from "bun:test";
import { formatConsolidationTime } from "./consolidationTime";

test("last-run uses local calendar day words and localized time across month boundaries", () => {
  const now = new Date(2026, 2, 1, 12);
  const words = { today: "Today", yesterday: "Yesterday" };
  for (const [date, day] of [[new Date(2026, 2, 1, 4), "Today"], [new Date(2026, 1, 28, 23, 59), "Yesterday"]] as const) {
    const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
    expect(formatConsolidationTime(date.toISOString(), "en-US", words, now)).toBe(`${day} ${time}`);
  }
});

test("older dates and Korean day words retain locale-specific date and time", () => {
  const now = new Date(2026, 9, 24, 12);
  const date = new Date(2025, 11, 31, 4, 5);
  for (const locale of ["ko-KR", "en-US"]) {
    const expected = `${new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(date)} ${new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date)}`;
    expect(formatConsolidationTime(date.toISOString(), locale, { today: "오늘", yesterday: "어제" }, now)).toBe(expected);
  }
  const today = new Date(2026, 9, 24, 4);
  expect(formatConsolidationTime(today.toISOString(), "ko-KR", { today: "오늘", yesterday: "어제" }, now)).toBe(`오늘 ${new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" }).format(today)}`);
});
