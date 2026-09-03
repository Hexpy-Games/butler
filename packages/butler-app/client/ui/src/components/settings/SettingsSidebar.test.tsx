import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getAppCopy } from "@/app/copy.ts";
import { SettingsSidebar } from "./SettingsSidebar";
import {
  createSettingsSectionGroups,
  filterSettingsSectionGroups,
} from "./settingsSections";

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

test("settings search matches labels, descriptions, and bounded aliases", () => {
  const groups = createSettingsSectionGroups(settingsCopy, true);
  const sectionIds = (query: string) =>
    filterSettingsSectionGroups(groups, query).flatMap((group) =>
      group.sections.map((section) => section.id),
    );

  expect(sectionIds("tokens")).toEqual(["usage"]);
  expect(sectionIds("project folder")).toEqual(["server"]);
  expect(sectionIds("worker")).toEqual(["models"]);
  expect(sectionIds("developer logs")).toEqual(["logs"]);
  expect(sectionIds("does not exist")).toEqual([]);
  expect(filterSettingsSectionGroups(groups, " ")).toBe(groups);
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

test("settings sidebar filters pages, shows an empty state, and keeps selection routed", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  const selected: string[] = [];

  try {
    await act(async () => {
      root.render(
        <SettingsSidebar
          sectionGroups={createSettingsSectionGroups(settingsCopy)}
          activeSection="general"
          backLabel="Back"
          onClose={() => undefined}
          onSectionChange={(section) => selected.push(section)}
        />,
      );
    });

    const input = container.querySelector<HTMLInputElement>(
      '[data-test-class="settings-navigation-search"]',
    );
    if (!input) throw new Error("Missing settings search input.");
    const setInputValue = (value: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      );
      descriptor?.set?.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    };

    await act(async () => setInputValue("tokens"));
    expect(container.textContent).toContain("Usage");
    expect(container.textContent).not.toContain("Models");

    const usageRow = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((row) => row.textContent?.includes("Usage"));
    if (!usageRow) throw new Error("Missing filtered settings result.");
    await act(async () => usageRow.click());
    expect(selected).toEqual(["usage"]);

    await act(async () => setInputValue("missing setting"));
    expect(container.textContent).toContain("No settings match: missing setting");
    expect(container.querySelector('nav [role="button"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of [
      "window",
      "document",
      "navigator",
      "HTMLElement",
      "HTMLInputElement",
      "Node",
      "Event",
      "IS_REACT_ACT_ENVIRONMENT",
    ]) {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});
