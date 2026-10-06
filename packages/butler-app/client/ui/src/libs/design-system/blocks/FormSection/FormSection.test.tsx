/// <reference types="bun" />

import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { FormSection } from "./FormSection";
import { SettingsPageProvider, repeatsSettingsCopy } from "../SettingsShell/settingsPage";

function render(node: React.ReactNode) {
  const document = new JSDOM(renderToStaticMarkup(<>{node}</>)).window.document;
  const section = document.querySelector('[data-slot="form-section"]')!;
  return {
    section,
    header: section.querySelector(':scope > [data-slot="form-section-header"]'),
    card: section.querySelector(':scope > [data-slot="form-section-card"]'),
  };
}

test("the section header sits above the card, outside it, and the card holds only fields", () => {
  const { section, header, card } = render(
    <FormSection title="Search" description="Configure web search providers.">
      <div data-testid="field">Provider</div>
    </FormSection>,
  );
  expect(section.tagName).toBe("SECTION");
  expect(header?.querySelector("h3")?.textContent).toBe("Search");
  expect(header?.querySelector("p")?.textContent).toBe("Configure web search providers.");
  expect(header?.nextElementSibling).toBe(card);
  expect(card?.querySelector("h3, p")).toBeNull();
  expect(card?.children).toHaveLength(1);
  expect(section.getAttribute("aria-labelledby")).toBe(header?.querySelector("h3")?.id ?? "missing");
});

test("a title-only section renders the header without a description", () => {
  const { header, card } = render(
    <FormSection title="Model settings"><div>Model</div></FormSection>,
  );
  expect(header?.querySelector("h3")?.textContent).toBe("Model settings");
  expect(header?.querySelector("p")).toBeNull();
  expect(card).not.toBeNull();
});

test("a section without a title (its page title names it) renders only the card", () => {
  const { section, header, card } = render(
    <FormSection><div>Theme</div></FormSection>,
  );
  expect(header).toBeNull();
  expect(section.hasAttribute("aria-labelledby")).toBe(false);
  expect(card?.textContent).toBe("Theme");
});

test("a description without a title still sits above the card", () => {
  const { header, card } = render(
    <FormSection description="Review model tokens and tool calls."><div>Usage</div></FormSection>,
  );
  expect(header?.querySelector("h3")).toBeNull();
  expect(header?.querySelector("p")?.textContent).toBe("Review model tokens and tool calls.");
  expect(header?.nextElementSibling).toBe(card);
});

test("inside a settings page, a section header that repeats the page renders only the card", () => {
  const { section, header, card } = render(
    <SettingsPageProvider title="Skills" description="Manage built-in and project skills.">
      <FormSection title=" skills " description="Manage built-in and  project skills">
        <div>Skill list</div>
      </FormSection>
    </SettingsPageProvider>,
  );
  expect(header).toBeNull();
  expect(section.hasAttribute("aria-labelledby")).toBe(false);
  expect(card?.textContent).toBe("Skill list");
});

test("inside a settings page, only the repeated part of a section header is dropped", () => {
  const repeatedTitle = render(
    <SettingsPageProvider title="사용량" description="모델과 도구 사용량을 확인합니다.">
      <FormSection title="사용량" description="모델 토큰과 도구 호출을 확인합니다."><div>Usage</div></FormSection>
    </SettingsPageProvider>,
  );
  expect(repeatedTitle.header?.querySelector("h3")).toBeNull();
  expect(repeatedTitle.header?.querySelector("p")?.textContent).toBe("모델 토큰과 도구 호출을 확인합니다.");

  const repeatedDescription = render(
    <SettingsPageProvider title="Updates" description="Check and update Butler App.">
      <FormSection title="Components" description="Check and update Butler App."><div>Rows</div></FormSection>
    </SettingsPageProvider>,
  );
  expect(repeatedDescription.header?.querySelector("h3")?.textContent).toBe("Components");
  expect(repeatedDescription.header?.querySelector("p")).toBeNull();
});

test("outside a settings page a section keeps its whole header", () => {
  const { header } = render(
    <FormSection title="Skills" description="Manage built-in and project skills."><div>List</div></FormSection>,
  );
  expect(header?.querySelector("h3")?.textContent).toBe("Skills");
  expect(header?.querySelector("p")?.textContent).toBe("Manage built-in and project skills.");
});

test("repeated settings copy ignores case, width, whitespace and end punctuation in en and ko", () => {
  expect(repeatsSettingsCopy("MCP", "mcp")).toBe(true);
  expect(repeatsSettingsCopy("ＭＣＰ", "MCP")).toBe(true);
  expect(repeatsSettingsCopy("  System   events ", "System events")).toBe(true);
  expect(repeatsSettingsCopy("Butler 버전과 앱 정보를 확인합니다", "Butler 버전과 앱 정보를 확인합니다.")).toBe(true);
  expect(repeatsSettingsCopy("Check and update Butler App。", "Check and update Butler App.")).toBe(true);
  // A longer description that only extends the page description repeats it.
  expect(repeatsSettingsCopy(
    "Manage built-in and project skills under Butler data home.",
    "Manage built-in and project skills.",
  )).toBe(true);
  // Short titles never match by prefix: "Model settings" is its own section on Models.
  expect(repeatsSettingsCopy("Model settings", "Models")).toBe(false);
  expect(repeatsSettingsCopy("모델 설정", "모델")).toBe(false);
  expect(repeatsSettingsCopy("Notifications", "General")).toBe(false);
  expect(repeatsSettingsCopy("", "General")).toBe(false);
});
