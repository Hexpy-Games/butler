import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  appCopy,
  appLocaleFromLanguage,
  getAppCopy,
  setAppCopyLanguage,
} from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { EMPTY_SETTINGS } from "../../packages/butler-app/client/ui/src/app/constants.ts";
import { useButlerStore } from "../../packages/butler-app/client/ui/src/app/store.ts";

afterEach(() => {
  setAppCopyLanguage("en");
});

test("app copy follows the settings language", () => {
  setAppCopyLanguage("en");
  expect(appLocaleFromLanguage("en")).toBe("en-US");
  expect(appCopy.sidebar.newChat).toBe("New chat");
  expect(appCopy.settings.title).toBe("Settings");
  expect(appCopy.composer.placeholder).toBe("Ask Butler anything");

  setAppCopyLanguage("ko");
  expect(appLocaleFromLanguage("ko")).toBe("ko-KR");
  expect(appCopy.sidebar.newChat).toBe("새 대화");
  expect(appCopy.settings.title).toBe("설정");
});

test("explicit copy lookup exposes English and Korean locales", () => {
  expect(getAppCopy("en-US").settings.options.english).toBe("English");
  expect(getAppCopy("ko-KR").settings.options.english).toBe("영어");
});

test("settings store switches app copy language when gateway settings load", () => {
  useButlerStore.getState().setSettings({
    ...EMPTY_SETTINGS,
    language: "en",
  });
  expect(appCopy.sidebar.settings).toBe("Settings");

  useButlerStore.getState().setSettings({
    ...EMPTY_SETTINGS,
    language: "ko",
  });
  expect(appCopy.sidebar.settings).toBe("설정");
});

test("document language follows the app locale", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html lang=\"en\"><body></body></html>");
  const saved = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = dom.window.document;
  try {
    setAppCopyLanguage("ko");
    expect(dom.window.document.documentElement.lang).toBe("ko-KR");
    setAppCopyLanguage("en");
    expect(dom.window.document.documentElement.lang).toBe("en-US");
  } finally {
    (globalThis as { document?: unknown }).document = saved;
  }
});

test("English count copy uses singular and plural forms", () => {
  const templates = getAppCopy("en-US").interfaceTemplates;
  expect(templates.activityHistory(false, "Worker", 1)).toBe("Activity · Worker · 1 record");
  expect(templates.activityHistory(true, "Worker", 2)).toBe("Current · Worker · 2 records");
  expect(templates.pendingApprovals(1)).toBe("1 pending approval");
  expect(templates.pendingApprovals(3)).toBe("3 pending approvals");
});

// test-category: format-pin
test("design-system and dashboard labels are localized", () => {
  const en = getAppCopy("en-US");
  const ko = getAppCopy("ko-KR");
  const pick = (copy: typeof en) => [
    copy.interfacePanels.messages7d,
    copy.interfacePanels.messages30d,
    copy.interfaceStatus.workerPhase,
    copy.common.open,
    copy.common.close,
  ];
  expect(pick(en)).toEqual(["7d messages", "30d messages", "Worker phase", "Open", "Close"]);
  for (const [index, value] of pick(ko).entries()) {
    expect(value.length).toBeGreaterThan(0);
    expect(value).not.toBe(pick(en)[index]);
  }
  // Task badges use the Korean product label.
  expect([ko.interfaceStatus.work, ko.interfaceStatus.task]).toEqual(["Work", "작업"]);
});

test("body font stack prefers Hangul faces before the generic family", () => {
  const tokens = readFileSync("packages/butler-app/client/ui/src/libs/design-system/tokens.css", "utf8");
  const fontBody = /--font-body:([^;]+);/u.exec(tokens)?.[1] ?? "";
  const generic = fontBody.lastIndexOf("sans-serif");
  for (const face of ['"Apple SD Gothic Neo"', '"Noto Sans KR"', '"Malgun Gothic"']) {
    expect(fontBody.indexOf(face)).toBeGreaterThan(-1);
    expect(fontBody.indexOf(face)).toBeLessThan(generic);
  }
});

test("localized components carry no hardcoded English labels", () => {
  const result = spawnSync("bun", ["run", "packages/butler-app/scripts/lint/app-client-copy-lint.ts"], { encoding: "utf8" });
  expect(`${result.status}\n${result.stderr}`).toBe("0\n");
  const ui = "packages/butler-app/client/ui/src";
  const lint = readFileSync("packages/butler-app/scripts/lint/app-client-copy-lint.ts", "utf8");
  for (const file of [
    "libs/design-system/shadcn/ui/dialog.tsx",
    "components/management/ProjectStatsGrid.tsx",
    "components/management/ProjectWorkStatistics.tsx",
    "libs/design-system/blocks/WorkerActivityRow/WorkerActivityRow.tsx",
    "libs/design-system/blocks/CommandPanel/CommandPanel.tsx",
    "libs/design-system/blocks/DocumentTile/DocumentTile.tsx",
  ]) {
    expect(lint).toContain(file);
    expect(readFileSync(`${ui}/${file}`, "utf8")).not.toMatch(/>\s*(?:Close|Work|Task)\s*<|"(?:7d|30d) messages"|"Worker phase"|"Search commands"|actionLabel = "Open"/u);
  }
});

test("empty project plan lanes use localized copy", () => {
  expect(getAppCopy("en-US").interfaceTemplates.emptyLane("Plan")).toBe("No plan items");
  expect(getAppCopy("ko-KR").interfaceTemplates.emptyLane("계획")).toBe("계획 항목이 없습니다.");
  const panel = readFileSync(
    "packages/butler-app/client/ui/src/components/management/ProjectDocumentsPanel.tsx",
    "utf8",
  );
  expect(panel).not.toContain("items`");
  expect(panel).toContain("interfaceTemplates.emptyLane(tab.label)");
});
