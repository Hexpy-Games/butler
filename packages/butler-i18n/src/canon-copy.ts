export interface CanonCopy {
  overview: string; openOverview: string; noPlan: string; personalOrder: string;
  sharedOrder: string; backlogOrderHelp: string; sharedGrip: string; changePlan: string;
  noEpics: string; noDescription: string; conversationFailed: string; epicPlaceholder: string;
  newInGroup: (group: string) => string; epicCount: (n: number) => string;
  epicCaption: (group: string) => string;
  newEpic: string; newPlan: string; backlog: string; backlogDescription: string;
  epic: string; title: string; description: string; optional: string; plan: string; assignee: string;
  none: string; me: string; cancel: string; create: string; save: string; edit: string; close: string; dueOn: string;
  titlePlaceholder: string; descriptionPlaceholder: string; titleRequired: string;
  created: string; conflict: string; statusChanged: string; reordered: string; running: string;
  openConversation: string; noConversation: string; status: string; specs: string; noSpecs: string; progress: string; noTasks: string;
  statuses: Record<"planned" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled", string>;
  blockedLane: string; previousLanes: string; nextLanes: string;
  taskStatuses: Record<"draft" | "waiting" | "pending" |
    "running" | "in_review" | "held" | "failed" | "completed" | "blocked" |
    "paused" | "stopped" | "cancelled", string>;
  done: (done: number, total: number) => string;
  tasks: (done: number, total: number) => string;
  due: (date: string) => string;
  ordinal: (n: number) => string;
  backlogCount: (n: number) => string;
  moved: (plan: string) => string;
  personLabel: (name: string, self: boolean) => string;
  cardStatusChanged: (title: string, status: string) => string;
  drag: {
    instructions: string; roleDescription: string;
    lifted: (item: string, lane: string, position: number) => string;
    over: (item: string, lane: string, position: number) => string;
    dropped: (item: string, lane: string, position: number) => string;
    cancelled: (item: string) => string; unchanged: (item: string) => string;
  };
}
