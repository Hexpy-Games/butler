import { expect, test } from "bun:test";
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
