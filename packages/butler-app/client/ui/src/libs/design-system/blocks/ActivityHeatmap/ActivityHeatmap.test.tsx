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
