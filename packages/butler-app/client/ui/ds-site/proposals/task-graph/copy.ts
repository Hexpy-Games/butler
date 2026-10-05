// Proposal-local mirror of the i18n keys this feature adds. The implementation moves `taskGraph`
// into packages/butler-i18n/src/locales/{ko,en}.ts (AppCopy contract) unchanged; product code reads
// it as `appCopy.taskGraph.*`. Page chrome text (PAGE_COPY) is proposal-only and is not shipped.

export type ProposalLocale = "ko-KR" | "en-US";

export type TaskStatus =
  | "pending" | "running" | "awaiting_review" | "completed"
  | "failed" | "cancelled" | "blocked" | "paused";

export interface TaskGraphCopy {
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
    viewActivity: string;
  };
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
      after: "앞선 작업", next: "다음 작업", none: "없음", viewActivity: "활동 보기",
    },
    blockedByFailure: "앞선 작업이 실패했습니다",
  },
  "en-US": {
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
      after: "After", next: "Next", none: "None", viewActivity: "View activity",
    },
    blockedByFailure: "An earlier task failed",
  },
};

export type Scenario = "empty" | "one" | "chain" | "fanout" | "failed" | "cancelled" | "long";
export type Variant = "rolling" | "rail";

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
    intro: "A read-only graph of the tasks this conversation delegated, in the Summary tab under the existing progress list. Cards show title, status, worker and model, and time. Lines are prerequisites. Select a card to read its detail; nothing can be edited or dragged.",
    variant: "Running highlight",
    variants: { rolling: "A · Live line", rail: "B · Phase rail" },
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
      rolling: "The running card keeps the same size as every other card. Its icon is the DS spinner, its last line swaps the worker's current step with RollingSwap, and the lines into it use the worker-active color. Reduced motion stops the swap and the spinner loop. Done draws the LoadingIndicator check.",
      rail: "Adds the WorkerActivityRow phase rail to the running card, so its active segment pulses (DS keyframes, static under reduced motion). More visible, but the card grows and the rail labels are English-only today (DS gap).",
    },
  },
  "ko-KR": {
    eyebrow: "제안 · 작업 그래프",
    title: "위임 작업 그래프",
    intro: "이 대화가 위임한 작업을 요약 탭의 기존 진행 목록 아래에 읽기 전용 그래프로 보여 줍니다. 카드에는 제목, 상태, 작업자와 모델, 걸린 시간이 있고 선은 선행 관계입니다. 카드를 고르면 상세를 볼 수 있으며 편집하거나 끌어 옮길 수는 없습니다.",
    variant: "진행 중 강조",
    variants: { rolling: "A · 현재 단계 줄", rail: "B · 단계 막대" },
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
      rolling: "진행 중 카드도 다른 카드와 크기가 같습니다. 아이콘은 DS 스피너, 마지막 줄은 작업자의 현재 단계를 RollingSwap으로 바꿔 보여 주고, 들어오는 선은 작업 중 색을 씁니다. 모션 줄이기에서는 바뀜 효과와 스피너 회전이 멈춥니다. 완료되면 LoadingIndicator 체크가 그려집니다.",
      rail: "진행 중 카드에 WorkerActivityRow 단계 막대를 더해 현재 단계가 깜박입니다(DS 키프레임, 모션 줄이기에서는 정지). 더 눈에 띄지만 카드가 커지고 막대 라벨이 지금은 영어로만 나옵니다(DS 공백).",
    },
  },
};
