import type { ShowcaseRenderContext } from "../../showcase";
import type { TaskGraphEdge, TaskGraphStatus } from "../../lib/taskGraphLayout";

type ShowcaseLocale = ShowcaseRenderContext["locale"];

// Showcase data for the task graph blocks (stories only). Copy is per locale.

type L = Record<ShowcaseLocale, string>;
const t = (en: string, ko: string): L => ({ "en-US": en, "ko-KR": ko });

export interface DemoTask {
  id: string;
  title: L;
  status: TaskGraphStatus;
  worker?: number;
  model?: string;
  time?: string;
  step?: L;
  reason?: L;
}

export interface DemoGraph {
  id: string;
  title: L;
  tasks: DemoTask[];
  edges: TaskGraphEdge[];
}

export const STATUS: Record<ShowcaseLocale, Record<TaskGraphStatus, string>> = {
  "en-US": { pending: "Waiting", running: "Running", review: "In review", done: "Done", failed: "Failed", blocked: "Blocked", cancelled: "Cancelled", paused: "Paused" },
  "ko-KR": { pending: "대기", running: "진행 중", review: "검토 중", done: "완료", failed: "실패", blocked: "보류", cancelled: "취소됨", paused: "일시정지" },
};

const LUNA = "GPT-6 Luna";
const SOL = "GPT-6.1 Sol";
const step = t("Reading the pricing page", "요금제 페이지 읽는 중");
const e = (from: string, ...to: string[]) => to.map((target) => ({ from, to: target }));

const chain = (done: boolean, cancelled = false): DemoTask[] => [
  { id: "scan", title: t("Scan the Downloads folder", "다운로드 폴더 훑어보기"), status: "done", worker: 1, model: LUNA, time: "48s" },
  { id: "rules", title: t("Decide how to sort", "정리 기준 정하기"), status: cancelled ? "cancelled" : "done", worker: 1, model: LUNA, time: cancelled ? "31s" : "1m 12s" },
  cancelled
    ? { id: "move", title: t("Move and rename files", "파일 옮기고 이름 정리하기"), status: "cancelled" }
    : { id: "move", title: t("Move and rename files", "파일 옮기고 이름 정리하기"), status: done ? "done" : "running", worker: 2, model: LUNA, time: done ? "2m 41s" : "2m 05s", step: t("Renaming documents", "문서 이름 고치는 중") },
];

const research = (failed: boolean): DemoTask[] => [
  { id: "brief", title: t("Set comparison criteria", "비교 기준 정리"), status: "done", worker: 1, model: SOL, time: "1m 35s" },
  { id: "r1", title: t("Research Obsidian", "Obsidian 조사"), status: "done", worker: 2, model: LUNA, time: "3m 04s" },
  failed
    ? { id: "r2", title: t("Research Notion", "Notion 조사"), status: "failed", worker: 3, model: LUNA, time: "3m 31s", reason: t("The pricing page did not open", "요금제 페이지를 열 수 없습니다") }
    : { id: "r2", title: t("Research Notion", "Notion 조사"), status: "running", worker: 3, model: LUNA, time: "9m 01s", step },
  { id: "r3", title: t("Research Bear", "Bear 조사"), status: failed ? "done" : "running", worker: 4, model: LUNA, time: failed ? "2m 46s" : "9m 01s", step },
  { id: "compare", title: t("Build the comparison table", "세 앱 비교표 만들기"), status: failed ? "blocked" : "pending" },
  { id: "review", title: t("Review the result", "결과 검토"), status: "pending" },
];
const researchEdges = [...e("brief", "r1", "r2", "r3"), ...e("r1", "compare"), ...e("r2", "compare"), ...e("r3", "compare"), ...e("compare", "review")];

const LONG: Array<[string, string, string, TaskGraphStatus]> = [
  ["l1", "Confirm requirements", "요구사항 확인", "done"], ["l2", "Study the search code", "현재 검색 코드 조사", "done"],
  ["l3a", "Fix the ranking function", "정렬 함수 고치기", "done"], ["l3b", "Rebuild the index", "색인 다시 만들기", "done"],
  ["l3c", "Tidy the result labels", "화면 문구 정리", "done"], ["l4", "Merge the changes", "변경 합치기", "done"],
  ["l5a", "Check Korean search", "한국어 검색 확인", "done"], ["l5b", "Check English search", "영어 검색 확인", "running"],
  ["l5c", "Measure speed", "속도 측정", "running"], ["l5d", "Check the screen", "화면 확인", "pending"],
  ["l6", "Review results", "결과 검토", "pending"], ["l7", "Apply review notes", "지적 사항 반영", "pending"],
  ["l8a", "Update help", "도움말 갱신", "pending"], ["l8b", "Write the changelog", "변경 기록 작성", "pending"],
  ["l9", "Final check", "최종 확인", "pending"], ["l10", "Report back", "결과 보고", "pending"],
];

const graph = (id: string, title: L, tasks: DemoTask[], edges: TaskGraphEdge[]): DemoGraph => ({ id, title, tasks, edges });

export const GRAPHS = {
  one: graph("one", t("Clean up meeting notes", "회의록 정리"), [{ ...chain(false)[2]!, id: "one", worker: 1 }], []),
  chain: graph("chain", t("Tidy the Downloads folder", "다운로드 폴더 정리"), chain(false), [...e("scan", "rules"), ...e("rules", "move")]),
  chainDone: graph("chainDone", t("Tidy the Downloads folder", "다운로드 폴더 정리"), chain(true), [...e("scan", "rules"), ...e("rules", "move")]),
  cancelled: graph("cancelled", t("Sort the photo backup", "사진 백업 정리"), chain(false, true), [...e("scan", "rules"), ...e("rules", "move")]),
  fanout: graph("fanout", t("Compare three note apps", "노트 앱 세 개 비교"), research(false), researchEdges),
  failed: graph("failed", t("Refresh the pricing table", "요금제 비교표 갱신"), research(true), researchEdges),
  skip: graph("skip", t("Publish the release notes", "릴리스 노트 게시"), [
    { id: "draft", title: t("Draft the notes", "초안 작성"), status: "done", worker: 1, model: SOL, time: "2m 10s" },
    { id: "links", title: t("Check every link", "링크 확인"), status: "running", worker: 2, model: LUNA, time: "1m 02s", step: t("Opening links", "링크 여는 중") },
    { id: "shots", title: t("Retake screenshots", "스크린샷 다시 찍기"), status: "pending" },
    { id: "publish", title: t("Publish", "게시"), status: "pending" },
  ], [...e("draft", "links", "publish"), ...e("links", "shots"), ...e("shots", "publish")]),
  long: graph("long", t("Improve search ranking", "검색 결과 정렬 개선"), LONG.map(([id, en, ko, status], i) => ({
    id, title: t(en, ko), status, ...(status === "pending" ? {} : { worker: (i % 4) + 1, model: i % 2 ? SOL : LUNA, time: status === "running" ? "27m 01s" : `${1 + (i % 3)}m ${10 + i}s` }),
    ...(status === "running" ? { step: t("Reading code", "코드 읽는 중") } : {}),
  })), [
    ...e("l1", "l2"), ...e("l2", "l3a", "l3b", "l3c"), ...["l3a", "l3b", "l3c"].flatMap((id) => e(id, "l4")),
    ...e("l4", "l5a", "l5b", "l5c", "l5d"), ...["l5a", "l5b", "l5c", "l5d"].flatMap((id) => e(id, "l6")),
    ...e("l6", "l7"), ...e("l7", "l8a", "l8b"), ...e("l8a", "l9"), ...e("l8b", "l9"), ...e("l9", "l10"),
  ]),
} satisfies Record<string, DemoGraph>;
