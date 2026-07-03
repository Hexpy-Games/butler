import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { normalizeSettingsSectionId } from "../../packages/butler-app/client/ui/src/app/utils.ts";
import { visibleSettingsSectionIds } from "../../packages/butler-app/client/ui/src/components/settings/settingsSectionIds.ts";

test("settings logs section is visible only when developer mode is enabled", () => {
  expect(visibleSettingsSectionIds(false)).not.toContain("logs");
  expect(visibleSettingsSectionIds(true)).toContain("logs");
});

test("settings route normalization recognizes developer logs", () => {
  expect(normalizeSettingsSectionId("settings:logs")).toBe("logs");
  expect(normalizeSettingsSectionId("개발자 로그")).toBe("logs");
});

test("developer log row privacy labels are driven by entry privacy flags", () => {
  const source = readFileSync(
    "packages/butler-app/client/ui/src/components/settings/DeveloperLogRow.tsx",
    "utf8",
  );
  expect(source).toContain("entry.privacy.raw_text_included ? copy.labels.included : copy.labels.excluded");
  expect(source).toContain("entry.privacy.secrets_redacted ? copy.labels.redacted : copy.labels.included");
  expect(source).not.toContain("{copy.labels.rawText}: {copy.labels.included}");
});
