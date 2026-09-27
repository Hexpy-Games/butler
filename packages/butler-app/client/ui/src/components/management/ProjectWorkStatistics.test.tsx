/// <reference types="bun" />

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { getAppCopy, setAppCopyLanguage } from "@/app/copy.ts";
import { ProjectStatisticsContext } from "./projectStatisticsContext.ts";
import { ProjectWorkStatistics } from "./ProjectWorkStatistics.tsx";

test("remaining-work rows put the stage label and count above the bar so long labels never overlap it", () => {
  setAppCopyLanguage("en");
  const card = (id: string, lane: string) => ({ id, lane, title: id, sourceKey: id, ageDays: 1 });
  const data = {
    ledgerHistoryAvailable: false,
    work: {
      excluded: 0,
      cards: { work: [card("a", "active"), card("b", "active"), card("c", "planned")], task: [] },
    },
  };
  const markup = renderToStaticMarkup(
    <ProjectStatisticsContext.Provider value={{ data: data as never, openSource: () => undefined }}>
      <ProjectWorkStatistics />
    </ProjectStatisticsContext.Provider>,
  );
  const document = new JSDOM(markup).window.document;
  const labels = getAppCopy("en-US").projectStatistics.labels as Record<string, string>;
  const rows = Array.from(document.querySelectorAll("button")).filter((button) =>
    button.querySelector('[role="progressbar"]'));
  expect(rows).toHaveLength(4);
  const active = rows.find((row) => row.textContent?.includes(labels.active!));
  expect(active).toBeDefined();
  const bar = active!.querySelector('[role="progressbar"]')!;
  const label = Array.from(active!.querySelectorAll("span")).find((span) => span.textContent === labels.active);
  const count = Array.from(active!.querySelectorAll("span")).find((span) => span.textContent === "2");
  expect(label).toBeDefined();
  expect(count).toBeDefined();
  // Label and count come before the bar (ProgressMeter label row), not in a fixed-width column beside it.
  expect(label!.compareDocumentPosition(bar) & 4).toBe(4);
  expect(count!.compareDocumentPosition(bar) & 4).toBe(4);
  // The statistics panels own no stylesheet: chart height and day strips are DS props.
  expect(existsSync(new URL("./ProjectStatisticsPanel.module.css", import.meta.url))).toBe(false);
});
