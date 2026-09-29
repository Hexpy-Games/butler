/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectDashboardView as ProjectDashboardData, ProjectSummary, ProjectWallpaper } from "@/app/types.ts";
import { ProjectDashboardView } from "./ProjectDashboardView.tsx";

// Server rendering reads the store's initial settings: the default global
// wallpaper, bloom (from the legacy `main_screen_theme` defaults).
const SILK = { kind: "live", module: "butler.silk" } as const;

function dashboardFor(wallpaper: ProjectWallpaper | undefined) {
  const project: ProjectSummary = {
    id: "p1", display_name: "Demo", last_activity_at: "2026-09-28T00:00:00.000Z", pinned: false, archived: false, sessions: [],
    ...(wallpaper === undefined ? {} : { wallpaper }),
  };
  const dashboard = {
    project,
    preferences: { revision: 1, pinnedSourceRefs: [], ...(wallpaper === undefined ? {} : { wallpaper }) },
    stats: { active_sessions: 0, archived_sessions: 0, recent_messages_7d: 0, recent_messages_30d: 0, specs: 0, plans: 0 },
    activity: { days: [] },
    documents: [],
    generated_at: "2026-09-28T00:00:00.000Z",
  } satisfies ProjectDashboardData;
  const document = new JSDOM(renderToStaticMarkup(<ProjectDashboardView project={project} initialDashboard={dashboard} />)).window.document;
  const background = document.querySelector('[data-slot="management-page-background"]');
  return {
    background,
    canvas: background?.querySelector('canvas[data-test-class~="project-dashboard-wallpaper"]') ?? null,
    panels: document.querySelectorAll('[data-slot="management-page-panel"]').length,
  };
}

test("the dashboard draws the project's own wallpaper over the global one, confined to the page", () => {
  const { background, canvas, panels } = dashboardFor(SILK);
  expect(canvas?.getAttribute("data-module")).toBe("butler.silk");
  expect(canvas?.getAttribute("data-scope")).toBe("container");
  expect(background?.getAttribute("data-treatment")).toBe("calm");
  expect(panels).toBe(2);
});

test("a project that inherits, or predates project wallpapers, shows the global wallpaper", () => {
  expect(dashboardFor("inherit").canvas?.getAttribute("data-module")).toBe("butler.bloom");
  expect(dashboardFor(undefined).canvas?.getAttribute("data-module")).toBe("butler.bloom");
});

test("a project without a wallpaper keeps the plain dashboard: no background layer, no glass panels", () => {
  const { background, panels } = dashboardFor({ kind: "none" });
  expect({ background, panels }).toEqual({ background: null, panels: 0 });
});
