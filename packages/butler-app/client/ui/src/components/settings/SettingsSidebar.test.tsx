import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getAppCopy } from "@/app/copy.ts";
import { SettingsSidebar } from "./SettingsSidebar";
import { normalizeSettingsSectionId } from "@/app/utils.ts";
import {
  createSettingsSectionGroups,
  filterSettingsSectionGroups,
  settingsPageSchema,
} from "./settingsSections";

const settingsCopy = getAppCopy("en-US").settings;

test("everyday settings come first and agent-level pages sit in a last Advanced group", () => {
  const groups = createSettingsSectionGroups(settingsCopy);

  expect(groups.map((group) => group.label)).toEqual([
    "Preferences",
    "App and system",
    "Advanced",
  ]);
  expect(
    groups.map((group) => group.sections.map((section) => section.id)),
  ).toEqual([
    ["general", "appearance", "personalization", "models"],
    ["updates", "usage", "privacy", "security", "system", "archives", "about"],
    ["mcp", "skills", "server"],
  ]);
  expect(
    groups.flatMap((group) => group.sections).map((section) => section.id),
  ).not.toContain("logs");
  expect(
    createSettingsSectionGroups(getAppCopy("ko-KR").settings).at(-1)?.label,
  ).toBe("고급");
});

test("developer logs stay in the app group when enabled", () => {
  const groups = createSettingsSectionGroups(settingsCopy, true);
  const appGroup = groups.find((group) => group.id === "app-and-system");

  expect(appGroup?.sections.map((section) => section.id)).toEqual([
    "updates",
    "usage",
    "logs",
    "privacy",
    "security",
    "system",
    "archives",
    "about",
  ]);
  expect(groups.at(-1)?.id).toBe("advanced");
});

test("model settings stay on the Models page and old links still resolve", () => {
  for (const [link, section] of [
    ["models", "models"],
    ["settings:models", "models"],
    ["Models/Access", "models"],
    ["helpers", "models"],
    ["settings:helpers", "models"],
    ["worker-profiles", "models"],
    ["fallback-consolidation", "models"],
    ["backup models", "models"],
    ["mcp", "mcp"],
    ["settings:mcp", "mcp"],
    ["skills", "skills"],
    ["server", "server"],
    ["Server/Bridge", "server"],
    ["system-events", "system"],
  ] as const) {
    expect(normalizeSettingsSectionId(link), link).toBe(section);
  }
  // Backup models stay visible; memory cleanup and worker profiles sit in
  // the page's collapsed Advanced disclosure, so they may be absent.
  expect(settingsPageSchema.models.map((section) => [section.id, section.optional === true])).toEqual([
    ["butler-model", false],
    ["backup-models", false],
    ["saved-keys", false],
    ["permissions", false],
    ["advanced-models", false],
    ["memory-cleanup", true],
    ["worker-profiles", true],
  ]);
  // Security: host-only sections are absent for other computers, and allowed
  // hosts sit in the page's collapsed Advanced disclosure.
  expect(settingsPageSchema.security.map((section) => [section.id, section.optional === true])).toEqual([
    ["remote-access", false],
    ["connection-code", true],
    ["security-advanced", true],
    ["allowed-hosts", true],
  ]);
  expect(Object.keys(settingsPageSchema)).not.toContain("helpers");
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
  expect(sectionIds("backup")).toEqual(["models"]);
  expect(sectionIds("api keys")).toEqual(["models"]);
  expect(sectionIds("developer logs")).toEqual(["logs"]);
  expect(sectionIds("connection code")).toEqual(["security"]);
  expect(sectionIds("remote access")).toEqual(["security"]);
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
  const navigationScroll = document.querySelector(
    '[data-test-class="settings-navigation-scroll"]',
  );
  const searchInput = document.querySelector('input[type="search"]');
  expect(navigationScroll).not.toBeNull();
  expect(navigationScroll?.querySelectorAll("nav").length).toBe(3);
  // The Advanced group is visually separated from the everyday groups.
  const advancedNav = Array.from(navigationScroll?.querySelectorAll("nav") ?? []).at(-1);
  expect(advancedNav?.previousElementSibling?.getAttribute("data-slot")).toBe("separator");
  expect(navigationScroll?.querySelectorAll('[data-slot="separator"]').length).toBe(1);
  expect(navigationScroll?.contains(searchInput)).toBe(false);
  expect(navigationScroll?.textContent).not.toContain("Back");
  expect(searchInput?.getAttribute("aria-label")).toBeTruthy();
  expect(
    Array.from(document.querySelectorAll("nav")).map((nav) =>
      nav.getAttribute("aria-label"),
    ),
  ).toEqual(["Preferences", "App and system", "Advanced"]);
  expect(markup).toContain('aria-current="page"');
  expect(markup).toContain('data-slot="nav-row-label">MCP</span>');
  expect(markup).not.toContain("Project");
  expect(markup).not.toContain("Notifications");
});

test("settings sidebar opens a sole result, preserves multi-match search, and keeps selection routed", async () => {
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
    expect(selected).toEqual(["usage"]);

    const usageRow = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((row) => row.textContent?.includes("Usage"));
    if (!usageRow) throw new Error("Missing filtered settings result.");
    selected.length = 0;
    await act(async () => usageRow.click());
    expect(selected).toEqual(["usage"]);

    selected.length = 0;
    await act(async () => setInputValue("model"));
    expect(selected).toEqual([]);

    selected.length = 0;
    await act(async () => setInputValue("missing setting"));
    expect(selected).toEqual([]);
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
