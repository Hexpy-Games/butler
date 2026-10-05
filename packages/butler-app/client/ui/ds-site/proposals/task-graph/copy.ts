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

interface PageCopy {
  eyebrow: string;
  title: string;
  intro: string;
  chosen: string;
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
  notes: string[];
}

export const PAGE_COPY: Record<ProposalLocale, PageCopy> = {
  "en-US": {
    eyebrow: "Proposal · task graph",
    title: "Task graph",
    intro: "A read-only task graph for the conversation, in its own Tasks tab of the inspector (Summary is unchanged). Cards show title, status, worker and model, and time; lines are prerequisites. A card opens the worker's conversation in the existing session dialog; the detail opens the task document in the existing document dialog. Drag the inspector edge to resize it; the width is kept. A conversation can run several graphs at once (one per plan); each graph is one collapsible section (variant A, chosen).",
    chosen: "Chosen",
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
    notesTitle: "Several graphs · A · Stacked sections",
    notes: [
      "One DisclosureRow per graph (default selection surface: trigger inset inside the row box, hover fill, open rows keep the flat selection fill) with the goal, a status glyph on the first text line and the counts.",
      "Running and failed graphs open; finished and cancelled ones fold to one line. Order: running, failed, waiting, done, cancelled. Folded rows sit 4px apart (DS row rhythm); an open graph gets 8px above and below its canvas.",
      "The graph is rendered below its row, not in the row's panel, so cards start on the same 18px inspector inset as the row box, the header and the detail panel.",
      "The task detail opens under the graph that owns it. With one graph the row is hidden and the goal becomes the header description.",
      "Not chosen: B, a graph picker (hides other graphs' failures behind a menu); C, one combined canvas (empty bands, labels scroll away).",
    ],
  },
  "ko-KR": {
    eyebrow: "제안 · 작업 그래프",
    title: "작업 그래프",
    intro: "대화의 작업 그래프를 인스펙터의 별도 '작업' 탭에 읽기 전용으로 보여 줍니다(요약 탭은 그대로). 카드에는 제목, 상태, 작업자와 모델, 걸린 시간이 있고 선은 선행 관계입니다. 카드를 누르면 작업자의 대화가 기존 대화 창에 열리고, 상세에서 작업 문서를 기존 문서 창으로 엽니다. 인스펙터 가장자리를 끌어 너비를 바꿀 수 있고 너비는 기억됩니다. 한 대화에서 그래프 여러 개(계획마다 하나)가 동시에 돌 수 있어, 그래프마다 접는 섹션 하나로 담습니다(A안, 채택).",
    chosen: "채택",
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
    notesTitle: "그래프 여러 개 · A · 접는 섹션",
    notes: [
      "그래프마다 DisclosureRow 하나(기본 selection 표면: 줄 상자 안쪽 여백, 마우스 올림 채움, 펼친 줄은 평평한 선택 채움)에 목표, 첫 줄에 맞춘 상태 아이콘, 개수를 둡니다.",
      "진행 중과 실패한 그래프는 펼치고 끝났거나 취소된 그래프는 한 줄로 접습니다. 순서는 진행 중, 실패, 대기, 완료, 취소입니다. 접힌 줄 사이는 4px(DS 줄 간격), 펼친 그래프는 캔버스 위아래로 8px입니다.",
      "그래프는 줄의 패널 안이 아니라 줄 아래에 그려서, 카드가 줄 상자·머리글·상세 패널과 같은 18px 인스펙터 여백에서 시작합니다.",
      "작업 상세는 그 작업이 속한 그래프 아래에 열립니다. 그래프가 하나면 줄을 숨기고 목표를 머리글 설명으로 씁니다.",
      "채택하지 않은 안: B 그래프 고르기(다른 그래프의 실패가 메뉴 뒤에 숨음), C 한 캔버스(빈 띠가 생기고 이름이 스크롤로 사라짐).",
    ],
  },
};
