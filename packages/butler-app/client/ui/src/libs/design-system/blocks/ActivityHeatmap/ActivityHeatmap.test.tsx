import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityHeatmap } from "./ActivityHeatmap";

test("density bands distinguish missing history, zero, and fixed count thresholds", () => {
  const counts = [null, 0, 1, 2, 4, 5, 9, 10, 100];
  const html = renderToStaticMarkup(<ActivityHeatmap days={counts.map((count, index) => ({
    id: String(index), label: `Day ${index}`, count,
  }))} />);
  expect([...html.matchAll(/data-level="([^"]+)"/g)].map(match => match[1])).toEqual([
    "unknown", "0", "1", "2", "2", "3", "3", "4", "4",
  ]);
});

test("calendar offset precedes dates and selected days retain native button semantics", () => {
  const html = renderToStaticMarkup(<ActivityHeatmap startWeekday={3} selectedId="first"
    onSelect={() => undefined} days={[{ id: "first", label: "September 9", count: 2 }]} />);
  expect((html.match(/aria-hidden="true"/g) ?? []).length).toBe(3);
  expect(html).toContain("<button");
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('aria-label="September 9: 2"');
});

test("calendar provides month and weekday axes and labels tied to the same swatch levels", () => {
  const html = renderToStaticMarkup(<ActivityHeatmap startWeekday={2}
    weekdayLabels={["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]}
    legend={{ title: "Items per day", labels: ["0 items", "1 item", "2–4 items", "5–9 items", "10+ items", "Unavailable"] }}
    days={[{ id: "d", label: "Sep 8", monthLabel: "Sep", count: 4, countLabel: "4 items" }]} />);
  expect(html).toContain("Sep</span>");
  expect(html).toContain("Tue</span>");
  expect(html).toContain("Items per day");
  expect(html).toContain('aria-label="Sep 8: 4 items"');
  expect([...html.matchAll(/data-level="([^"]+)"/g)].map(match => match[1])).toEqual(["2", "0", "1", "2", "3", "4", "unknown"]);
});
