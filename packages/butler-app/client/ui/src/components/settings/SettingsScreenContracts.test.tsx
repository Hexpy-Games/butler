import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup as renderRaw } from "react-dom/server";
import { SettingsFieldScopeProvider } from "@/butler-ds";

/** Settings fields render inside a section scope (SettingsField throws outside one). */
const renderToStaticMarkup = (node: React.ReactNode) =>
  renderRaw(<SettingsFieldScopeProvider>{node}</SettingsFieldScopeProvider>);
import { EMPTY_SETTINGS } from "@/app/constants.ts";
import { appCopy, getAppCopy } from "@/app/copy.ts";
import { AiChip, Blocks, ChevronDownIcon, MagicWand, McpServer, Sparkles } from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { AppearanceSettings } from "./AppearanceSettings";
import { SettingsSearchableSelect } from "./SettingsSearchableSelect";
import { SettingsSelect } from "./SettingsSelect";
import { SettingsSidebar } from "./SettingsSidebar";
import { SettingsSwitch } from "./SettingsSwitch";
import { createSettingsSectionGroups } from "./settingsSections";

const settingsCopy = getAppCopy("en-US").settings;
const markupOf = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

test("models, MCP, and skills sections use distinct icons and Blocks is a cube", () => {
  const sections = createSettingsSectionGroups(settingsCopy, true).flatMap(
    (group) => group.sections,
  );
  const icon = (id: string) => markupOf(sections.find((section) => section.id === id)?.icon);

  expect(icon("models")).toBe(markupOf(<AiChip />));
  expect(icon("mcp")).toBe(markupOf(<McpServer />));
  expect(icon("skills")).toBe(markupOf(<MagicWand />));
  const icons = sections.map((section) => markupOf(section.icon));
  expect(new Set(icons).size).toBe(icons.length);
  expect(icons).not.toContain(markupOf(<Sparkles />));
  expect(markupOf(<Blocks />)).not.toBe(markupOf(<Sparkles />));
});

test("the first settings group is Preferences in English and Korean", () => {
  expect(createSettingsSectionGroups(settingsCopy)[0]?.label).toBe("Preferences");
  expect(
    createSettingsSectionGroups(getAppCopy("ko-KR").settings)[0]?.label,
  ).toBe("환경 설정");
});

test("settings search has no visible heading but keeps its accessible name", () => {
  const markup = renderToStaticMarkup(
    <SettingsSidebar
      sectionGroups={createSettingsSectionGroups(settingsCopy)}
      activeSection="general"
      backLabel="Back"
      onClose={() => undefined}
      onSectionChange={() => undefined}
    />,
  );
  const document = new JSDOM(markup).window.document;
  const input = document.querySelector('input[type="search"]');
  expect(input?.getAttribute("aria-label")).toBe(settingsCopy.searchLabel);
  const visibleText = Array.from(document.body.querySelectorAll("*"))
    .filter((element) => element.children.length === 0)
    .map((element) => element.textContent);
  expect(visibleText).not.toContain(settingsCopy.searchLabel);
});

test("appearance exposes exactly one theme control", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const keys = ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const before = useSettingsUIStore.getState().draft;
  useSettingsUIStore.setState({ draft: { ...EMPTY_SETTINGS } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(<AppearanceSettings />));
    const document = dom.window.document;
    const themeLabels = Array.from(document.querySelectorAll("label")).filter(
      (label) => label.textContent === appCopy.settings.fields.theme,
    );
    expect(themeLabels).toHaveLength(1);
    const buttonTexts = Array.from(
      document.querySelectorAll('button:not([role="combobox"])'),
    ).map(
      (button) => button.textContent?.trim(),
    );
    for (const option of ["light", "dark", "system"] as const) {
      expect(buttonTexts).not.toContain(appCopy.settings.options[option]);
    }
    expect(document.querySelectorAll('[data-slot="button-container"]')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    useSettingsUIStore.setState({ draft: before });
    saved.forEach(([key, descriptor]) => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    });
    dom.window.close();
  }
});

test("every settings field stacks label, description, then control (no inline layout)", () => {
  const markup = renderToStaticMarkup(
    <div>
      <SettingsSwitch label="Enabled" description="Turn it on" checked onChange={() => undefined} />
      <SettingsSelect
        label="Mode"
        value="safe"
        onChange={() => undefined}
        options={[{ value: "safe", label: "Safe" }]}
      />
    </div>,
  );
  const document = new JSDOM(markup).window.document;
  const fields = Array.from(document.querySelectorAll('[data-slot="field"]'));
  expect(fields).toHaveLength(2);
  for (const field of fields) {
    expect(field.hasAttribute("data-layout")).toBe(false);
    const label = field.querySelector("label");
    const control = field.querySelector('button, input, [role="switch"], [role="combobox"]');
    expect(label).not.toBeNull();
    expect(control).not.toBeNull();
    // Label (and description) come before the control in reading order.
    expect(label!.compareDocumentPosition(control!) & 4).toBe(4);
  }
  const css = readFileSync(
    resolve(import.meta.dir, "../../libs/design-system/blocks/SettingsField/SettingsField.module.css"),
    "utf8",
  );
  expect(css).not.toContain("data-layout");
  expect(css).not.toMatch(/flex-direction:\s*row/u);
  const component = readFileSync(
    resolve(import.meta.dir, "../../libs/design-system/blocks/SettingsField/SettingsField.tsx"),
    "utf8",
  );
  expect(component).not.toMatch(/layout\??:/u);
});

test("settings buttons sit under their text instead of to its right", () => {
  for (const file of [
    "BackupModelsSettings.tsx",
    "ServerSettings.tsx",
    "McpSettings.tsx",
    "WorkerProfileControls.tsx",
  ]) {
    const source = readFileSync(resolve(import.meta.dir, file), "utf8");
    expect(source, file).not.toContain('justify="between"');
    expect(source, file).not.toContain('layout="inline"');
  }
});

test("searchable settings select uses the plain select trigger with a left-aligned value", () => {
  const markup = renderToStaticMarkup(
    <SettingsSearchableSelect
      label="Timezone"
      value="Asia/Seoul"
      options={[{ value: "Asia/Seoul", label: "Asia/Seoul" }]}
      searchLabel="Search"
      searchPlaceholder="Search"
      searchClearLabel="Clear"
      allLabel="All"
      emptyLabel="None"
      onChange={() => undefined}
    />,
  );
  const document = new JSDOM(markup).window.document;
  const trigger = document.querySelector('[data-test-class="settings-searchable-select-trigger"]');
  expect(trigger?.tagName).toBe("BUTTON");
  expect(trigger?.firstElementChild?.getAttribute("data-slot")).toBe("select-value");
  expect(trigger?.querySelector('[data-slot="select-value"]')?.textContent).toBe("Asia/Seoul");
  expect(trigger?.innerHTML).toContain(
    markupOf(<ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" aria-hidden="true" />),
  );
});

test("single-section pages do not repeat the page title as a section header", () => {
  const settingsCopyEn = getAppCopy("en-US").settings;
  const pages = [
    ["AppearanceSettings.tsx", "settingsCopy.sections.appearance", "appearance", undefined],
    ["PersonalizationSettings.tsx", "settingsCopy.sections.personalization", "personalization", undefined],
    ["ArchivesSettings.tsx", "panels.archives", "archives", "archives"],
    ["AboutSettings.tsx", "panels.about", "about", "about"],
    ["UpdatesSettings.tsx", "panels.updates", "updates", "updates"],
    ["SkillsSettings.tsx", "panels.skills", "skills", "skills"],
    ["UsageSettings.tsx", "panels.usageMonitor", "usage", "usageMonitor"],
    ["SystemEventsSettings.tsx", "panels.systemEvents", "system", "systemEvents"],
  ] as const;
  for (const [file, titleExpression, pageId, panelId] of pages) {
    // The panel title really is the page title, so a header would only repeat it.
    if (panelId) {
      expect(settingsCopyEn.panels[panelId], file).toBe(settingsCopyEn.sections[pageId]);
    }
    const source = readFileSync(resolve(import.meta.dir, file), "utf8");
    expect(source, file).toContain("<SettingsSection");
    expect(source, file).not.toContain(titleExpression);
  }
  // A section description that repeats the page description is dropped too.
  const updates = readFileSync(resolve(import.meta.dir, "UpdatesSettings.tsx"), "utf8");
  expect(settingsCopyEn.descriptions.updates).toBe(settingsCopyEn.sectionDescriptions.updates);
  expect(updates).not.toContain("descriptions.updates");
});
