/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { EventTimeline, EventTimelineItem } from "./EventTimeline";

const css = readFileSync(new URL("./EventTimeline.module.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
}

test("EventTimeline renders each item as a marker column beside its content, with no inline style", () => {
  const document = new JSDOM(renderToStaticMarkup(
    <EventTimeline data-test-class="timeline">
      <EventTimelineItem marker={<svg data-marker="a" />}><p>First</p></EventTimelineItem>
      <EventTimelineItem marker={<svg data-marker="b" />}><p>Second</p></EventTimelineItem>
    </EventTimeline>,
  )).window.document;
  const timeline = document.querySelector('[data-test-class="timeline"]')!;
  const items = timeline.querySelectorAll('[data-slot="event-timeline-item"]');
  expect(items).toHaveLength(2);
  const [marker, content] = [...items[0]!.children];
  expect(marker!.getAttribute("data-slot")).toBe("event-timeline-marker");
  expect(marker!.querySelector('[data-marker="a"]')).not.toBeNull();
  expect(content!.textContent).toBe("First");
  expect(document.body.innerHTML).not.toContain("style=");
});

test("EventTimeline joins markers with a hairline connector from tokens only", () => {
  expect(rule(".event")).toMatch(/grid-template-columns:\s*var\(--space-2xl\)\s+minmax\(0,\s*1fr\)/u);
  expect(rule(".event:not(:last-child)::before")).toMatch(/width:\s*var\(--border-hairline\)/u);
  expect(rule(".event:not(:last-child)::before")).toMatch(/background:\s*var\(--line\)/u);
  expect(rule(".marker")).toMatch(/color:\s*var\(--text-tertiary\)/u);
  expect(css).not.toMatch(/\d+px/u);
});
