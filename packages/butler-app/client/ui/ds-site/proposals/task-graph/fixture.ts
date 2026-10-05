import type { ProposalLocale, Scenario, TaskStatus } from "./copy";

// Proposal-only fixtures. The shape mirrors the read model Codex adds (see the spec on the page):
// GET /sessions/{id}/task-graph -> { nodes, edges, revision, cursor }. Each node also carries the
// worker's child session id (opens the existing session dialog) and its task document ref
// (opens the existing project document dialog). Times are offsets from "now".

type L = Record<ProposalLocale, string>;
const t = (ko: string, en: string): L => ({ "ko-KR": ko, "en-US": en });

export interface TaskNode {
  id: string;
  title: L;
  status: TaskStatus;
  /** Worker ordinal and model display name; absent until assigned. */
  assignee?: { ordinal: number; model: string };
  /** Seconds before now the attempt started. */
  startedAgo?: number;
  /** Seconds the finished attempt took (terminal states). */
  took?: number;
  /** Current steps of a running worker (rolled in the card); finished steps for the detail. */
  steps: L[];
  reason?: L;
  /** Spec node the task implements and its done criteria (the task document body). */
  spec?: string;
  criteria?: L[];
}

/** The worker's child session: present once the task is assigned. */
export const sessionIdOf = (node: TaskNode) => (node.assignee ? `task-session-${node.id}` : undefined);

export interface TaskEdge { from: string; to: string }
export interface TaskGraph { nodes: TaskNode[]; edges: TaskEdge[] }

const LUNA = "GPT-6 Luna";
const SOL = "GPT-6.1 Sol";

const scan: TaskNode = {
  id: "scan", title: t("다운로드 폴더 훑어보기", "Scan the Downloads folder"), status: "completed",
  assignee: { ordinal: 1, model: LUNA }, startedAgo: 260, took: 48,
  steps: [t("파일 412개 확인", "Checked 412 files"), t("종류별로 묶기", "Grouped by type")],
};
const rules: TaskNode = {
  id: "rules", title: t("정리 기준 정하기", "Decide how to sort"), status: "completed",
  assignee: { ordinal: 1, model: LUNA }, startedAgo: 210, took: 72,
  steps: [t("기준 3가지 비교", "Compared three rules"), t("날짜 + 종류로 결정", "Chose date + type")],
};
const move: TaskNode = {
  id: "move", title: t("파일 옮기고 이름 정리하기", "Move and rename files"), status: "running",
  assignee: { ordinal: 2, model: LUNA }, startedAgo: 125,
  steps: [t("사진 폴더로 옮기는 중", "Moving photos"), t("문서 이름 고치는 중", "Renaming documents"), t("중복 파일 확인 중", "Checking duplicates")],
};

const brief: TaskNode = {
  id: "brief", title: t("비교 기준 정리", "Set comparison criteria"), status: "completed",
  assignee: { ordinal: 1, model: SOL }, startedAgo: 640, took: 95,
  steps: [t("요청에서 기준 5개 추출", "Pulled five criteria from the request")],
};
const research = (id: string, app: string, status: TaskStatus, extra: Partial<TaskNode> = {}): TaskNode => ({
  id, title: t(`${app} 조사`, `Research ${app}`), status,
  assignee: { ordinal: Number(id.slice(-1)) + 1, model: LUNA },
  steps: [t("요금제 페이지 읽는 중", "Reading the pricing page"), t("동기화 방식 확인 중", "Checking sync"), t("사용 후기 모으는 중", "Collecting reviews")],
  ...extra,
});
const compare = (status: TaskStatus, extra: Partial<TaskNode> = {}): TaskNode => ({
  id: "compare", title: t("세 앱 비교표 만들기", "Build the comparison table"), status,
  steps: [t("기준별 점수 매기기", "Scoring each criterion")], ...extra,
});
const review = (status: TaskStatus): TaskNode => ({
  id: "review", title: t("결과 검토", "Review the result"), status, steps: [],
});

const fan = (nodes: TaskNode[]): TaskGraph => ({
  nodes,
  edges: [
    { from: "brief", to: "r1" }, { from: "brief", to: "r2" }, { from: "brief", to: "r3" },
    { from: "r1", to: "compare" }, { from: "r2", to: "compare" }, { from: "r3", to: "compare" },
    { from: "compare", to: "review" },
  ],
});

const chainEdges = [{ from: "scan", to: "rules" }, { from: "rules", to: "move" }];

function longGraph(): TaskGraph {
  const n = (id: string, ko: string, en: string, status: TaskStatus, ordinal?: number, extra: Partial<TaskNode> = {}): TaskNode => ({
    id, title: t(ko, en), status,
    assignee: ordinal ? { ordinal, model: ordinal % 2 ? LUNA : SOL } : undefined,
    startedAgo: status === "pending" ? undefined : 1800 - ordinal! * 60,
    took: status === "completed" ? 60 + ordinal! * 23 : undefined,
    steps: [t("코드 읽는 중", "Reading code"), t("변경 적용 중", "Applying the change"), t("결과 확인 중", "Checking the result")],
    ...extra,
  });
  const nodes = [
    n("l1", "요구사항 확인", "Confirm requirements", "completed", 1),
    n("l2", "현재 검색 코드 조사", "Study the search code", "completed", 1),
    n("l3a", "정렬 함수 고치기", "Fix the ranking function", "completed", 2),
    n("l3b", "색인 다시 만들기", "Rebuild the index", "completed", 3),
    n("l3c", "화면 문구 정리", "Tidy the result labels", "completed", 4),
    n("l4", "변경 합치기", "Merge the changes", "completed", 1),
    n("l5a", "한국어 검색 확인", "Check Korean search", "completed", 2),
    n("l5b", "영어 검색 확인", "Check English search", "running", 3, {}),
    n("l5c", "속도 측정", "Measure speed", "running", 4, {}),
    n("l5d", "화면 확인", "Check the screen", "pending"),
    n("l6", "결과 검토", "Review results", "pending"),
    n("l7", "지적 사항 반영", "Apply review notes", "pending"),
    n("l8a", "도움말 갱신", "Update help", "pending"),
    n("l8b", "변경 기록 작성", "Write the changelog", "pending"),
    n("l9", "최종 확인", "Final check", "pending"),
    n("l10", "결과 보고", "Report back", "pending"),
  ];
  const e = (from: string, ...to: string[]) => to.map((target) => ({ from, to: target }));
  return {
    nodes,
    edges: [
      ...e("l1", "l2"), ...e("l2", "l3a", "l3b", "l3c"), ...e("l3a", "l4"), ...e("l3b", "l4"), ...e("l3c", "l4"),
      ...e("l4", "l5a", "l5b", "l5c", "l5d"), ...["l5a", "l5b", "l5c", "l5d"].flatMap((id) => e(id, "l6")),
      ...e("l6", "l7"), ...e("l7", "l8a", "l8b"), ...e("l8a", "l9"), ...e("l8b", "l9"), ...e("l9", "l10"),
    ],
  };
}

export function scenarioGraph(scenario: Scenario): TaskGraph {
  switch (scenario) {
    case "empty": return { nodes: [], edges: [] };
    case "one": return { nodes: [{ ...move, id: "one", assignee: { ordinal: 1, model: LUNA } }], edges: [] };
    case "chain": return { nodes: [scan, rules, move], edges: chainEdges };
    case "fanout": return fan([
      brief,
      research("r1", "Obsidian", "completed", { startedAgo: 540, took: 184 }),
      research("r2", "Notion", "running", { startedAgo: 540 }),
      research("r3", "Bear", "running", { startedAgo: 540 }),
      compare("pending"), review("pending"),
    ]);
    case "failed": return fan([
      brief,
      research("r1", "Obsidian", "completed", { startedAgo: 540, took: 184 }),
      research("r2", "Notion", "failed", { startedAgo: 540, took: 211, reason: t("요금제 페이지를 열 수 없습니다", "The pricing page did not open") }),
      research("r3", "Bear", "completed", { startedAgo: 540, took: 166 }),
      compare("blocked"), review("pending"),
    ]);
    case "cancelled": return {
      nodes: [scan, { ...rules, status: "cancelled", took: 31 }, { ...move, status: "cancelled", assignee: undefined, startedAgo: undefined }],
      edges: chainEdges,
    };
    case "long": return longGraph();
  }
}
