import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
  expect(getAppCopy("en-US").briefing.general.suggestions[0].title).toBe("Downloads folder cleanup");
});

// test-category: pure-logic
test("general briefing cards keep the same everyday tasks in both locales", () => {
  const ko = getAppCopy("ko-KR").briefing.general.suggestions;
  const en = getAppCopy("en-US").briefing.general.suggestions;
  expect(ko.map(({ id }) => id)).toEqual([
    "organize-download-folder",
    "summarize-document",
    "draft-reply",
    "morning-briefing",
  ]);
  expect(en.map(({ id }) => id)).toEqual(ko.map(({ id }) => id));
  expect(ko.map(({ title, description, text }) => [title, description, text])).toEqual([
    ["다운로드 폴더 정리하기", "이 컴퓨터의 파일을 살펴보고 옮기기 전에 묻습니다.", "다운로드 폴더를 종류별로 정리해줘. 옮기기 전에 계획부터 보여줘."],
    ["문서 요약하기", "첨부하거나 붙여 넣은 문서의 핵심을 정리합니다.", "이 내용을 핵심만 요약해줘: "],
    ["답장 초안 쓰기", "짧은 메모를 바탕으로 답장 초안을 씁니다.", "이 메모로 답장 초안을 써줘: "],
    ["매일 아침 브리핑 받기", "날씨·뉴스·일정을 8시에 전하는 예약 작업을 만듭니다.", "매일 아침 8시에 날씨와 뉴스, 오늘 일정을 알려주는 예약 작업을 만들어줘."],
  ]);
  expect(en.map(({ title, description, text }) => [title, description, text])).toEqual([
    ["Downloads folder cleanup", "Butler checks files on this computer and asks before moving them.", "Sort my Downloads folder by type. Show me the plan before moving anything."],
    ["Document summary", "Attach or paste a document to get the key points.", "Summarize this in a few key points: "],
    ["Reply draft", "Turn a short note into a clear reply.", "Draft a reply from this note: "],
    ["Morning briefing", "Create a daily 8 AM schedule for weather, news, and today's plans.", "Create a daily 8 AM schedule with weather, news, and today's plans."],
  ]);
  expect(ko.filter(({ template }) => template).map(({ id }) => id)).toEqual([
    "summarize-document",
    "draft-reply",
  ]);
  expect(en.filter(({ template }) => template).map(({ id }) => id)).toEqual([
    "summarize-document",
    "draft-reply",
  ]);
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
  expect(ko.settings.wallpaper.none).toBe("없음");
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
  expect(ko.projectSignpost.work).toBe("작업");
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
    chat: "Chat", project: "Project", project_session: "Project chat", group: "Space", automation: "Schedule", settings: "Settings",
  });
  expect(getAppCopy("ko-KR").commandPalette.kindLabels).toEqual({
    chat: "대화", project: "프로젝트", project_session: "프로젝트 대화", group: "스페이스", automation: "예약 작업", settings: "설정",
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

test("Korean glossary: Butler uses Latin spelling, 시간대 not 타임존, 아카이브 not 보관함", () => {
  const ko = strings(getAppCopy("ko-KR"));
  expect(ko.filter((text) => /타임존|보관함|버틀러|Butler App/u.test(text))).toEqual([]);
  expect(getAppCopy("ko-KR").settings.fields.timezone).toBe("시간대");
  expect(getAppCopy("ko-KR").space.archives).toBe("아카이브");
  expect(getAppCopy("ko-KR").settings.sections.appearance).toBe("모양");
});

test("scheduled-run feature uses one term: 예약 작업 (never 자동화) and Schedule(s) (never Automation or Scheduled task)", () => {
  const koSource = readFileSync(new URL("./locales/ko.ts", import.meta.url), "utf8");
  expect(koSource.split("\n").filter((line) => line.includes("자동화"))).toEqual([]);
  expect(strings(getAppCopy("ko-KR")).filter((text) => text.includes("자동화"))).toEqual([]);
  const enSource = readFileSync(new URL("./locales/en.ts", import.meta.url), "utf8");
  const enLiterals = enSource.match(/(["'`])(?:(?!\1)[^\\\n]|\\.)*\1/gu) ?? [];
  const retiredEnglish = /\bautomations?\b|\bscheduled tasks?\b/iu;
  expect(enLiterals.filter((literal) => retiredEnglish.test(literal))).toEqual([]);
  expect(strings(getAppCopy("en-US")).filter((text) => retiredEnglish.test(text))).toEqual([]);
  for (const [locale, term] of [["ko-KR", "예약 작업"], ["en-US", "Schedules"]] as const) {
    const copy = getAppCopy(locale);
    expect([copy.space.automations, copy.sidebar.automations, copy.automations.title, copy.inspector.tabs.automations]).toEqual([term, term, term, term]);
  }
});

test("API key copy claims Keychain storage only where the agent reports it (#217)", () => {
  // Unsigned builds keep keys in a local file (#243), so first run says only "this computer".
  expect(getAppCopy("en-US").firstRun.keyStored).toBe("Your key stays on this computer.");
  expect(getAppCopy("ko-KR").firstRun.keyStored).toBe("키는 이 컴퓨터에만 저장됩니다.");
  expect(getAppCopy("en-US").settings.savedKeys.storage.local).toBe("Stored only on this computer");
  expect(getAppCopy("ko-KR").settings.savedKeys.storage.local).toBe("이 컴퓨터에만 저장");
  for (const locale of ["en-US", "ko-KR"] as const) {
    const copy = getAppCopy(locale);
    const reported = new Set(Object.values(copy.settings.savedKeys.storage));
    const claims = strings(copy).filter((text) => !reported.has(text) && /keychain|키체인|secure storage|encrypt|암호화/iu.test(text));
    expect(claims, locale).toEqual([]);
  }
});

test("the schedule access hint names the Ask first mode with the composer's label", () => {
  for (const locale of ["en-US", "ko-KR"] as const) {
    const copy = getAppCopy(locale);
    expect(copy.automations.accessHint).toContain(copy.permissions.askFirst);
    expect(copy.automations.accessHint).not.toContain("\n");
  }
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
