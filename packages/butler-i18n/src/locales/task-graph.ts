import type { TaskGraphCopy } from "../task-graph-copy.ts";

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

export const TASK_GRAPH_COPY: Record<"ko-KR" | "en-US", TaskGraphCopy> = {
  "ko-KR": {
    tab: "작업",
    title: "작업 그래프",
    empty: "아직 작업이 없습니다",
    doneCount: (done, total) => `${done}/${total} 완료`,
    failedCount: (count) => `실패 ${count}`,
    cancelledCount: (count) => `취소 ${count}`,
    status: {
      pending: "대기", running: "진행 중", review: "검토 중", done: "완료",
      failed: "실패", cancelled: "취소됨", blocked: "보류", paused: "일시정지",
    },
    assignee: (ordinal) => `Worker ${ordinal}`,
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
      pending: "Waiting", running: "Running", review: "In review", done: "Done",
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
