// Proposal-local mirror of the i18n keys this feature adds. The implementation moves `taskGraph`
// into packages/butler-i18n/src/locales/{ko,en}.ts (AppCopy contract) unchanged; product code reads
// it as `appCopy.taskGraph.*`. Page chrome text (PAGE_COPY) is proposal-only and is not shipped.

export type ProposalLocale = "ko-KR" | "en-US";

export type TaskStatus =
  | "pending" | "running" | "awaiting_review" | "completed"
  | "failed" | "cancelled" | "blocked" | "paused";

export interface TaskGraphCopy {
  /** Inspector tab label. */
  tab: string;
  title: string;
  empty: string;
  /** "3/6 완료" */
  doneCount: (done: number, total: number) => string;
  failedCount: (count: number) => string;
  cancelledCount: (count: number) => string;
  status: Record<TaskStatus, string>;
  /** Assignee shown on a card: "작업자 2". */
  assignee: (ordinal: number) => string;
  unassigned: string;
  elapsed: (seconds: number) => string;
  /** Accessible name of a card: title, status, assignee, model, elapsed. */
  cardLabel: (parts: string[]) => string;
  graphLabel: string;
  detail: {
    status: string;
    assignee: string;
    model: string;
    elapsed: string;
    after: string;
    next: string;
    none: string;
    step: string;
    document: string;
    openDocument: string;
    conversation: string;
    noSession: string;
  };
  document: { goal: string; criteria: string; after: string };
  blockedByFailure: string;
  /** Several graphs in one conversation. */
  graphsSummary: (total: number, running: number) => string;
  pickGraph: string;
}

const elapsedKo = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${String(s % 60).padStart(2, "0")}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
};

const elapsedEn = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

export const TASK_GRAPH_COPY: Record<ProposalLocale, TaskGraphCopy> = {
  "ko-KR": {
    tab: "작업",
    title: "작업 그래프",
    empty: "아직 작업이 없습니다",
    doneCount: (done, total) => `${done}/${total} 완료`,
    failedCount: (count) => `실패 ${count}`,
    cancelledCount: (count) => `취소 ${count}`,
    status: {
      pending: "대기", running: "진행 중", awaiting_review: "검토 중", completed: "완료",
      failed: "실패", cancelled: "취소됨", blocked: "보류", paused: "일시정지",
    },
    assignee: (ordinal) => `작업자 ${ordinal}`,
    unassigned: "배정 전",
    elapsed: elapsedKo,
    cardLabel: (parts) => parts.join(", "),
    graphLabel: "작업 그래프",
    detail: {
      status: "상태", assignee: "담당", model: "모델", elapsed: "걸린 시간",
      after: "앞선 작업", next: "다음 작업", none: "없음", step: "지금 하는 일",
      document: "작업 문서", openDocument: "열기", conversation: "대화 보기", noSession: "아직 배정 전",
    },
    document: { goal: "목표", criteria: "완료 기준", after: "앞선 작업" },
    blockedByFailure: "앞선 작업이 실패했습니다",
    graphsSummary: (total, running) => `그래프 ${total}개${running ? ` · 진행 중 ${running}` : ""}`,
    pickGraph: "그래프 고르기",
  },
  "en-US": {
    tab: "Tasks",
    title: "Task graph",
    empty: "No tasks yet",
    doneCount: (done, total) => `${done}/${total} done`,
    failedCount: (count) => `${count} failed`,
    cancelledCount: (count) => `${count} cancelled`,
    status: {
      pending: "Waiting", running: "Running", awaiting_review: "In review", completed: "Done",
      failed: "Failed", cancelled: "Cancelled", blocked: "Blocked", paused: "Paused",
    },
    assignee: (ordinal) => `Worker ${ordinal}`,
    unassigned: "Not assigned",
    elapsed: elapsedEn,
    cardLabel: (parts) => parts.join(", "),
    graphLabel: "Task graph",
    detail: {
      status: "Status", assignee: "Assignee", model: "Model", elapsed: "Time",
      after: "After", next: "Next", none: "None", step: "Now",
      document: "Task document", openDocument: "Open", conversation: "View conversation", noSession: "Not assigned yet",
    },
    document: { goal: "Goal", criteria: "Done when", after: "After" },
    blockedByFailure: "An earlier task failed",
    graphsSummary: (total, running) => `${total} graphs${running ? ` · ${running} running` : ""}`,
    pickGraph: "Choose a graph",
  },
};

export type Scenario = "empty" | "one" | "chain" | "fanout" | "failed" | "cancelled" | "long" | "two" | "many";
/** How several graphs share the Tasks tab. */
export type Variant = "stacked" | "picker" | "combined";

interface PageCopy {
  eyebrow: string;
  title: string;
  intro: string;
  variant: string;
  variants: Record<Variant, string>;
  recommended: string;
  scenario: string;
  scenarios: Record<Scenario, string>;
  width: string;
  widths: { desktop: string; "768": string; "375": string };
  theme: string;
  themes: { light: string; dark: string };
  wallpaper: string;
  wallpapers: { clouds: string; daisies: string; bloom: string; none: string };
  motion: string;
  motions: { full: string; reduced: string };
  language: string;
  frameLabel: string;
  notesTitle: string;
  notes: Record<Variant, string>;
}

export const PAGE_COPY: Record<ProposalLocale, PageCopy> = {
  "en-US": {
    eyebrow: "Proposal · task graph",
    title: "Task graph",
    intro: "A read-only task graph for the conversation, in its own Tasks tab of the inspector (Summary is unchanged). Cards show title, status, worker and model, and time; lines are prerequisites. A card opens the worker's conversation in the existing session dialog; the detail opens the task document in the existing document dialog. Drag the inspector edge to resize it; the width is kept. A conversation can run several graphs at once (one per plan); the variants show how the tab holds them.",
    variant: "Several graphs",
    variants: { stacked: "A · Stacked sections", picker: "B · Graph picker", combined: "C · One canvas" },
    recommended: "Recommended",
    scenario: "State",
    scenarios: {
      empty: "Empty", one: "One task", chain: "Chain", fanout: "Fan-out + join",
      failed: "Failed", cancelled: "Cancelled", long: "Long (16)", two: "2 graphs", many: "6 graphs",
    },
    width: "Width",
    widths: { desktop: "Desktop", "768": "768", "375": "375" },
    theme: "Theme",
    themes: { light: "Light", dark: "Dark" },
    wallpaper: "Wallpaper",
    wallpapers: { clouds: "Clouds (photo)", daisies: "Daisies (photo)", bloom: "Bloom", none: "None" },
    motion: "Motion",
    motions: { full: "Full", reduced: "Reduced" },
    language: "Language",
    frameLabel: "Tasks tab preview",
    notesTitle: "Several graphs",
    notes: {
      stacked: "One collapsible row per graph with its goal, status glyph and counts. Running and failed graphs are open; finished and cancelled ones fold to one line. Order: running, failed, waiting, done, cancelled. The task detail opens under the graph that owns it. Every graph's state is visible at once on desktop and 375 with no extra control. With one graph the row is hidden.",
      picker: "A Select at the top lists every graph with its counts; one graph shows at a time. Compact and quiet with many graphs, but the other graphs' state hides behind the menu, so a failure elsewhere is easy to miss.",
      combined: "All graphs in one horizontal canvas, one labelled band per graph, scrolled together; on 375 the bands stack. Shows everything, but bands of very different lengths leave wide empty space and finished graphs take as much room as running ones; band labels scroll away with the canvas.",
    },
  },
  "ko-KR": {
    eyebrow: "제안 · 작업 그래프",
    title: "작업 그래프",
    intro: "대화의 작업 그래프를 인스펙터의 별도 '작업' 탭에 읽기 전용으로 보여 줍니다(요약 탭은 그대로). 카드에는 제목, 상태, 작업자와 모델, 걸린 시간이 있고 선은 선행 관계입니다. 카드를 누르면 작업자의 대화가 기존 대화 창에 열리고, 상세에서 작업 문서를 기존 문서 창으로 엽니다. 인스펙터 가장자리를 끌어 너비를 바꿀 수 있고 너비는 기억됩니다. 한 대화에서 그래프 여러 개(계획마다 하나)가 동시에 돌 수 있어, 탭에 담는 방식을 안별로 비교합니다.",
    variant: "그래프 여러 개",
    variants: { stacked: "A · 접는 섹션", picker: "B · 그래프 고르기", combined: "C · 한 캔버스" },
    recommended: "추천",
    scenario: "상태",
    scenarios: {
      empty: "없음", one: "작업 1개", chain: "순차", fanout: "병렬 3 + 합류",
      failed: "실패", cancelled: "취소", long: "긴 그래프 (16)", two: "그래프 2개", many: "그래프 6개",
    },
    width: "너비",
    widths: { desktop: "데스크톱", "768": "768", "375": "375" },
    theme: "테마",
    themes: { light: "라이트", dark: "다크" },
    wallpaper: "배경화면",
    wallpapers: { clouds: "구름 (사진)", daisies: "데이지 (사진)", bloom: "블룸", none: "없음" },
    motion: "모션",
    motions: { full: "기본", reduced: "줄이기" },
    language: "언어",
    frameLabel: "작업 탭 미리보기",
    notesTitle: "그래프 여러 개",
    notes: {
      stacked: "그래프마다 접을 수 있는 줄 하나에 목표, 상태 아이콘, 개수를 둡니다. 진행 중과 실패한 그래프는 펼치고, 끝났거나 취소된 그래프는 한 줄로 접습니다. 순서는 진행 중, 실패, 대기, 완료, 취소입니다. 작업 상세는 그 작업이 속한 그래프 바로 아래에 열립니다. 컨트롤을 더하지 않고도 데스크톱과 375 모두에서 모든 그래프의 상태가 한눈에 보입니다. 그래프가 하나면 줄을 숨깁니다.",
      picker: "탭 위 Select에 그래프와 개수를 모두 나열하고 한 번에 하나만 보여 줍니다. 그래프가 많아도 작고 조용하지만 다른 그래프의 상태가 메뉴 뒤에 숨어 다른 곳의 실패를 놓치기 쉽습니다.",
      combined: "모든 그래프를 가로 캔버스 하나에 그래프별 띠로 쌓아 함께 스크롤합니다. 375에서는 띠가 세로로 쌓입니다. 전부 보이지만 길이가 크게 다른 띠 사이에 빈 공간이 넓고, 끝난 그래프도 진행 중 그래프만큼 자리를 차지하며, 띠 이름이 캔버스와 함께 스크롤되어 사라집니다.",
    },
  },
};
