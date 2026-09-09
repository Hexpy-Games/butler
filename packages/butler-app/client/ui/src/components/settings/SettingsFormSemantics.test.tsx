import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { getAppCopy } from "@/app/copy.ts";
import { SettingsDetailHeader } from "./SettingsDetailHeader";
import { SettingsInput } from "./SettingsInput";
import { SettingsSearchableSelect } from "./SettingsSearchableSelect";
import { SettingsSelect } from "./SettingsSelect";
import { SettingsSwitch } from "./SettingsSwitch";
import { createSettingsSectionGroups } from "./settingsSections";

function assertLabeledField(document: Document, labelText: string): void {
  const field = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="field"]'),
  ).find((candidate) => candidate.querySelector("label")?.textContent === labelText);
  if (!field) throw new Error(`Missing settings field: ${labelText}`);

  const label = field.querySelector("label");
  const controlId = label?.htmlFor;
  expect(controlId).toBeTruthy();
  const control = controlId ? document.getElementById(controlId) : null;
  expect(control).not.toBeNull();

  const descriptionId = control?.getAttribute("aria-describedby");
  expect(descriptionId).toBeTruthy();
  expect(descriptionId ? document.getElementById(descriptionId) : null).not.toBeNull();
}

test("settings descriptors, headers, and shared controls expose their semantics", () => {
  const settingsCopy = getAppCopy("en-US").settings;
  const sections = createSettingsSectionGroups(settingsCopy, true).flatMap(
    (group) => group.sections,
  );
  expect(sections).toHaveLength(14);
  expect(sections.every((section) => section.description.trim().length > 0)).toBe(true);

  const markup = renderToStaticMarkup(
    <div>
      <SettingsDetailHeader
        title="General"
        description={settingsCopy.sectionDescriptions.general}
        localMessage={null}
      />
      <SettingsInput
        label="Name"
        description="A readable name."
        value="Butler"
        onChange={() => undefined}
        onBlur={() => undefined}
      />
      <SettingsSelect
        label="Mode"
        description="Choose a mode."
        value="safe"
        onChange={() => undefined}
        options={[{ value: "safe", label: "Safe" }]}
      />
      <SettingsSwitch
        label="Enabled"
        description="Turn this on when needed."
        checked
        onChange={() => undefined}
      />
      <SettingsSearchableSelect
        label="Timezone"
        description="Choose a timezone."
        value="Asia/Seoul"
        options={[{ value: "Asia/Seoul", label: "Seoul" }]}
        searchLabel="Search"
        searchPlaceholder="Search timezones"
        searchClearLabel="Clear"
        allLabel="All"
        emptyLabel="No results"
        onChange={() => undefined}
      />
    </div>,
  );
  const document = new JSDOM(markup).window.document;

  expect(document.querySelector('[data-test-class="settings-detail-title"]')?.textContent).toBe(
    "General",
  );
  expect(document.body.textContent).toContain(
    settingsCopy.sectionDescriptions.general,
  );
  assertLabeledField(document, "Name");
  assertLabeledField(document, "Mode");
  assertLabeledField(document, "Enabled");
  assertLabeledField(document, "Timezone");
});
