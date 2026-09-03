import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { getAppCopy } from "@/app/copy.ts";
import { SettingsSidebar } from "./SettingsSidebar";
import { createSettingsSectionGroups } from "./settingsSections";

const settingsCopy = getAppCopy("en-US").settings;

test("settings navigation groups existing pages without placeholder categories", () => {
  const groups = createSettingsSectionGroups(settingsCopy);

  expect(groups.map((group) => group.label)).toEqual([
    "General",
    "Models and extensions",
    "App and system",
  ]);
  expect(
    groups.map((group) => group.sections.map((section) => section.id)),
  ).toEqual([
    ["general", "appearance", "personalization"],
    ["models", "mcp", "skills"],
    ["server", "updates", "usage", "privacy", "system", "archives", "about"],
  ]);
  expect(
    groups.flatMap((group) => group.sections).map((section) => section.id),
  ).not.toContain("logs");
});

test("developer logs stay in the app group when enabled", () => {
  const groups = createSettingsSectionGroups(settingsCopy, true);
  const appGroup = groups.find((group) => group.id === "app-and-system");

  expect(appGroup?.sections.map((section) => section.id)).toEqual([
    "server",
    "updates",
    "usage",
    "logs",
    "privacy",
    "system",
    "archives",
    "about",
  ]);
});

test("settings sidebar renders each group through the existing settings nav", () => {
  const markup = renderToStaticMarkup(
    <SettingsSidebar
      sectionGroups={createSettingsSectionGroups(settingsCopy)}
      activeSection="mcp"
      backLabel="Back"
      onClose={() => undefined}
      onSectionChange={() => undefined}
    />,
  );

  const document = new JSDOM(markup).window.document;
  expect(
    Array.from(document.querySelectorAll("nav")).map((nav) =>
      nav.getAttribute("aria-label"),
    ),
  ).toEqual(["General", "Models and extensions", "App and system"]);
  expect(markup).toContain('aria-current="page"');
  expect(markup).toContain('data-slot="nav-row-label">MCP</span>');
  expect(markup).not.toContain("Project");
  expect(markup).not.toContain("Notifications");
});
