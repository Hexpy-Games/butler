/// <reference types="bun" />

import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { Input } from "../../components/Input";
import { FormSection } from "../FormSection";
import { SettingsField } from "../SettingsField";
import { SettingsPage } from "./SettingsPage";
import { SettingsSection } from "./SettingsSection";

const labels = { loading: "Loading", error: "Could not load.", retry: "Retry", empty: "Nothing yet." };

function dom(node: React.ReactNode) {
  return new JSDOM(renderToStaticMarkup(<>{node}</>)).window.document;
}

const field = <SettingsField id="f" settingId="language" label="Language" control={<Input id="f" />} />;

test("a section renders one card with its id, kind and fields scoped to it", () => {
  const document = dom(
    <SettingsPage labels={labels}>
      <SettingsSection id="language-region" kind="form" title="Language & region">{field}</SettingsSection>
    </SettingsPage>,
  );
  const section = document.querySelector('[data-settings-section-id="language-region"]')!;
  expect(section.getAttribute("data-kind")).toBe("form");
  expect(section.querySelectorAll('[data-slot="form-section-card"]')).toHaveLength(1);
  expect(section.querySelector('[data-setting-id="language"]')?.closest("[data-settings-section-id]")).toBe(section);
});

test("actions render in the section header toolbar, outside the card", () => {
  const document = dom(
    <SettingsSection id="updates" kind="list" actions={<button type="button">Check</button>}>rows</SettingsSection>,
  );
  const actions = document.querySelector('[data-slot="form-section-actions"]')!;
  expect(actions.textContent).toBe("Check");
  expect(actions.closest('[data-slot="form-section-header"]')).not.toBeNull();
  expect(actions.closest('[data-slot="form-section-card"]')).toBeNull();
});

test("loading renders skeleton rows, never the children or an empty message", () => {
  const document = dom(
    <SettingsPage labels={labels}>
      <SettingsSection id="archives" kind="list" state="loading" emptyMessage="No archives">child</SettingsSection>
    </SettingsPage>,
  );
  const section = document.querySelector('[data-settings-section-id="archives"]')!;
  expect(section.getAttribute("aria-busy")).toBe("true");
  expect(section.querySelector('[data-slot="settings-section-skeleton"]')).not.toBeNull();
  expect(section.textContent).not.toContain("child");
  expect(section.textContent).not.toContain("No archives");
});

test("error renders a Notice with the page copy and a Retry button when onRetry is given", () => {
  const document = dom(
    <SettingsPage labels={labels}>
      <SettingsSection id="usage" kind="status" state="error" onRetry={() => undefined}>child</SettingsSection>
      <SettingsSection id="skills" kind="list" state="error" errorMessage="Skills failed">child</SettingsSection>
    </SettingsPage>,
  );
  const usage = document.querySelector('[data-settings-section-id="usage"] [data-slot="settings-section-error"]')!;
  expect(usage.textContent).toContain("Could not load.");
  expect(usage.querySelector("button")?.textContent).toBe("Retry");
  const skills = document.querySelector('[data-settings-section-id="skills"] [data-slot="settings-section-error"]')!;
  expect(skills.textContent).toContain("Skills failed");
  expect(skills.querySelector("button")).toBeNull();
});

test("empty renders the empty line with the page or section copy", () => {
  const document = dom(
    <SettingsPage labels={labels}>
      <SettingsSection id="a" kind="list" state="empty">child</SettingsSection>
      <SettingsSection id="b" kind="list" state="empty" emptyMessage="No servers">child</SettingsSection>
    </SettingsPage>,
  );
  expect(document.querySelector('[data-settings-section-id="a"] [data-slot="settings-section-empty"]')?.textContent).toBe("Nothing yet.");
  expect(document.querySelector('[data-settings-section-id="b"] [data-slot="settings-section-empty"]')?.textContent).toBe("No servers");
});

test("a settings page renders only settings sections", () => {
  expect(() => renderToStaticMarkup(
    <SettingsPage><div>loose</div></SettingsPage>,
  )).toThrow("SettingsPage renders only SettingsSection children.");
  expect(() => renderToStaticMarkup(
    <SettingsPage>
      <>
        <SettingsSection id="a" kind="form">{field}</SettingsSection>
        {false}
        {null}
      </>
    </SettingsPage>,
  )).not.toThrow();
});

test("the page footer is sticky and sits after the sections", () => {
  const document = dom(
    <SettingsPage footer={<button type="button">Apply</button>}>
      <SettingsSection id="a" kind="form">{field}</SettingsSection>
    </SettingsPage>,
  );
  const footer = document.querySelector('[data-slot="settings-page-footer"]')!;
  expect(footer.previousElementSibling?.getAttribute("data-settings-section-id")).toBe("a");
  expect(footer.textContent).toBe("Apply");
});

test("a settings field throws outside a section and renders inside FormSection", () => {
  expect(() => renderToStaticMarkup(field)).toThrow("SettingsField must render inside a SettingsSection");
  expect(() => renderToStaticMarkup(<FormSection>{field}</FormSection>)).not.toThrow();
});
