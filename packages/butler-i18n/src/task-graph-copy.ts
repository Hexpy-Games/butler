export interface TaskGraphCopy {
  /** Inspector tab label. */
  tab: string;
  title: string;
  empty: string;
  /** "3/6 완료" */
  doneCount: (done: number, total: number) => string;
  failedCount: (count: number) => string;
  cancelledCount: (count: number) => string;
  status: Record<"pending" | "running" | "review" | "done" | "failed" | "cancelled" | "blocked" | "paused", string>;
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
