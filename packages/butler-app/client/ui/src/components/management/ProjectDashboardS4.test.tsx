/// <reference types="bun" />
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { appCopy, getAppCopy } from "@/app/copy.ts";
import type { ProjectDashboardView } from "@/app/types.ts";
import { ProjectDashboardHeader } from "./ProjectDashboardHeader.tsx";
import { ProjectOverviewPanel } from "./ProjectOverviewPanel.tsx";
import { ProjectStatisticsContext } from "./projectStatisticsContext.ts";
import { ProjectMaterialStatistics } from "./ProjectMaterialStatistics.tsx";
import { ProjectWorkStatistics } from "./ProjectWorkStatistics.tsx";

const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const dom = (markup: string) => new JSDOM(markup).window.document;

test("the dashboard new-conversation action uses the sidebar copy key in en and ko", () => {
  const document = dom(renderToStaticMarkup(<ProjectDashboardHeader dashboard={null}
    project={{ id: "p1", display_name: "Demo" } as never} sessionsCount={0} onNewProjectChat={() => undefined} />));
  expect(document.querySelector("button")!.textContent!.trim()).toBe(appCopy.space.newChat);
  expect(getAppCopy("en-US").space.newChat).toBe("New conversation");
  expect(getAppCopy("ko-KR").space.newChat).toBe("새 대화");
  expect(source("./ProjectDashboardHeader.tsx")).toContain("appCopy.space.newChat");
  expect(source("./ProjectDashboardView.tsx")).toContain("appCopy.space.newChat");
  expect(source("../layout/SidebarChatsSection.tsx")).toContain("appCopy.space.newChat");
});

test("overview progress renders as a metric grid with tabular values and keyboard-operable work cards", () => {
  const overview = {
    status: "ready", sourceRevision: "r1", totalWorks: 8, remainingCount: 2,
    progress: { completed: 3, open: 4, blocked: 1, abandoned: 0, unknown: 0 },
    remaining: [
      { id: "W-1", title: "Ship metrics", executionStatus: "open", updatedAt: "2026-09-25" },
      { id: "W-2", title: "Fix first-run", executionStatus: "blocked", updatedAt: "2026-09-25" },
    ],
  } as unknown as ProjectDashboardView["overview"];
  const document = dom(renderToStaticMarkup(<ProjectOverviewPanel overview={overview} projectId="p1" onSelect={() => undefined} />));
  const values = [...document.querySelectorAll('[data-slot="metric-value"]')];
  expect(values.map((value) => value.querySelector('[data-slot="animated-number-final"]')!.textContent)).toEqual(["3", "4", "1"]);
  expect(values.every((value) => value.getAttribute("data-numeric") === "tabular")).toBe(true);
  const copy = appCopy.projectSignpost;
  expect([...document.querySelectorAll('[data-slot="metric-label"]')].map((label) => label.textContent))
    .toEqual([copy.completed, copy.open, copy.blocked]);
  const cards = [...document.querySelectorAll('[data-slot="card"][role="button"]')];
  expect(cards).toHaveLength(2);
  expect(document.querySelector("[data-columns-wide]")).not.toBeNull();
});

test("secondary statistics choices are segmented controls, not a second tab bar", () => {
  const card = (id: string, lane: string) => ({ id, lane, title: id, sourceKey: id, ageDays: 1 });
  const series = { keys: ["created"], buckets: [{ label: "2026-09-25", values: { created: ["a"] } }] };
  const data = {
    ledgerHistoryAvailable: true, sessionHistoryAvailable: true, sources: {},
    materials: series, materialTypes: series,
    work: { excluded: 0, activity: [], cards: { work: [card("a", "active")], task: [] }, work: series, task: series },
  };
  const markup = renderToStaticMarkup(
    <ProjectStatisticsContext.Provider value={{ data: data as never, openSource: () => undefined }}>
      <ProjectWorkStatistics />
      <ProjectMaterialStatistics />
    </ProjectStatisticsContext.Provider>,
  );
  const document = dom(markup);
  expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(0);
  expect(document.querySelectorAll('[role="radiogroup"]')).toHaveLength(2);
  expect(source("./ProjectStatisticsPanel.tsx")).toContain("<SegmentedControl");
  expect(source("./ProjectWorkBoard.tsx")).toContain("<SegmentedControl");
  expect(source("./ProjectWorkBoard.tsx")).not.toContain("<Tabs");
});

test("the dashboard page composes DS layout: one line tab bar and no product page CSS", () => {
  const view = source("./ProjectDashboardView.tsx");
  expect(view).toContain('<TabsList variant="line"');
  expect(view).not.toContain("module.css");
  expect(view).not.toContain("className=");
  expect(existsSync(new URL("./ProjectDashboardView.module.css", import.meta.url))).toBe(false);
  for (const file of ["./ProjectOverviewPanel.tsx", "./ProjectBoardCard.tsx", "./ProjectWorkStatistics.tsx", "./ProjectBriefingPanel.tsx"]) {
    expect({ file, className: source(file).includes("className=") }).toEqual({ file, className: false });
  }
});
