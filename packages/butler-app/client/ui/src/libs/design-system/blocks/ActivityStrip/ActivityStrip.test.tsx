/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityStrip } from "./ActivityStrip";

test("ActivityStrip renders one titled cell per day and marks active days", () => {
  const document = new JSDOM(renderToStaticMarkup(
    <ActivityStrip ariaLabel="Sep 24, Sep 26" days={[
      { key: "24", label: "Sep 24", active: true },
      { key: "25", label: "Sep 25", active: false },
      { key: "26", label: "Sep 26", active: true },
    ]} />,
  )).window.document;
  const strip = document.querySelector('[data-slot="activity-strip"]')!;
  expect(strip.getAttribute("aria-label")).toBe("Sep 24, Sep 26");
  const cells = [...strip.children];
  expect(cells.map((cell) => cell.getAttribute("title"))).toEqual(["Sep 24", "Sep 25", "Sep 26"]);
  expect(cells.map((cell) => cell.getAttribute("data-active"))).toEqual(["true", null, "true"]);
});
