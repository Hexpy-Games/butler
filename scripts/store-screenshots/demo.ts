import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { bridgeBrowser, describeBrowser, latestBrowser } from "../../tests/support/browser-agent-stub.ts";
import { startStubModel, type StubModelRequest } from "../../tests/support/native-app-server.ts";
import type { Api, Locale } from "./app.ts";
import { memoryReply } from "./memory-stub.ts";

export const demoRoot = "C:\\Users\\Demo";
const downloads = `${demoRoot}\\Downloads`;

const names = {
  ko: [
    "2026_여행_일정표.pdf", "11월_관리비_영수증.pdf", "주간회의록_1124.docx", "신제품_발표자료.pptx", "설치_안내서.pdf",
    "2026_가계부.xlsx", "거래처_목록.csv", "강아지_산책_01.jpg", "강아지_산책_02.jpg", "가족사진_1102.jpg", "스크린샷_1127.png", "레시피_모음.zip",
  ],
  en: [
    "2026_trip_itinerary.pdf", "utility_receipt_nov.pdf", "meeting_notes_1124.docx", "product_launch_slides.pptx", "setup_guide.pdf",
    "budget_2026.xlsx", "supplier_list.csv", "dog_walk_01.jpg", "dog_walk_02.jpg", "family_photo_1102.jpg", "screenshot_1127.png", "recipes.zip",
  ],
};
const folders = { ko: ["문서", "표", "사진", "압축 파일"], en: ["Documents", "Spreadsheets", "Photos", "Archives"] };
const extensions = [[".pdf", ".docx", ".pptx"], [".xlsx", ".csv"], [".jpg", ".png"], [".zip"]];

export const demoModel = {
  model_id: "stub", model_ref: "local/stub", display_name: "Qwen3 8B", platform: "lm_studio",
  context_window_tokens: 128000, max_output_tokens: 8192, reasoning_budget_ratio: 0.25,
};

const copy = {
  ko: {
    navSchedules: "예약 작업", newSchedule: "새 예약 작업", moveFiles: "파일 종류별로 이동", zipPhotos: "사진 압축",
    zip: "사진_2026-11.zip",
    memory: ["보고서는 표로 정리하고 끝에 세 줄 요약을 붙인다.", "파일 이름은 '날짜_내용' 형식으로 짓는다."],
    profileImport: "답은 짧고 정중하게 받는 것을 좋아합니다. 보고서는 표로 받고 싶습니다.",
    profileSummary: "짧고 정중한 답을 선호합니다.",
    patterns: [
      ["파일 정리 맡기기", "다운로드와 사진 정리를 버틀러에게 맡깁니다."],
      ["설명서 찾아보기", "버틀러 설명서에서 사용법을 찾아봅니다."],
    ],
    D: ["보고서 작성 방식", "앞으로 보고서는 표로 정리하고 끝에 세 줄 요약을 붙여 주세요. 파일 이름은 날짜_내용 형식으로 지어 주세요.", "알겠습니다. 두 가지 모두 지침으로 저장했습니다."],
    C: ["예약 작업 만드는 법", "버틀러 설명서에서 예약 작업 만드는 방법을 찾아 주세요.", "설명서의 '예약 작업' 페이지에서 찾았습니다.\n\n1. 사이드바에서 **예약 작업**을 누릅니다.\n2. **새 예약 작업**을 누르고 제목과 프롬프트를 입력합니다.\n3. 대상 대화, 모델, 권한, 주기를 고릅니다.\n4. **저장**을 누르면 목록에 나타납니다."],
    A: ["다운로드 폴더 정리", "다운로드 폴더를 파일 종류별로 정리해 주세요.", "다운로드 폴더를 정리했습니다.\n\n| 폴더 | 파일 | 예 |\n|---|---|---|\n| 문서 | 5개 | 2026_여행_일정표.pdf |\n| 표 | 2개 | 2026_가계부.xlsx |\n| 사진 | 4개 | 가족사진_1102.jpg |\n| 압축 파일 | 1개 | 레시피_모음.zip |\n\n지운 파일은 없습니다."],
    B: ["11월 사진 압축", "사진 폴더의 2026-11 사진을 압축해서 바탕 화면에 저장해 주세요.", ""],
    schedules: [
      ["아침 브리핑", "오늘 일정과 날씨를 짧게 정리해 주세요."],
      ["다운로드 폴더 정리", "다운로드 폴더를 파일 종류별로 정리해 주세요."],
      ["주간 가계부 요약", "이번 주 가계부를 표로 요약해 주세요."],
      ["할 일 확인", "남은 할 일을 확인해 주세요."],
      ["평일 업무 정리", "오늘 한 일을 세 줄로 정리해 주세요."],
      ["월요일 주간 계획", "이번 주 할 일을 표로 정리해 주세요."],
    ],
  },
  en: {
    navSchedules: "Schedules", newSchedule: "New schedule", moveFiles: "Move files by type", zipPhotos: "Zip photos",
    zip: "nov_photos.zip",
    memory: ["Put reports in a table and end with a three-line summary.", "Name files as date_topic."],
    profileImport: "I like short, polite answers. I want reports as tables.",
    profileSummary: "Prefers short, polite answers.",
    patterns: [
      ["Hand off file cleanup", "Asks Butler to sort downloads and photos."],
      ["Look things up in the manual", "Asks Butler to find how-tos in its manual."],
    ],
    D: ["Report style", "From now on, put reports in a table and end with a three-line summary. Name files as date_topic.", "Got it. I saved both as instructions."],
    C: ["How to create a schedule", "Find how to create a schedule in the Butler manual.", "I found it on the manual's Schedules page.\n\n1. Click **Schedules** in the sidebar.\n2. Click **New schedule** and enter a title and a prompt.\n3. Choose the target chat, model, permission and frequency.\n4. Click **Save**; it appears in the list."],
    A: ["Tidy the Downloads folder", "Sort my Downloads folder by file type.", "I organized the Downloads folder.\n\n| Folder | Files | Example |\n|---|---|---|\n| Documents | 5 | 2026_trip_itinerary.pdf |\n| Spreadsheets | 2 | budget_2026.xlsx |\n| Photos | 4 | family_photo_1102.jpg |\n| Archives | 1 | recipes.zip |\n\nNothing was deleted."],
    B: ["Zip November photos", "Zip the 2026-11 photos in my Pictures folder and save it to the Desktop.", ""],
    schedules: [
      ["Morning briefing", "Briefly summarize today's schedule and weather."],
      ["Tidy Downloads", "Sort my Downloads folder by file type."],
      ["Weekly budget summary", "Summarize this week's budget in a table."],
      ["To-do check", "Check what is left on my to-do list."],
      ["Weekday wrap-up", "Summarize what I did today in three lines."],
      ["Monday plan", "Put this week's to-dos in a table."],
    ],
  },
} as const;

type ToolCall = ReturnType<typeof bridgeBrowser>;
type Step = (request: StubModelRequest) => ToolCall | null;
type Language = Locale["language"];
export const chatOrder = ["D", "C", "A", "B"] as const;
export type Chat = typeof chatOrder[number];

export function demo(language: Language) {
  const words = copy[language];
  const organize = folders[language].map((folder, index) => {
    const target = `'${downloads}\\${folder}'`;
    const files = names[language].filter(name => extensions[index].includes(extname(name)))
      .map(name => `'${downloads}\\${name}'`).join(", ");
    return `New-Item -ItemType Directory ${target} | Out-Null\nMove-Item ${files} -Destination ${target}`;
  }).join("\n");
  const zip = `Compress-Archive ${demoRoot}\\Pictures\\2026-11 ${demoRoot}\\Desktop\\${words.zip}`;
  return { ...words, organize, zip, zipName: words.zip, helpPath: language === "ko" ? "/help/" : "/en/help/" };
}
export type Demo = ReturnType<typeof demo>;

function observationText(request: StubModelRequest) {
  const observation = latestBrowser(request, "obs");
  return { observation, text: (observation.untrusted_content as { text: string }).text };
}

function script(words: Demo): Record<Chat, Step[]> {
  const list = () => ({ name: "list_files", arguments: { root: downloads } });
  const observe: Step = request => bridgeBrowser("browser_observe", { tab: latestBrowser(request, "tab").tab });
  return {
    D: words.memory.map(text => () => ({
      name: "update_explicit_memory", arguments: { kind: "instruction", text, source: "user message", duration: "always" },
    })),
    C: [
      describeBrowser, () => bridgeBrowser("browser_open", { url: `https://butler.hexpy.games${words.helpPath}` }), observe,
      request => {
        const { observation, text } = observationText(request);
        const ref = new RegExp(`link "${words.navSchedules}" \\[([^\\]]+)\\]`, "u").exec(text)?.[1];
        assert(ref, `Manual observation has no link named ${words.navSchedules}`);
        return bridgeBrowser("browser_act", { tab: observation.tab, observation: observation.obs, steps: [{ action: "click", ref }] });
      },
      observe,
      request => {
        assert(observationText(request).text.includes(words.newSchedule), `Schedules page did not show ${words.newSchedule}`);
        return null;
      },
    ],
    A: [
      list,
      () => ({ name: "run_command", arguments: { command: words.organize, state_effect: "mutation", summary: words.moveFiles } }),
      list,
    ],
    B: [() => ({ name: "run_command", arguments: { command: words.zip, state_effect: "mutation", summary: words.zipPhotos } })],
  };
}

export async function startDemoStub(words: Demo, counts: Record<string, number>) {
  const calls: StubModelRequest[] = [];
  const errors = new Map<Chat, string>();
  const steps = script(words);
  const tools = new WeakMap<StubModelRequest, ToolCall>();
  let current: Chat | undefined;
  const match = (request: StubModelRequest) => chatOrder.find(chat =>
    request.messages.some(message => {
      const { role, content } = message as { role?: string; content?: unknown };
      return role === "user" && JSON.stringify(content)?.includes(words[chat][1]);
    }));
  const conversation = (request: StubModelRequest) => request.stream && Array.isArray(request.body.tools) && request.body.tools.length > 0;
  const stub = await startStubModel(request => {
    const hasTools = Array.isArray(request.body.tools) && request.body.tools.length > 0;
    if (!hasTools) {
      const reply = memoryReply(request, words, counts);
      if (reply !== undefined) return reply;
    }
    const chat = match(request) ?? (conversation(request) ? undefined : current);
    if (!chat) return "";
    counts[chat] = (counts[chat] ?? 0) + 1;
    if (!conversation(request)) return words[chat][0];
    const round = request.messages.filter(message => (message as { role?: string }).role === "tool").length;
    try {
      const tool = steps[chat][round]?.(request);
      if (!tool) return words[chat][2];
      tools.set(request, tool);
    } catch (error) {
      errors.set(chat, String(error));
    }
    return "";
  }, calls, request => tools.get(request) ?? null);
  return {
    ...stub,
    select: (chat: Chat) => { current = chat; counts[chat] ??= 0; },
    check: (chat: Chat) => assert(!errors.has(chat), errors.get(chat)),
    stop: () => new Promise<void>(done => { stub.server.close(() => done()); stub.server.closeAllConnections(); }),
  };
}

export function populateDemoFiles(language: Language) {
  const pictures = join(demoRoot, "Pictures", "2026-11");
  for (const folder of [downloads, pictures, join(demoRoot, "Desktop")]) mkdirSync(folder, { recursive: true });
  const jpeg = readFileSync(new URL("../../packages/butler-agent/rust/crates/butler-e2e/tests/e2e/browser_outputs/pixel.jpg", import.meta.url));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xc2kAAAAASUVORK5CYII=", "base64");
  const zip = Buffer.alloc(22);
  zip.writeUInt32LE(0x06054b50);
  const contents: Record<string, Buffer | string> = {
    ".pdf": "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
    ".csv": "Supplier,Category\nSample,Office\n",
    ".jpg": jpeg, ".png": png, ".zip": zip, ".xlsx": zip, ".docx": zip, ".pptx": zip,
  };
  for (const name of names[language]) writeFileSync(join(downloads, name), contents[extname(name)]);
  for (let n = 1; n <= 6; n++) writeFileSync(join(pictures, `photo_0${n}.jpg`), jpeg);
}

export function assertOrganized(language: Language) {
  assert.deepEqual(readdirSync(downloads).sort(), [...folders[language]].sort());
  for (const [index, folder] of folders[language].entries()) {
    const expected = names[language].filter(name => extensions[index].includes(extname(name))).sort();
    assert.deepEqual(readdirSync(join(downloads, folder)).sort(), expected, `Files in ${folder}`);
  }
}

export async function createSchedules(api: Api, language: Language, downloadsSession: string) {
  const tz = language === "ko" ? "Asia/Seoul" : "America/New_York";
  const cadence = [
    { schedule: { kind: "daily", time: "08:00", tz } },
    { schedule: { kind: "weekly", time: "18:00", weekdays: [5], tz } },
    { schedule: { kind: "weekly", time: "20:00", weekdays: [7], tz } },
    { interval_seconds: 7200 },
    { schedule: { kind: "weekly", time: "18:30", weekdays: [1, 2, 3, 4, 5], tz } },
    { schedule: { kind: "weekly", time: "09:00", weekdays: [1], tz } },
  ];
  for (const [index, [title, prompt_body]] of copy[language].schedules.entries()) {
    const target_session_id = index === 1 ? downloadsSession : "general";
    await api("/automations", "POST", { title, prompt_body, target_session_id, ...cadence[index] });
  }
}
