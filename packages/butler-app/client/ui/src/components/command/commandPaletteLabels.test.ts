import { expect, test } from "bun:test";
import { getAppCopy } from "@/app/copy.ts";
import type { CommandPaletteResult } from "@/app/types.ts";
import { commandResultSubtitle, commandResultTitle } from "./commandPaletteLabels";

const result = (kind: CommandPaletteResult["kind"], subtitle?: string): CommandPaletteResult =>
  ({ id: "x", kind, title: "t", subtitle, route: "" });

test("server kind fallbacks become localized kind labels", () => {
  const labels = getAppCopy("ko-KR").commandPalette.kindLabels;
  expect(commandResultSubtitle(result("chat", "Chat"), labels)).toBe("대화");
  expect(commandResultSubtitle(result("project_session", "Project chat"), labels)).toBe("프로젝트 대화");
  expect(commandResultSubtitle(result("project", "Project"), labels)).toBe("프로젝트");
  expect(commandResultSubtitle(result("group", "스페이스"), labels)).toBe("스페이스");
  expect(commandResultSubtitle(result("settings", "Settings"), labels)).toBe("설정");
  expect(commandResultSubtitle(result("automation"), labels)).toBe("자동화");
  expect(commandResultSubtitle(result("group", "스페이스"), getAppCopy("en-US").commandPalette.kindLabels)).toBe("Space");
});

test("settings results map their stable id to a localized section title", () => {
  const copy = getAppCopy("ko-KR").commandPalette;
  const settings = (section: string) =>
    ({ id: `settings:${section.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-")}`, kind: "settings", title: section, subtitle: "Settings", route: `settings:${section}` }) as CommandPaletteResult;
  const titles = ["General", "Appearance", "Server/Bridge", "Models/Access", "Privacy/Data", "Diagnostics", "System events", "Archived"]
    .map((section) => commandResultTitle(settings(section), copy.settingsSections));
  expect(titles).toEqual(["일반", "화면", "서버 / 브리지", "모델 / 접근 권한", "개인정보 / 데이터", "진단", "시스템 이벤트", "아카이브"]);
  expect(commandResultTitle(settings("Unknown section"), copy.settingsSections)).toBe("Unknown section");
  expect(commandResultTitle(result("chat"), copy.settingsSections)).toBe("t");
  expect(commandResultTitle(settings("Server/Bridge"), getAppCopy("en-US").commandPalette.settingsSections)).toBe("Server/Bridge");
});

test("location subtitles pass through unchanged", () => {
  const labels = getAppCopy("ko-KR").commandPalette.kindLabels;
  expect(commandResultSubtitle(result("chat", "Butler › Design"), labels)).toBe("Butler › Design");
  expect(commandResultSubtitle(result("automation", "매일 09:00"), labels)).toBe("매일 09:00");
});
