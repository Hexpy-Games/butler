import { expect, test } from "bun:test";
import { getAppCopy } from "@/app/copy.ts";
import type { CommandPaletteResult } from "@/app/types.ts";
import { commandResultSubtitle } from "./commandPaletteLabels";

const result = (kind: CommandPaletteResult["kind"], subtitle?: string): CommandPaletteResult =>
  ({ id: "x", kind, title: "t", subtitle, route: "" });

test("server kind fallbacks become localized kind labels", () => {
  const labels = getAppCopy("ko-KR").commandPalette.kindLabels;
  expect(commandResultSubtitle(result("chat", "Chat"), labels)).toBe("대화");
  expect(commandResultSubtitle(result("project_session", "Project chat"), labels)).toBe("프로젝트 대화");
  expect(commandResultSubtitle(result("project", "Project"), labels)).toBe("프로젝트");
  expect(commandResultSubtitle(result("group", "스페이스"), labels)).toBe("스페이스");
  expect(commandResultSubtitle(result("settings", "Settings"), labels)).toBe("설정");
  expect(commandResultSubtitle(result("automation"), labels)).toBe("예약 작업");
  expect(commandResultSubtitle(result("group", "스페이스"), getAppCopy("en-US").commandPalette.kindLabels)).toBe("Space");
});

test("location subtitles pass through unchanged", () => {
  const labels = getAppCopy("ko-KR").commandPalette.kindLabels;
  expect(commandResultSubtitle(result("chat", "Butler › Design"), labels)).toBe("Butler › Design");
  expect(commandResultSubtitle(result("automation", "매일 09:00"), labels)).toBe("매일 09:00");
});
