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
    title: "위임 작업",
    empty: "아직 위임한 작업이 없습니다",
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
    graphLabel: "위임 작업 흐름",
    detail: {
      status: "상태", assignee: "담당", model: "모델", elapsed: "걸린 시간",
      after: "앞선 작업", next: "다음 작업", none: "없음", step: "지금 하는 일",
      document: "작업 문서", openDocument: "열기", conversation: "대화 보기", noSession: "아직 배정 전",
    },
    document: { goal: "목표", criteria: "완료 기준", after: "앞선 작업" },
    blockedByFailure: "앞선 작업이 실패했습니다",
  },
  "en-US": {
    tab: "Tasks",
    title: "Delegated tasks",
    empty: "Nothing delegated yet",
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
    graphLabel: "Delegated task flow",
    detail: {
      status: "Status", assignee: "Assignee", model: "Model", elapsed: "Time",
      after: "After", next: "Next", none: "None", step: "Now",
      document: "Task document", openDocument: "Open", conversation: "View conversation", noSession: "Not assigned yet",
    },
    document: { goal: "Goal", criteria: "Done when", after: "After" },
    blockedByFailure: "An earlier task failed",
  },
};

export type Scenario = "empty" | "one" | "chain" | "fanout" | "failed" | "cancelled" | "long";
export type Variant = "open" | "select";

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
    title: "Delegated task graph",
    intro: "A read-only graph of the tasks this conversation delegated, in its own Tasks tab of the inspector (Summary is unchanged). Cards show title, status, worker and model, and time; lines are prerequisites. A card opens the worker's conversation in the existing session dialog and its task document in the existing document dialog. Drag the inspector edge to resize it; the width is kept. Nothing can be edited.",
    variant: "Card click",
    variants: { open: "A · Opens conversation", select: "B · Selects only" },
    recommended: "Recommended",
    scenario: "State",
    scenarios: {
      empty: "Empty", one: "One task", chain: "Chain", fanout: "Fan-out + join",
      failed: "Failed", cancelled: "Cancelled", long: "Long (16)",
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
    frameLabel: "Summary tab preview",
    notesTitle: "Variants",
    notes: {
      open: "Click or Enter selects the card and opens the worker's conversation in the session dialog, as delegated sessions open today. Arrow keys only move the selection. The detail under the graph keeps the facts, the task document and a View conversation button. Unassigned tasks only select.",
      select: "Click only selects; the conversation opens from View conversation in the detail. Calmer for browsing a long graph, but one more step to the conversation the owner asked for.",
    },
  },
  "ko-KR": {
    eyebrow: "제안 · 작업 그래프",
    title: "위임 작업 그래프",
    intro: "이 대화가 위임한 작업을 인스펙터의 별도 '작업' 탭에 읽기 전용 그래프로 보여 줍니다(요약 탭은 그대로). 카드에는 제목, 상태, 작업자와 모델, 걸린 시간이 있고 선은 선행 관계입니다. 카드를 누르면 작업자의 대화가 기존 대화 창에, 작업 문서가 기존 문서 창에 열립니다. 인스펙터 가장자리를 끌어 너비를 바꿀 수 있고 너비는 기억됩니다. 편집은 할 수 없습니다.",
    variant: "카드 누르기",
    variants: { open: "A · 대화 열기", select: "B · 선택만" },
    recommended: "추천",
    scenario: "상태",
    scenarios: {
      empty: "없음", one: "작업 1개", chain: "순차", fanout: "병렬 3 + 합류",
      failed: "실패", cancelled: "취소", long: "긴 그래프 (16)",
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
    frameLabel: "요약 탭 미리보기",
    notesTitle: "안 비교",
    notes: {
      open: "누르거나 Enter를 치면 카드가 선택되고 작업자의 대화가 지금 위임 대화를 여는 대화 창에 열립니다. 화살표 키는 선택만 옮깁니다. 그래프 아래 상세에는 사실 정보, 작업 문서, '대화 보기' 버튼이 남습니다. 배정 전 작업은 선택만 됩니다.",
      select: "누르면 선택만 되고 대화는 상세의 '대화 보기'로 엽니다. 긴 그래프를 훑기엔 차분하지만 요청한 대화까지 한 단계가 더 있습니다.",
    },
  },
};
