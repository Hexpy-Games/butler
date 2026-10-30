export interface CanonOrderCopy {
  chain: Record<"user_message" | "schedule" | "detach", string>;
  /** Status words; a waiting step shows none (its caption already says what it waits for). */
  status: Record<"running" | "held" | "failed" | "done", string>;
  after: (title: string) => string; afterStack: (title: string, count: number) => string;
  heldBy: string; join: string; newStep: string;
  more: (count: number) => string; menu: (title: string) => string;
  startNow: string; unstack: string; remove: string; failed: string; changed: string;
  drag: {
    instructions: string; roleDescription: string; grip: (item: string) => string;
    stack: (front: string, count: number) => string;
    lifted: (item: string, chain: string, step: number) => string;
    newStep: (item: string, chain: string, step: number) => string;
    join: (item: string, chain: string, step: number) => string;
    dropped: (item: string, chain: string, step: number) => string;
    cancelled: (item: string) => string; unchanged: (item: string) => string;
  };
  deck: { expand: (count: number, front: string) => string; fold: (item: string) => string };
}
export interface CanonCopy {
  order: CanonOrderCopy;
  queue: {
    step: (plan: string, epic: string) => string;
    stepEpic: (epic: string) => string;
    removed: string; continued: string; taken: string;
    hold: (epic: string) => string;
    takeHere: (epic: string, conversation: string) => string;
    remove: string; proceed: string; openOther: string; take: string;
  };
  criteriaCount: (confirmed: number, total: number) => string;
  criterionState: (id: string, confirmed: boolean) => string;
  criterionActivity: (id: string, confirmed: boolean) => string;
  mcp: {
    trustTitle: (client: string) => string; trustDescription: string; client: string; person: string; requestedPermissions: string;
    trustNotice: (person: string) => string; capabilities: Record<string, string>;
    allow: string; deny: string; revoke: string; remove: string; revoked: string; deleted: string;
    connectedTools: string; noTools: string; capabilityCount: (count: number) => string;
    states: Record<"allowed" | "pending" | "denied" | "revoked", string>;
    working: (person: string, via: string) => string; butler: string;
    createdActivity: string; appliedActivity: string; declinedActivity: string;
    activity: string; noActivity: string; more: string; proposal: string; apply: string;
  };
  inlineEdit: { title: string; description: string; unsaved: string; keep: string; discard: string; saved: string; current: string };
  attachFile: string; fileTooLarge: string; tooManyAttachments: string; saving: string; uploadingFile: string;
  searchPlan: string; clearSearch: string; noResults: string;
  overview: string; noPlan: string; personalOrder: string;
  sharedOrder: string; backlogOrderHelp: string; sharedGrip: string; planMissing: string; changePlan: string;
  noEpics: string; noDescription: string; conversationFailed: string; epicPlaceholder: string;
  newInGroup: (group: string) => string; epicCount: (n: number) => string;
  epicCaption: (group: string) => string;
  newEpic: string; newPlan: string; backlog: string; backlogDescription: string;
  epic: string; title: string; description: string; optional: string; plan: string; assignee: string;
  none: string; me: string; cancel: string; create: string; save: string; edit: string; editPlan: string; close: string; dueOn: string;
  titlePlaceholder: string; descriptionPlaceholder: string; titleRequired: string;
  created: string; conflict: string; statusChanged: string; reordered: string; running: string; runningCancel: string;
  openConversation: string; noConversation: string; status: string; specs: string; noSpecs: string; progress: string; noTasks: string;
  statuses: Record<"planned" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled", string>;
  blockedLane: string; previousLanes: string; nextLanes: string;
  taskStatuses: Record<"draft" | "waiting" | "pending" |
    "running" | "in_review" | "held" | "failed" | "completed" | "blocked" |
    "paused" | "stopped" | "cancelled", string>;
  actionStatuses: Record<"pending" | "active" | "done" | "blocked" | "skipped", string>;
  stages: Record<"conception" | "planning" | "execution" | "review" | "validation" | "reporting", string>;
  done: (done: number, total: number) => string;
  tasks: (done: number, total: number) => string;
  due: (date: string) => string;
  ordinal: (n: number) => string;
  backlogCount: (n: number) => string;
  moved: (plan: string) => string;
  personLabel: (name: string, self: boolean) => string;
  cardStatusChanged: (title: string, status: string) => string;
  tags: {
    label: string; add: string; filter: string; search: string; searchPlaceholder: string; empty: string; clearAll: string;
    rename: string; recolor: string; remove: string; name: string; color: string; loading: string;
    colors: Record<"gray" | "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple", string>;
    create: (name: string) => string; menu: (name: string) => string; removeTag: (name: string) => string;
    deleteTitle: (name: string) => string; deleteDetail: (n: number) => string;
  };
  drag: {
    instructions: string; roleDescription: string;
    lifted: (item: string, lane: string, position: number) => string;
    over: (item: string, lane: string, position: number) => string;
    dropped: (item: string, lane: string, position: number) => string;
    cancelled: (item: string) => string; unchanged: (item: string) => string;
  };
}
