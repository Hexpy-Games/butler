import { expect, test } from "bun:test";
import { getAppCopy, getInterfaceProgressLabel } from "./index.ts";

function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, shape(nested)]));
  return typeof value;
}

test("English and Korean catalogs have complete recursive key and formatter parity", () => {
  expect(shape(getAppCopy("en-US"))).toEqual(shape(getAppCopy("ko-KR")));
  expect(getAppCopy("en-US").conversation.work.collapsedSummary("Read file", 2)).toBe("Read file and 1 more activities");
  expect(getAppCopy("ko-KR").space.general).toBe("일반");
  expect(getAppCopy("en-US").briefing.general.suggestions[0].title).toBe("Worth a short look today");
});

test("Korean catalog uses Korean for generic UI words", () => {
  const ko = getAppCopy("ko-KR");
  expect(ko.composer.workspaceLocal).toBe("로컬");
  expect(ko.composer.workspaceWorktree).toBe("워크트리");
  expect(ko.titlebar.localWorkspace()).toBe("로컬");
  expect(ko.composer.modelSearch).toBe("모델 검색...");
  expect(ko.composer.modelSearchClear).toBe("검색 지우기");
  expect(ko.composer.allProviders).toBe("전체");
  expect(ko.composer.noModels).toBe("모델을 찾을 수 없습니다");
  expect(ko.settings.modelManagement.apiKey).toBe("API 키");
  expect(ko.settings.modelManagement.apiKeyAuth).toBe("API 키");
  expect(ko.settings.modelManagement.apiBaseUrl).toBe("API 기본 URL");
  expect(ko.settings.fields.searchProviderApiKey).toBe("API 키");
  expect(ko.settings.options.mainScreenThemeNone).toBe("없음");
  expect(ko.settings.developerLogViewer.labels.raw).toBe("원본");
  expect(ko.conversation.work.webSearchSummary(3)).toBe("웹 검색 3회");
  expect(ko.conversation.work.toolStepsSummary("read_file", 2)).toBe("read_file 2단계");
  expect(ko.conversation.work.webSearchDetail("butler")).toBe("웹 검색: butler");
});

test("Korean copy keeps the Work, Task, Worker and Custom product terms consistent", () => {
  const ko = getAppCopy("ko-KR");
  const strings: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (typeof value === "function" && value.length === 0) collect((value as () => unknown)());
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(ko);
  expect(strings.filter((text) => /워커|작업자/u.test(text))).toEqual([]);
  expect(ko.interfaceStatus.work).toBe("Work");
  expect(ko.interfaceStatus.task).toBe("Task");
  expect(ko.inspector.tabs.workers).toBe("Worker");
  expect(ko.interfaceStatus.workerCall).toBe("Worker 호출");
  expect(ko.projectSignpost.work).toBe("Work");
  expect(ko.projectSignpost.parentWork).toBe("상위 Work");
  expect(ko.projectSignpost.tasks).toBe("하위 Task");
  expect(ko.projectStatistics.labels.work).toBe("Work 변경");
  expect(ko.settings.localModels.customOpenAiCompatible).toBe("Custom OpenAI 호환");
});

test("worked durations use locale units", () => {
  const en = getAppCopy("en-US").interfaceTemplates.workedDuration;
  const ko = getAppCopy("ko-KR").interfaceTemplates;
  expect([en(0), en(59), en(60), en(65), en(754)]).toEqual(["0s", "59s", "1m 00s", "1m 05s", "12m 34s"]);
  expect([0, 59, 60, 65, 754].map(ko.workedDuration)).toEqual(["0초", "59초", "1분 00초", "1분 05초", "12분 34초"]);
  expect(ko.workedFor(ko.workedDuration(0))).toBe("0초 동안 작업");
});

test("command palette kind labels are localized", () => {
  expect(getAppCopy("en-US").commandPalette.kindLabels).toEqual({
    chat: "Chat", project: "Project", project_session: "Project chat", group: "Space", automation: "Automation", settings: "Settings",
  });
  expect(getAppCopy("ko-KR").commandPalette.kindLabels).toEqual({
    chat: "대화", project: "프로젝트", project_session: "프로젝트 대화", group: "스페이스", automation: "자동화", settings: "설정",
  });
});

test("runtime-owned operation and progress keys localize without interpreting authored text", () => {
  expect(getInterfaceProgressLabel("operation:read_file", "en-US")).toBe("Reading: checking relevant file contents");
  expect(getInterfaceProgressLabel("operation:read_file", "ko-KR")).toBe("조회: 관련 파일 내용을 확인 중");
  expect(getInterfaceProgressLabel("accepted", "en-US")).toBe("Request accepted.");
  expect(getInterfaceProgressLabel("reconnecting", "ko-KR", { attempt: 2, maxAttempts: 4 })).toBe("재연결 중 (2/4)");
  expect(getInterfaceProgressLabel(undefined, "en-US")).toBeUndefined();
  expect(getInterfaceProgressLabel("작업 중", "en-US")).toBeUndefined();
});

function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (typeof value === "function" && value.length === 0) strings((value as () => unknown)(), into);
  else if (value && typeof value === "object") Object.values(value).forEach((nested) => strings(nested, into));
  return into;
}

test("Korean glossary: 시간대 not 타임존, 아카이브 not 보관함, 버틀러 not Butler App", () => {
  const ko = strings(getAppCopy("ko-KR"));
  expect(ko.filter((text) => /타임존|보관함|Butler App/u.test(text))).toEqual([]);
  expect(getAppCopy("ko-KR").settings.fields.timezone).toBe("시간대");
  expect(getAppCopy("ko-KR").space.archives).toBe("아카이브");
  expect(getAppCopy("ko-KR").settings.sections.appearance).toBe("모양");
});

test("settings titles never use the A / B style in either locale", () => {
  for (const locale of ["en-US", "ko-KR"] as const) {
    const copy = getAppCopy(locale);
    const titles = strings([
      copy.settings.sections,
      copy.settings.panels,
      copy.settings.pageSections,
      copy.settings.fields,
      copy.commandPalette.settingsSections,
    ]);
    expect(titles.filter((text) => /\S\s*\/\s*\S/u.test(text)), locale).toEqual([]);
  }
});
