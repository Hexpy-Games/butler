import type { CanonCopy } from "./canon-copy.ts";
import type { TaskGraphCopy } from "./task-graph-copy.ts";

import type { LifecycleCopy } from "./lifecycle.ts";
/** Provider cards on the first-run "Pick an AI" screen. */
export type FirstRunProviderCardId =
  | "chatgpt" | "claude" | "gemini" | "openai" | "grok" | "qwen"
  | "kimi" | "zaiCoding" | "zaiApi" | "opencodeGo" | "other";

interface FirstRunCopy {
  product: string;
  welcomeTitle: string;
  welcomeLede: string;
  start: string;
  steps: { welcome: string; consent: string; memory: string; connect: string; ready: string };
  consentTitle: string;
  consentItems: Array<{ body: string; caption?: string }>;
  consentProviderLink: string;
  consentClause: string;
  decline: string;
  agree: string;
  agreeBlocked: string;
  prepWorking: string;
  prepReady: string;
  prepFailed: string;
  /** Plain failure reasons keyed by readiness error code; `default` covers the rest. */
  prepReasons: Record<string, string>;
  /** Preparation step names keyed by step id (bug-report info). */
  prepSteps: Record<string, string>;
  retry: string;
  moreActions: string;
  repair: string;
  copyReport: string;
  reportCopied: string;
  reportUnavailable: string;
  quit: string;
  interfaceLanguage: string;
  /** First-run step that decides whether the memory model is downloaded. */
  memoryChoice: {
    title: string;
    lede: string;
    on: string;
    off: string;
    offDescription: string;
    /** Download size beside the memory-model choice. */
    size: (sizeMB: number) => string;
    continue: string;
    saveFailed: string;
  };
  memoryModel: {
    label: string;
    /** The model's trade-off; `sizeMB` is omitted while the size is unknown. */
    description: (sizeMB?: number) => string;
    downloading: string;
    verifying: string;
    failed: string;
    ready: string;
    retry: string;
    progress: (percent: number, doneMB: number, totalMB: number) => string;
    reasons: Record<string, string>;
  };
  languageLabel: string;
  learnMore: string;
  cancel: string;
  connectTitle: string;
  connectLede: string;
  prepWaitConnect: string;
  providerNames: Record<FirstRunProviderCardId, string>;
  providerDescriptions: Record<FirstRunProviderCardId, string>;
  /** Tag on the connected AI when setup runs again. */
  tagCurrent: string;
  localModelCount: (count: number) => string;
  moreProviders: (count: number) => string;
  showLess: string;
  localMissing: string;
  rescan: string;
  checking: string;
  connecting: string;
  offline: string;
  offlineShort: string;
  offlineTile: string;
  noModels: string;
  noUsable: string;
  back: string;
  signInTitle: (name: string) => string;
  planNotice: string;
  signInPlanOff: string;
  signInPlanOffBody: string;
  signInAccountMismatch: string;
  signInDiscoveryOffline: string;
  signInBody: string;
  keyTitle: (name: string) => string;
  keyLabel: string;
  keyHint: string;
  keyValid: string;
  /** Key check failures by #279 error code group. */
  keyErrors: Record<"invalid" | "noaccess" | "network" | "ratelimited" | "unavailable" | "unsupported" | "badrequest" | "savefailed", string>;
  /** Saved, but the service has no model list to check it against. */
  keySaved: string;
  keyFailedShort: string;
  getKey: string;
  keyStored: string;
  finishing: string;
  readyTitle: (name: string) => string;
  next: string;
  /** Tooltip on ② Next while it waits for the connection. */
  connectFirst: string;
  replyTitle: string;
  replyBody: string;
  doneTitle: string;
  doneBody: string;
  import: {
    agentsTitle: string; agentsBody: string; agentsEmpty: string;
    importAction: string; importing: string; searching: string; skip: string;
    /** Tooltip on a disabled Next or Import while nothing is picked. */
    pickOne: string;
    /** Import after the run: one row per tool with what was added and any follow-up. */
    agentsDoneTitle: string;
    agentsAdded: (instructions: number, servers: number) => string;
    agentsNothing: string;
    agentsNeedsKey: (count: number) => string;
    /** Import, one page per chosen tool: its instruction file and servers, each a pick card. */
    agentItemsTitle: (name: string) => string;
    agentItemsProgress: (name: string, index: number, total: number) => string;
    itemInstructions: string;
    itemServer: string;
    itemNeedsKey: string;
    itemFileEmpty: string;
    itemFileUnreadable: string;
    itemFileTooLarge: string;
  };
  summary: {
    rowAi: string; rowReply: string; rowAgents: string;
    /** Only the nonzero counts ("MCP 서버 2개"); the row is hidden when both are zero. */
    agentCounts: (instructions: number, servers: number) => string;
  };
  replyLanguage: string;
  finish: string;
  finishFailed: string;
  /** Other ②: models on this computer and a typed server, on one screen. */
  otherTitle: string;
  otherBody: string;
  /** Other ②: the choice that opens the server address form. */
  otherServer: string;
  localNote: string;
  customTitle: string;
  customBody: string;
  customUrl: string;
  customKey: string;
  customConnect: string;
  rerunTitle: string;
  rerunDescription: string;
  rerunAction: string;
}
export interface NewChatBriefingSuggestion {
  id: string;
  title: string;
  description: string;
  text: string;
  /** A template the user finishes: it fills the composer instead of sending. */
  template?: boolean;
}

export interface BriefingFallbackCopy { title: string; description: string; suggestions: NewChatBriefingSuggestion[]; }

type CountFormatter = (count: number) => string;

/**
 * An approval request as one plain question, per `approval.action_kind`
 * (#235). `workspace` is the workspace label; `null` reads as "this workspace".
 */
export interface ApprovalRequestCopy {
  browserMode: { signed_out: string; signed_in: string };
  devtools: {
    read: Record<"console" | "network" | "dom", string>;
    title: (read: string, site: string, mode: string) => string;
    tab: (host: string) => string;
    masked: Record<"console" | "network" | "dom", string>;
    covers: (site: string) => string;
  };
  signInStep: (reason: string) => string;
  /** The sign-in hand-off card: a step only the user can do in the tab; nothing to allow. */
  signInHandoff: { eyebrow: string; title: string; inTab: string; onDesktop: string; openTab: string; stop: string };
  /** The wait-for-user hand-off card title, by why the user must act. */
  waitHandoff: (reason: string) => string;
  /** A saved card or autofill fill's hand-off: the step only the user can do (keypad, card app, OTP, 3-D Secure). */
  payStep: (reason: string) => string;
  payHandoff: string;
  browserStep: (action: string, role: string, name: string, frame: string) => string;
  operation: (tool: string, readOnly: boolean) => string;
  editFiles: (count: number, workspace: string | null) => string;
  editFilesOutside: (count: number) => string;
  runCommandOutside: string;
  readOnlyUnisolated: string;
  networkCommandOutside: string;
  webRequest: string;
  webRequestDesc: string;
  taintReason: string;
  unsandboxedReason: string;
  scheduleMode: (mode: string) => string;
  scheduleSignin: (on: boolean) => string;
  schedulePayment: (on: boolean) => string;
  scheduleUnavailable: string;
  runCommand: (workspace: string | null) => string;
  networkCommand: (workspace: string | null) => string;
  useConnector: (tool: string | null, server: string | null) => string;
  manageSchedule: { create: string; delete: string; run: string; change: string };
  updateProject: string;
  startConversation: string;
  restartService: string;
  createWorktree: string;
  switchFolder: string;
  /** Any kind this App does not know yet. */
  generic: string;
  /** The line after the examples. */
  more: CountFormatter;
  risk: { low: string; medium: string; high: string };
  /** What "Always allow in this conversation" covers. */
  covers: { editFiles: (workspace: string | null) => string; command: (workspace: string | null) => string; other: string };
}

export type AppLocale = "en-US" | "ko-KR";

interface ConversationWorkCopy {
  historyRegionLabel: string;
  pendingLabel: string;
  pendingStateLabels: Record<string, string>;
  resumeInterrupted: string;
  todoListRegionLabel: string;
  todoListTitle: string;
  todoItemPendingLabel: string;
  todoItemRunningLabel: string;
  todoItemCompletedLabel: string;
  todoItemReviewingLabel: string;
  todoItemCorrectionLabel: string;
  todoItemBlockedLabel: string;
  todoItemSkippedLabel: string;
  todoItemStoppedLabel: string;
  collapsedSummary: (primaryLabel: string, count: number) => string;
  expandHistoryLabel: (primaryLabel: string, count: number) => string;
  collapseHistoryLabel: (primaryLabel: string, count: number) => string;
  viewAllLabel: CountFormatter;
  collapseLabel: string;
  /** A work block's disclosure: run state, latest activity and the earlier records inside. */
  disclosureLabel: (status: string, latest: string, earlier: number) => string;
  toolchainRegionLabel: (label: string) => string;
  detailsRegionLabel: (label: string) => string;
  webSearchSummary: CountFormatter;
  toolStepsSummary: (toolName: string, count: number) => string;
  webSearchDetail: (value: string) => string;
  detailRow: (label: string, value: string) => string;
}

interface ConversationCopy {
  chatsIntro: string;
  initiated: {
    viewWork: string; needsApproval: string;
    workFailed: (state: "retrying" | "failed" | undefined, reasonCode: string | undefined) => string;
    noThanks: string; soundsGood: string;
    created: (action: string) => string; skipped: (action: string) => string;
    continuing: (action: string) => string; paused: (action: string) => string;
    alreadyHandled: string; failed: string;
    dailyAt: (time: string) => string; weekdaysAt: (time: string) => string;
    unopened: (count: number) => string;
    action: (frequency: string, title: string, date?: string) => string;
  };
  messageActions: {
    showMore: string;
    showLess: string;
    copyMessage: string;
    copyCode: string;
    copied: string;
    copyFailed: string;
  };
  answerBlocks: {
    preparing: string;
    prepared: string;
    rechecking: string;
    previousValue: string;
    showMore: string;
    showLess: string;
    showMoreItems: (count: number) => string;
    saveToLibrary: string;
    copy: string;
    copied: string;
    savedToLibrary: string;
    makeDocument: string;
    documentCreated: string;
    openOriginChat: string;
    block: string;
    actionFailed: string;
    openImage: string;
    image: string;
    chart: string;
    source: {
      checkedAt: (time: string, site: string) => string;
      checkedOn: (date: string, site: string) => string;
      open: (site: string) => string;
    };
  };
  imageTools: {
    model: string; off: string; apiKey: string; apiKeyOnly: string; defaultQuality: string;
    quality: Record<"low" | "medium" | "high" | "xhigh" | "max", string>;
    size: string; qualityLabel: string; prompt: string; default: string; edit: string; download: string;
    editor: string; brush: string; eraser: string; brushSize: string; undo: string; original: string; compare: string;
    versions: string; version: (n: number) => string; instruction: string; send: string; readOnly: string; noModel: string; failed: string;
  };
  imageViewer: {
    zoomIn: string; zoomOut: string;
    viewImage: (name: string) => string;
    close: string;
    previous: string;
    next: string;
    position: (current: number, total: number) => string;
    failed: string;
    openSource: string;
    copyImage: string;
    imageCopied: string;
    checked: (time: string) => string;
  };
  work: ConversationWorkCopy;
  incompleteStatus: string;
  stoppedStatus: string;
  attachmentUnavailable: string;
  /** File-type label on an attachment tile whose extension is unknown. */
  attachmentFileType: string;
  fileChanges: {
    regionLabel: string;
    title: string;
    titleSummary: (files: number, additions: number, deletions: number) => string;
    fileCounts: (additions: number, deletions: number) => string;
    noLineDetails: string;
    newFile: (size: string) => string;
    diffRegionLabel: (path: string) => string;
    showMore: (remaining: number) => string;
    showLess: string;
  };
  scrollToBottom: {
    ariaLabel: string;
    label: string;
    newMessagesLabel: string;
  };
  result: {
    regionLabel: string;
  };
  failure: {
    regionLabel: string;
    title: string;
    retry: string;
    retryCurrent: string;
    retrying: string;
    fallbackReason: string;
  };
}

export interface BrowserCopy {
  contextMenu: {
    openInNewTab: string; openInButler: string; openInBrowser: (name: string) => string; copyLink: string;
    copy: string; selectAll: string; paste: string;
  };
  siteData: { title: string; label: string; description: string; clear: string; confirmTitle: string; confirmMessage: string; items: string; itemList: string; kept: string; cleared: string; failed: string; desktopOnly: string };
  history: { erase: string; title: string; search: string; clear: string; butlerOnly: string; empty: string; hour: string; today: string; week: string; all: string; suggestions: string; pageLabel: string; pageDescription: string; };
  tabCount: string; newTabIn: string; moreTabs: string; tabMoved: string; agentControl: string; handBack: string; stills: string; still: string; stillPending: string; stillUnavailable: string; stillFailure: Record<string, string>;
  title: string; myTabs: string; newTab: string; closeTab: string; address: string; addressPlaceholder: string; back: string; forward: string;
  reload: string; stop: string; loading: string; crashed: string; empty: string; updateRequired: string; restartRequired: string; failed: string;
  openOutput: string; output: string; show: string; hide: string; active: string; openConversation: string; moveToConversation: string;
  newConversation: string; bringTab: string; resizeChat: string; pick: string; scrap: string; bookmarks: string; bookmarkAdd: string;
  bookmarked: string; manageBookmarks: string; downloads: string; downloading: string; showInFolder: string; more: string; findInPage: string;
  zoom: string; print: string; openExternal: string; settings: string; secure: string; notSecure: string; butlerOutput: string; preview: string;
  signedIn: string; signinRequired: string; captcha: string; signinForm: string; saveSignIn: string; signinSaved: string; signinSaveFailed: string; later: string;
  agentUsing: string; takeOver: string; userControl: string; butlerWaits: string; giveBack: string; autoGiveBack: string;
  stopTask: string; stopped: string; waiting: string; review: string; needYou: string; keypad: string; mfa: string; passkey: string; paymentRequired: string;
  typeYourself: string; chooseFile: string; printer: string; noPrinters: string; popupBlocked: string; allow: string; popupOpened: string; showPopup: string; newTabOpened: string; downloaded: string;
  pointerButler: string; pointerLooking: string; pointerTyping: string; pointerWaiting: string; pointerAwaitingApproval: string;
  pointerNeedInput: string; pickMode: string; pickMulti: string; pickRegion: string; dragToChat: string; finish: string;
  pickHint: string; pickKeys: (mac: boolean) => string; pickFirst: string; picked: (count: number) => string; attachToChat: string; saveImage: string; downloadSaved: string; downloadFailed: string; downloadFileLimit: string; downloadSessionLimit: string; imagesSaved: (count: number) => string; copyText: string; clearSelection: string; dropToAttach: string;
  dropAttachTo: (title: string) => string; dropSaveToLibrary: string; dropMoveTabTo: (title: string) => string; dropInvalid: string;
  attachedTo: (title: string) => string; movedTo: (title: string) => string; library: string; librarySearch: string; recentScraps: string;
  viewAll: string; scrapped: string; scrapsSaved: (count: number) => string; view: string; all: string; elements: string; views: string;
  element: string; viewKind: string; document: string; attach: string; openSource: string; openSourcePage: string; remove: string; archivedClosed: (count: number) => string;
  pageSays: string; authNeeded: string; username: string; password: string; signIn: string; ok: string; cancel: string; leaveTitle: string;
  stay: string; leave: string; viewInBrowser: string; toolOpen: string; toolAct: string; toolSelection: string; sectionTitle: string; enabled: string;
  enabledHelp: string; shareSignIn: string; shareSignInHelp: string; signIns: string; signInsHelp: string; addSignIn: string; fillPolicy: string;
  ask: string; always: string; never: string; standing: string; lastUsed: string; deletePassword: string; signOutSite: string; revoke: string;
  usedTimes: (count: number) => string; filled: string; askedApproved: string;
  /** The live tab rail beside the conversation (TabRail, LiveTabCard). */
  rail: { region: string; openToCheck: string; needsCheck: string; pageError: string; error: string; more: (count: number) => string };
  /** The titlebar browser toggle while Butler browses in the background (ActivityGlow): label suffixes per state. */
  glow: { busy: string; attention: string; error: string };
  scraps: string; documents: string; outputs: string; loadMore: string; emptyLibrary: string; bookmarkFolder: string;
}

/** Grouped words of the Library's per-kind groups: scraps have groups, bookmarks have folders. */
export interface LibraryGroupWords {
  word: string; ungrouped: string; newGroup: string; createGroup: string; groupName: string; renameGroup: string; ungroup: string;
  moveTo: string; removeFrom: string; search: string; count: (count: number) => string; more: (count: number) => string;
  ungroupTitle: (name: string) => string; ungroupBody: (count: number) => string;
}

/** Library (`library.*`): the 서랍 main screen, kind views, groups, tags, filters, the scrap detail and drops. */
export interface LibraryCopy {
  title: string; search: string; kinds: { all: string; scrap: string; document: string; bookmark: string; output: string };
  kindLabel: string; viewAll: string; groups: { scrap: LibraryGroupWords; bookmark: LibraryGroupWords }; empty: string; noItems: string;
  noMatches: string; clearFilters: string; clearAll: string; loadMore: string; failed: string; open: string; rename: string; editTags: string;
  name: string; tags: string; addTag: string; createTag: (name: string) => string; removeTag: (name: string) => string; manageTags: string;
  manageTagsBody: string; noTags: string; merge: string; mergeNote: (from: string, fromCount: number, to: string, toCount: number) => string;
  deleteTag: string; tagExists: string; groupExists: string; sites: string; date: string; anyDate: string;
  dates: { today: string; week: string; month: string; year: string }; since: string; until: string; sort: string; sorts: { new: string; old: string; name: string; site: string };
  filterChip: (label: string, value: string) => string; selected: (count: number) => string; select: string; clearSelection: string;
  added: (count: number, group: string) => string; undo: string; dropAdd: (group: string) => string; dropScrap: (group: string) => string;
  savedScraps: (count: number) => string; addToGroup: string; leaveUngrouped: string; back: (title: string) => string; mixedKinds: string;
  tagsOnAll: (count: number) => string; tagsOnSome: (count: number, total: number) => string; addToAll: string; removeFromAll: string;
  bulkTagsTitle: (count: number) => string; source: string; saved: string; size: string; none: string; cancel: string; create: string;
  save: string; move: string; close: string; deleteItem: string; tileLabel: (name: string, meta: string) => string;
  deleteSelected: (count: number) => string; deleteSelectedBody: string; selectionActions: string;
}

/** Span names the message trace titles in the reader's language. */
export type TraceStepName =
  | "http.server" | "turn.admit" | "turn.queue" | "turn.dispatch" | "turn.run" | "turn.deliver"
  | "route.select" | "context.build" | "model.request" | "retry.wait" | "http.request" | "stream.receive"
  | "tool.call" | "mcp.call" | "memory.write" | "memory.recall" | "schedule.run";

/** Settings › 로그 › 메시지 추적 and its 로그 보기 entry points. */
export interface LogTraceCopy {
  title: string;
  viewLogs: string;
  /** A schedule's overflow menu: its latest run that started a turn. */
  latestRunLogs: string;
  openCommand: string;
  openCommandHint: string;
  viewWhole: string;
  sections: { summary: string; steps: string };
  fields: Record<"result" | "duration" | "model" | "started" | "chat" | "traceId", string>;
  outcome: Record<"ok" | "error", string>;
  retries: (count: number) => string;
  failed: string;
  wait: string;
  running: string;
  partial: string;
  notFound: string;
  loadFailed: string;
  copyId: string;
  seconds: (value: string) => string;
  spoken: (start: string, length: string) => string;
  depth: (level: number) => string;
  /** Step titles by span name; other names show the agent's own title. */
  steps: Record<TraceStepName, string>;
  /** Detail labels by attribute key; other keys show as written. */
  attrs: Record<string, string>;
}

/** Browser copy (`browser.*`): chrome, page band, pointer, picking, library, page dialogs and sign-in settings. */
export interface AppCopy {
  canon: CanonCopy;
  chatgptSignIn: {
    idle: string;
    pending: string;
    open: string;
    copy: string;
    copied: string;
    timedOut: string;
    failed: string;
    restart: string;
    complete: string;
    addHint: string;
  };
  chatgptPlan: {
    continue: string;
    otherAccount: string;
    usingPlan: string;
    manageUsage: string;
    limitReached: string;
    limitFallback: string;
    butlerUsage: string;
    usageWindow5h: string;
    usageWindow7d: string;
    usageWindow30d: string;
    estimate: string;
    estimateHint: string;
    resetsAt: (time: string) => string;
    planOff: string;
    turnOn: string;
    signInAgainHint: string;
    notInPlanHint: string;
    legacyToast: string;
    signOut: string;
    signedOut: string;
    revokeUnconfirmed: string;
  };
  shell: { footerNav: string; update: { downloading: string; working: string; ready: string; failed: string; restart: string } };
  sessionInfo: typeof import("./locales/session-info.ts").SESSION_INFO_COPY["en-US"];
  fileViewer: typeof import("./locales/file-viewer.ts").FILE_VIEWER_COPY["en-US"];
  taskGraph: TaskGraphCopy;
  lifecycle: LifecycleCopy;
  browser: BrowserCopy;
  library: LibraryCopy;
  documents: { title: string; saved: string; editing: string; edited: string; restore: string;
    versions: string; current: string; me: string; butler: string; export: string; markdown: string; pdf: string; moreActions: string; exportMarkdown: string; exportPdf: string;
    bold: string; heading: string; list: string; addBlock: string; format: string; originalChat: string };
  projectSignpost: {
    evidenceCount: (count: number) => string;
    importantMaterials: string; projectDocuments: string; selectedDay: string; calculation: string;
    importantMaterialsHelp: string;
    sessionUnconfirmed: string;
    reviewed: string; disposition: string; result: string;
    reported: string; historyLedgerUnavailable: string; linkedResults: (count: number) => string;
    disconnected: string;
    reportQuestion: string;
    periodDays: (days: number) => string; statisticsZone: (zone: string) => string;
    period: string; statisticsKind: string; materialsView: string;
    briefing: string; suggestions: string; briefingPending: string; briefingUnavailable: string; summarized: string; addToComposer: string;
    briefingCoverage: (works: number, total: number, documents: number, reports: number, excluded: number) => string;
    conversationTarget: string; newProjectConversation: string; pendingConversation: string; sourceQuestion: string;
    missingSource: string;
    loaded: (loaded: number, total: number) => string;
    results: string; noResults: string;
    overview: string; work: string; board: string; materials: string; history: string; statistics: string;
    position: string; remaining: string; completed: string; open: string; blocked: string;
    abandoned: string; unknown: string; registered: string;
    unbound: string;
    unavailable: string; noRemaining: string; tasks: string; recorded: string; loadMore: string;
    description: string; editDescription: string; pin: string; unpin: string;
    /** Header menu item and dialog title for the project's wallpaper. */
    wallpaper: string;
    created: string; updated: string; recordedCompletion: string; noHistory: string;
  };
  projectStatistics: {
    flow: string; flowHelp: string; remaining: string; remainingHelp: string; aging: string; agingHelp: string;
    calendar: string;
    workOverview: string; loading: (days: number) => string; refreshing: string; loadFailed: string; focus: string;
    activeItems: (count: number) => string;
    materials: string; materialsHelp: string; outcomes: string; outcomesHelp: string;
    duration: string; durationHelp: string; usage: string; usageHelp: string;
    empty: string; unavailable: string; historyUnavailable: string; sessionUnavailable: string; taskCompletionUnavailable: string; selected: string; all: string; partialDay: string;
    excluded: (count: number) => string; age: (days: number) => string; changes: (count: number) => string;
    sources: (count: number) => string; labels: Record<string, string>;
  };
  projectDocumentMetadata: { document: string; active: string; other: string; roadmap: string;
    sourceDetails: string; readOnly: string; referenceAction: string;
    labels: Record<string, string>; statuses: Record<string, string> };
  guided: {
    workerStatus: Record<string, string>;
    argumentLabels: Record<string, string>;
    tools: Record<string, string>;
    checkingPrevious: string; checkingRequest: string; toolWorking: string; checkingInformation: string; commandExecuting: string;
    conceptionTitle: string; planningNext: string; reportTitle: string;
    fileTitle: (action: string, target: string) => string;
    conceptionSummary: (text: string) => string;
    workInProgress: (text: string) => string;
    toolsSummary: (text: string) => string;
  };
  serverErrors: Record<string, string>;
  runtimeMessages: { ungroundedWorkerDispatch(): string; ungroundedTaskInspection(): string };
  interfaceFeedback: {
    updateReady: string;
    stewardStopFailed: string;
    stewardResumeFailed: string;
    planDecisionFailed: string;
    queueFailed: string;
    queueUpdateFailed: string;
    queueDeleteFailed: string;
    sendFailed: string;
    stopFailed: string;
    projectCreationFailed: string;
    desktopFolderOnly: string;
    projectFolderFailed: string;
    projectActionFailed: string;
    sessionActionFailed: string;
    renameFailed: string;
    retryFailed: string;
    retryCurrentFailed: string;
    workerControlFailed: string;
    uploadFailed: string;
    importFailed: string;
    requestFailed: string;
    compacting: string;
    compacted: string;
    newChat: string;
    newProjectChat: string;
    projectChat: string;
    noContext: string;
    contextUnknown: string;
    model: string;
    thinking: string;
    planning: string;
    inspecting: string;
    executing: string;
    verifying: string;
    committing: string;
    consolidating: string;
    reporting: string;
    complete: string;
    recoverable: string;
    requestResume: string;
    requestCancel: string;
  };
  interfacePanels: {
    projectChats: string;
    messages7d: string;
    messages30d: string;
    noProjectChats: string;
    noPlans: string;
    noSpecs: string;
    uiCrashed: string;
    panelCrashed: string;
    retry: string;
    reload: string;
    custom: string;
    freeContext: string;
    generalChat: string;
    projectDocumentsFailed: string;
    customProvider: string;
    automationDetailFailed: string;
    automationLoadFailed: string;
    contextDetails: string;
    contextWindow: string;
    workingContext: string;
    contextChart: string;
    contextUnavailable: string;
    noProgress: string;
    gitBranch: string;
    detachedHead: string;
    notGit: string;
    noWorkspace: string;
    noGit: string;
    worktree: string;
    projectFolder: string;
    projectWorkspace: string;
    projectWorkspaceNoGit: string;
    unavailable: string;
    dirty: string;
    clean: string;
    recentActivity: string;
    noRecentActivity: string;
    activeSessions: string;
    specs: string;
    plans: string;
    archived: string;
    usageFailed: string;
    copyResponse: string;
    artifacts: string;
    attachments: string;
    assistantDecision: string;
    copyFailed: string;
    modelRefreshFailed: string;
    controlsFailed: string;
    progress: string;
    gateway: string;
    workspace: string;
    changes: string;
    context: string;
    skills: string;
  };
  progress: { operations: Record<string, string>; fallback: string; storageRecovery: string; reconnecting: string; stopping: string; };
  briefing: { general: BriefingFallbackCopy; onboarding: BriefingFallbackCopy; projectSuggestions: (name: string) => NewChatBriefingSuggestion[]; onboardingMoment: string; projectMoment: string; projectTitle: (name: string) => string; projectDescription: (name: string) => string; };
  interfaceTemplates: {
    relativeAge: (seconds: number) => string;
    workedFor: (duration: string) => string;
    workedDuration: (totalSeconds: number) => string;
    emptyLane: (label: string) => string;
    contextMetric: (kind: "full" | "used" | "budget" | "available" | "compact", value: string | number) => string;
    activityHistory: (live: boolean, label: string, count: number) => string;
    /** 대화's live status: the current tool's label, with the count its activity group already shows. */
    chatActivity: (tool: string, count: number) => string;
    pendingApprovals: (count: number) => string;
    approvalRequest: ApprovalRequestCopy;
    allowedCount: (count: number) => string;
    grantedItems: (count: number) => string;
    revoke: (title: string) => string;
    skillTitle: (name: string) => string;
    viewActivity: (title: string) => string;
    more: (title: string, count: number) => string;
    deleteItem: (title: string) => string;
    projectConversation: (title: string) => string;
    remaining: (value: string) => string;
    resets: (value: string) => string;
    expires: (value: string) => string;
    defaultSource: (title: string) => string;
    valueSource: (title: string) => string;
    deleteRow: (title: string) => string;
    elapsed: (minutes: number, seconds: number) => string;
    homeTitle: string;
    projectHomeTitle: (name: string) => string;
    notificationNewMessage: string;
    notificationCompleted: string;
    notificationFailed: string;
    notificationCancelled: string;
    notificationUpdated: string;

  };
  firstRun: FirstRunCopy;
  interfaceDetails: {
    documentConversation: string;
    projectDocuments: string;
    searchDocuments: string;
    clearSearch: string;
    noDocuments: string;
    outputLoadFailed: string;
    loading: string;
    moreOutput: string;
    default: string;
    project: string;
    coreSkills: string;
    userSkills: string;
    projectSkills: string;
    noSkills: string;
    allowedConversation: string;
    grantScopeTag: string;
    grantCommandScope: string;
    grantTargetScope: string;
    revokeFailed: string;
    currentWork: string;
    turnActivities: string;
    contentLabel: string;
    intentLabel: string;
    nextLabel: string;
    branchSourceTitle: string;
    branchSourceDescription: string;
    branchSourceFailed: string;
    branchSource: string;
    progressDetails: string;
    toolHistory: string;
    workerActivity: string;
    noHistory: string;
    tool: string;
    answerFailed: string;
    answerStopped: string;
    answerDone: string;
    composeLater: string;
    deny: string;
    allowOnce: string;
    allowInChat: string;
    allowSite: string;
    allowPaymentSite: string;
    allowSiteDescription: string;
    paymentSkipped: (site: string, amount: string) => string;
    allowScope: string;
    allowConversation: string;
    allowDescription: string;
    branchFailed: string;
    questionPanel: {
      review: string; send: string; next: string; back: string; skip: string;
      skipped: string; later: string; pending: string; other: string;
      recommended: string; working: string; select: string;
    };
    questionAnswer: { answered: string; skipped: string; message: string };
    decisionFailed: string;
    archivesEmpty: string;
    generalConversation: string;
    unknownProject: string;
    secretPlaceholder: string;
    noMcp: string;
    literal: string;
    envReference: string;
    noEntries: string;
    applyAllSources: string;
    unarchive: string;
    delete: string;
    contextEstimates: string;
    addEnvironment: string;
    all: string;
    smartGroups: string;
    smartGroupsDescription: string;
    addHeader: string;
    inputLabel: string;
    outputLabel: string;
    planLabel: string;
    input: string;
    cache: string;
    requests: string;
    characters: string;
    results: string;
    success: string;
    failures: string;
  };
  clearChat: { archiveCount: (count: number) => string; title: string; description: string; memory: string; manageMemory: string; clear: string; busy: string; failed: string; archivedTitle: (date: string) => string };
  space: {
    general: string;
    space: string;
    reference: string;
    dashboard: string;
    newChat: string;
    subgroup: string;
    rename: string;
    moveMenu: string;
    dissolve: string;
    unpin: string;
    pin: string;
    pinShort: string;
    archive: string;
    deleteProject: string;
    navigation: string;
    undo: string;
    conversationList: string;
    primaryActions: string;
    search: string;
    favorites: string;
    favoritesHint: string;
    allFavorites: string;
    working: string;
    attention: string;
    /** A finished reply the owner has not read; the sidebar dot's name. */
    unread: string;
    /** What a waiting browser hand-off needs, in place of `attention`. */
    signInAttention: string;
    paymentAttention: string;
    tabAttention: string;
    newGroup: string;
    saveFailed: string;
    views: string;
    all: string;
    recent: string;
    running: string;
    createGroup: string;
    menu: string;
    newProject: string;
    automations: string;
    archives: string;
    favoritesDescription: string;
    moveDestination: string;
    moveDescription: string;
    searchDestination: string;
    root: string;
    noDestination: string;
    moveToRoot: string;
    collapse: string;
    expand: string;
    relocationTitle: string;
    cancel: string;
    moving: string;
    move: string;
    groupTogether: string;
    renameGroup: string;
    groupDescription: string;
    groupName: string;
    save: string;
    rowMenu: (title: string) => string;
    organized: (title: string) => string;
    relocationDescription: (source: string, target: string) => string;
  };
  interfaceStatus: {
    thinking: string;
    generalCategory: string;
    countSummary: (kind: "filesRead" | "files" | "matches" | "documents" | "results", count: string | number, truncated?: boolean) => string;
    bytes: (count: number) => string;
    lines: (range: string | number) => string;
    exitCode: (code: number) => string;
    commandStreams: (stdout: string, stderr: string) => string;
    dimensions: (rows: number, columns: number) => string;
    inputFields: string;
    minutesLimit: (minutes: number) => string;
    unsupported: string;
    permissionCheck: string;
    working: string;
    completed: string;
    failed: string;
    stopped: string;
    conception: string;
    conceptionReview: string;
    planning: string;
    planningReview: string;
    execution: string;
    taskReview: string;
    validation: string;
    feedback: string;
    consolidation: string;
    reporting: string;
    delivered: string;
    failedPast: string;
    cancelled: string;
    idle: string;
    progress: string;
    generating: string;
    modelWaiting: string;
    approvalWaiting: string;
    signInWaiting: string;
    tabWaiting: string;
    answerWaiting: string;
    workerCall: string;
    work: string;
    search: string;
    lookup: string;
    edit: string;
    command: string;
    read: string;
    review: string;
    phase: string;
    workerPhase: string;
    branchProject: string;
    branchChat: string;
    branchDescription: string;
    projectName: string;
    conversationTitle: string;
    branchPending: string;
    close: string;
    retry: string;
    create: string;
    notificationSent: string;
    notificationHidden: string;
    notificationFailed: string;
    notificationSettingsUnavailable: string;
    notificationSettingsFailed: string;
    notificationStatus: string;
    test: string;
    checking: string;
    modelRequests: string;
    inputTokens: string;
    cachedInput: string;
    uncachedInput: string;
    outputTokens: string;
    webSearch: string;
    toolCalls: string;
    totalTokens: string;
    mcpMonthly: string;
    fiveHour: string;
    weekly: string;
    individual: string;
    providedLimit: string;
    subscription: string;
    apiUsage: string;
    unconfirmed: string;
    unknown: string;
    quotaTimeout: string;
    quotaMalformed: string;
    quotaFailure: string;
    quotaTemporary: string;
    quotaUnsupported: string;
    quotaPending: string;
    quotaFetchFailed: string;
    quotaApiPlan: string;
    quotaUnknown: string;
    partialOutput: string;
    noDetailSupport: string;
    operationFailed: string;
    resultChecked: string;
    commandTimeout: string;
    commandDone: string;
    commandFailed: string;
    fileFailed: string;
    fileDone: string;
    editDone: string;
    writeDone: string;
    documentRead: string;
    pendingRead: string;
    skippedRead: string;
    truncatedRead: string;
    emptyText: string;
    fileNotFound: string;
    notFile: string;
    sensitiveFile: string;
    protectedFile: string;
    binaryFile: string;
    invalidUtf8: string;
    ioError: string;
    maxBytes: string;
    maxBytesUtf8: string;
    readFailed: string;
    spec: string;
    task: string;
    reviewNoun: string;
    report: string;
    result: string;
    draft: string;
    inProgress: string;
    blocked: string;
    specified: string;
    accepted: string;
    planned: string;
    document: string;
    file: string;
    notExecuted: string;
    toolFailed: string;
    failureReason: string;
  };
  conversation: ConversationCopy;
  sessionActions: {
    menuLabel: string;
    rename: string;
    archive: string;
    openSessionFolder: string;
    fileManager: string;
    vsCode: string;
    terminal: string;
    loadingFolderTargets: string;
    folderUnavailable: string;
    folderLaunchFailed: string;
    renameTitle: string;
    renameField: string;
    cancel: string;
    save: string;
  };
  sidebar: {
    regionLabel: string;
    newChat: string;
    newSessionStarting: string;
    search: string;
    automations: string;
    projects: string;
    chats: string;
    settings: string;
    expandChats: string;
    collapseChats: string;
    newProject: string;
    projectDashboard: string;
    newProjectChat: string;
    projectMenu: string;
    projectCreateTitle: string;
    projectRenameTitle: string;
    projectName: string;
    projectFolder: string;
    projectFolderAuto: string;
    chooseProjectFolder: string;
    useThisFolder: string;
    openSubfolderFirst: string;
    noSubfolders: string;
    showMoreFolders: string;
    parentFolder: string;
    folderPathLabel: string;
    subfoldersLabel: string;
    foldersLoadFailed: string;
    changeProjectFolder: string;
    resetProjectFolder: string;
    pin: string;
    unpin: string;
    delete: string;
    projectDeleteConfirm: (projectName: string) => string;
  };
  composer: {
    workspace: string;
    workspaceLocal: string;
    workspaceWorktree: string;
    messageComposer: string;
    /** The `@` mention list: its accessible name and the muted label on project rows. */
    mentionList: string;
    mentionProject: string;
    placeholder: string;
    placeholderFollowUp: string;
    attachedFiles: string;
    removeFile: (fileName: string) => string;
    attachFile: string;
    attachImage: string;
    imagesUnsupported: string;
    imageSupportUnknown: string;
    imageInputOff: string;
    imageTypeUnsupported: string;
    imageTooLarge: string;
    featureDrawer: string;
    attachments: string;
    responseMode: string;
    normal: string;
    attachmentCount: CountFormatter;
    permission: string;
    plan: string;
    planDecision: string;
    planAccept: string;
    planReject: string;
    planInstruction: string;
    planInstructionPlaceholder: string;
    planInstructionSubmit: string;
    planInstructionActive: string;
    model: string;
    modelSearch: string;
    modelSearchClear: string;
    allProviders: string;
    noModels: string;
    modelLoading: string;
    modelNone: string;
    modelNoneHint: string;
    gitMissingTitle: string;
    gitMissingMessage: string;
    gitInstallAction: string;
    gitMissingDismiss: string;
    reasoning: string;
    reasoningEffort: string;
    send: string;
    stop: string;
    queuedMessages: string;
    queuedMessage: string;
    sendNow: string;
    sendingStatus: string;
    sendNowFailed: string;
    queuedMessageStatus: string;
    queuedAttachmentCount: (count: number) => string;
    editQueuedMessage: string;
    deleteQueuedMessage: string;
    failedMessages: string;
    failedMessageStatus: string;
    retryFailedMessage: string;
    deleteFailedMessage: string;
    queuedPosition: (position: number, total: number) => string;
    contextDetails: string;
    usage: {
      imagesTitle: string; imagesGenerated: string; imagesEdited: string; imagesCost: string; imagesTotal: string;
      overviewTitle: string; historyTitle: string;
      lifetimeTokens: string; busiestDay: string; longestTask: string;
      longestStreak: string; currentStreak: string; days: (n: number) => string;
      viewDaily: string; viewWeekly: string; viewCumulative: string;
      weekOf: (date: string) => string; throughWeek: (date: string) => string;
      limitResetsIn: (t: string) => string; elapsedMinutes: (n: number) => string; durationHours: (n: number) => string;
      checkedAgo: (t: string) => string; resetsIn: (t: string) => string;
      limitReached: string; payAsYouGo: string; thisMonth: string;
      refreshFailedStale: (t: string) => string; estimated: string;
      chatgptProvider: string;
      thisChat: string;
      conversationPart: string;
      delegatedPart: string;
      bucketUnit: (hours: number) => string;
      calls: (count: string) => string;
      requests: (count: string) => string;
      tokens: string;
      newInput: string;
      accountLimits: string;
      now: string;
      justStarted: string;
      noUsage: string;
      chartLabel: string;
      trend: string;
      all: string;
      chats: string;
      models: string;
      tools: string;
      schedule: string;
      butlerTask: string;
      period: string;
      day: string;
      week: string;
      month: string;
      search: string;
      usageOrder: string;
      estimatedCost: string;
      share: string;
      remaining: string;
      previousPeriod: (hours: number) => string;
      previousEmpty: (previous: string) => string;
      delta: (previous: string, percent: string, higher: boolean) => string;
      similar: string;
      emptyRange: string;
      noRecords: string;
      tinyCost: string;
      tinyShare: string;
      noMatches: string;
      pickerFooter: (range: string) => string;
      viewAll: (count: number) => string;
      bucketHours: (start: number, end: number, single: boolean) => string;
      failures: (count: string) => string;
      details: string;
      cached: string;
      output: string;
      estimate: string;
      left: (percent: string) => string;
      unavailable: string;
      loading: string;
      updated: (time: string) => string;
    };
    approval: {
      title: string;
      titleEffect: string;
      categoryCommand: string;
      categoryEffect: string;
      effectReason: string;
      commandSummary: (executable: string, count: number) => string;
      effectSummary: (capability: string) => string;
      allowOnce: string;
      deny: string;
      modify: string;
      modifyPlaceholder: string;
      submitModify: string;
      decisionFailed: string;
      modifyInvalid: string;
    };
  };
  /** Access modes. `askAlways` labels wire `ask_first`; `askFirst` labels wire `ask_except_reads`. */
  permissions: {
    fullAccess: string;
    fullAccessDesc: string;
    askAlways: string;
    askAlwaysDesc: string;
    askFirst: string;
    askFirstDesc: string;
    auto: string;
    autoDesc: string;
    readOnly: string;
    readOnlyDesc: string;
    /** Tag on the recommended mode in access menus. */
    recommended: string;
  };
  automations: {
    modelDefaultDescription: string;
    saved: string;
    frequency: string;
    time: string;
    weekday: string;
    interval: string;
    daily: string;
    weekdays: string;
    weekly: string;
    once: string;
    on: string;
    off: string;
    next: (time: string) => string;
    everyMinutes: (count: number) => string;
    everyHours: (count: number) => string;
    everySeconds: (count: number) => string;
    dailyAt: (time: string) => string;
    weekdaysAt: (time: string) => string;
    weeklyAt: (days: string, time: string) => string;
    startAtLogin: string;
    loginHint: string;
    loginFailed: string;
    title: string;
    scheduledCount: (count: number) => string;
    empty: string;
    new: string;
    detailFallback: string;
    backLabel: string;
    runNow: string;
    resume: string;
    pause: string;
    fields: {
      title: string;
      prompt: string;
      details: string;
      targetChat: string;
      interval: string;
      customMinutes: string;
      state: string;
      runs: string;
    };
    placeholders: {
      title: string;
      prompt: string;
    };
    /** One line under the access selector while an asking mode is selected. */
    accessHint: string;
    /** Desktop notification when an unattended run skipped a step for permission. */
    needsPermissionNotify: string;
    signinOffNotify: string;
    paymentOffNotify: string;
    browser: { title: string; signin: string; signinDescription: string; payment: string; paymentDescription: string; unavailable: string };
    saveFailed: string;
    /** Inline messages for a save the gateway refused (400). */
    errors: {
      title: string;
      prompt: string;
      interval: string;
      accessMode: string;
      model: string;
      invalid: string;
    };
    runs: {
      empty: string;
      queued: string;
      succeeded: string;
      failed: string;
      running: string;
      skippedTargetUnavailable: string;
      /** A run that skipped a step needing permission. */
      needsPermission: string;
      signinOff: string;
      paymentOff: string;
      cancelled: string;
      notRun: string;
    };
    inspector: {
      empty: string;
    };
  };
  artifacts: {
    reload: string;
    revision: string;
    contentHostRequired: string;
    title: string;
    empty: string;
    open: string;
    save: string;
    saved: string;
    saveFailed: string;
    openInApp: string;
    openInAppBlocked: string;
    openInAppFailed: string;
    loading: string;
    unsupported: string;
    loadFailed: string;
  };
  inspector: {
    tabs: {
      summary: string;
      tasks: string;
      activity: string;
      context: string;
      artifacts: string;
      automations: string;
      workers: string;
    };
    workers: {
      hideDetails: string;
    };
  };
  common: {
    back: string;
    confirm: string;
    close: string;
    open: string;
    more: string;
    /** Accessible name of a breadcrumb trail. */
    breadcrumb: string;
    refresh: string;
    save: string;
    create: string;
    cancel: string;
    delete: string;
    copy: string;
  };
  settings: {
    mcpErrors: { save: string; notFound: string; unavailable: string; remove: string; toggle: string; probe: string; };
    skillErrors: { invalid: string; tooLarge: string; import: string; };
    archiveErrors: { restore: string; loadMore: string; };
    localModelErrors: { discover: string; register: string; };
    hooks: { add: string; edit: string; test: string; remove: string; recent: string; empty: string;
      name: string; event: string; tools: string; command: string; args: string; timeout: string;
      failClosed: string; async: string; enabled: string; refresh: string; blocked: string; editTitle: string; disabled: string; emptyRuns: string; testSuccess: string; testFailure: string;
      exitCode: string; commandDisabled: string; commandRequired: string; deleteConfirm: (name: string) => string; };

    deleteSchedule: (name: string) => string;
    deleteMcpServer: (name: string) => string;
    mcpEnabled: string;
    mcpDisabled: string;
    /** An imported server still waiting for a key in its settings. */
    mcpNeedsSecret: string;
    mcpToolFilterReview: string;
    mcpIdRequired: string;
    mcpIdInvalid: string;
    mcpIdPreview: (id: string) => string;
    mcpSaveFailed: string;
    mcpActionFailed: string;
    mcpCommandRequired: string;
    mcpUrlRequired: string;
    title: string;
    back: string;
    saving: string;
    saved: string;
    sectionsLabel: string;
    searchLabel: string;
    searchPlaceholder: string;
    searchEmpty: (query: string) => string;
    groups: {
      preferences: string;
      appAndSystem: string;
      advanced: string;
    };
    sections: {
      general: string;
      models: string;
      appearance: string;
      server: string;
      updates: string;
      mcp: string;
      hooks: string;
      skills: string;
      usage: string;
      logs: string;
      personalization: string;
      memory: string;
      privacy: string;
      browser: string;
      security: string;
      system: string;
      archives: string;
      about: string;
    };
    sectionDescriptions: {
      general: string;
      models: string;
      appearance: string;
      server: string;
      updates: string;
      mcp: string;
      hooks: string;
      skills: string;
      usage: string;
      logs: string;
      personalization: string;
      memory: string;
      privacy: string;
      browser: string;
      security: string;
      system: string;
      archives: string;
      about: string;
    };
    sectionAliases: {
      general: string[];
      models: string[];
      appearance: string[];
      server: string[];
      updates: string[];
      mcp: string[];
      hooks: string[];
      skills: string[];
      usage: string[];
      logs: string[];
      personalization: string[];
      memory: string[];
      privacy: string[];
      browser: string[];
      security: string[];
      system: string[];
      archives: string[];
      about: string[];
    };
    sectionState: { loading: string; error: string; retry: string; empty: string };
    updateComponents: { app: string; service: string };
    updateProgress: {
      idle: string; checking: string; downloading: string; verifying: string; ready: string;
      applying: string; restarting: string; failed: string; completed: string;
      retry: string; cancel: string; restart: string;
      downloadMeta: string; downloadedBytes: string; cancelled: string;
    };
    updateErrors: Record<"download" | "damaged" | "incompatible" | "storage" | "apply" | "generic", string>;
    pageSections: Record<"noticedPatterns" | "instructions" | "chatMemory" | "profileMemory" | "projectMemory" | "fullReset" | "languageRegion" | "conversationInput" | "notifications" | "notificationPermission" | "appBehavior" | "searchProvider" | "searchBehavior" | "theme" | "sidebar" | "homeScreen" | "conversation" | "messageBox" | "accessibility" | "profile" | "responseStyle" | "learning" | "import" | "butlerModel" | "backupModels" | "imageModels" | "savedKeys" | "connectedAccounts" | "memoryCleanup" | "permissions" | "defaultPermission" | "workerProfiles" | "connection" | "projects" | "diagnostics" | "appInfo" | "developer" | "remoteAccess" | "allowedHosts" | "grants" | "signIns" | "browserImport" | "agentImport" | "paymentMethods" | "profiles" | "purchaseSites", string>;
    pageSectionDescriptions: Record<"noticedPatterns" | "instructions" | "chatMemory" | "memoryCleanup" | "profileMemory" | "projectMemory" | "notificationPermission" | "searchProvider" | "searchBehavior" | "sidebar" | "homeScreen" | "conversation" | "messageBox" | "learning" | "grants", string>;
    /** The Models page's Advanced section: its header and the disclosure row that reveals its settings. */
    grants: {
      kind: Record<"command" | "fileWrite" | "network" | "tool" | "other", string>;
      scope: Record<"conversation" | "project" | "always", string>;
      conversations: (count: number) => string; cwd: (path: string) => string;
      revoke: string; revokeAlwaysTitle: string; revokeAlwaysMessage: string; revoked: string;
      search: string; filter: string; filterAll: string; empty: string; noMatch: string;
      targetUnknown: string; deletedChat: string; loadFailed: string; revokeFailed: string;
    };
    modelsAdvanced: { title: string; contents: string };
    /** Settings > General > reset everything (desktop only); the user types `phrase` to confirm. */
    fullReset: {
      label: string; description: string; action: string; title: string; body: string; removed: string; kept: string;
      field: (phrase: string) => string; phrase: string; confirm: string; mismatch: string; resetting: string; desktopOnly: string;
    };
    memory: {
      reset: string; resetChatTitle: string; resetProfileTitle: string; resetProjectTitle: string;
      resetBody: string; resetProfileBody: string; resetProjectBody: string; removed: string; kept: string;
      removedChat: (n: number) => string; removedProfile: (entries: number, candidates: number) => string;
      removedProject: (chats: number, instructions: number) => string; keptChat: string; keptProfile: string; keptProject: string;
      resetNote: string; resetChatDone: string; resetProfileDone: string; resetProjectDone: string; resetFailed: string; nothingToReset: string;
      thisChat: string; thisChatOnly: string; expiresInHours: (hours: number) => string; expiresInDays: (days: number) => string;
      linkLabel: string; linkDescription: string; linkOpen: string; linkOpenLabel: string;
      freeSpace: string; project: string; none: string; profileBuildingOff: string;
      notMeasured: string; unavailable: string; noProjects: string; allChats: string;
      patternsEmpty: string; deletePatternTitle: string; deletePatternBody: string; patternDeleted: string;
      patternDays: (n: number) => string; patternWeeks: (n: number) => string; patternMonths: (n: number) => string;
      patternCount: (n: number) => string;
      proactiveLevel: string; proactiveDescription: string; proactiveOff: string; proactiveSometimes: string; proactiveOften: string;
      quietHours: string; quietHoursDescription: string; quietHoursStart: string; quietHoursEnd: string;
      deleting: string; instructionsEmpty: string; deleteInstructionTitle: string;
      chatsKept: string; instructionDeleted: string; deleteFailed: string;
      freeWaiting: string; nothingToFree: string; inUse: string;
      storageLabel: string; freeSpaceDescription: string;
      resetChatLabel: string; resetChatDescription: string; resetProfileLabel: string; resetProfileDescription: string;
      resetProjectLabel: string; resetProjectDescription: string;
      pickTime: string; runNowLabel: string; runNowDescription: string; runNow: string; running: string;
      consolidationDone: string; consolidationFailed: string;
      lastRun: (when: string) => string; lastRunFailed: (when: string) => string; neverRun: string;
      today: string; yesterday: string;
      ago: (age: string) => string;
      freeing: (bytes: string) => string; freed: (bytes: string) => string;
      freeStopped: (bytes: string) => string; freeCancelled: (bytes: string) => string;
      facts: { instructions: string; chats: string; entries: string; candidates: string;
        size: string; updated: string; canFree: string; summary: string };
    };
    panels: {
      butlerModel: string;
      workerProfiles: string;
      backupModels: string;
      updates: string;
      mcpServers: string;
      skills: string;
      usageMonitor: string;
      systemEvents: string;
      archives: string;
      about: string;
    };
    workerJobs: {
      coding: string;
      research: string;
      debug: string;
      review: string;
      writing: string;
      custom: string;
    };
    backupModels: {
      title: string;
      description: string;
      enabled: string;
      enabledDescription: string;
      add: string;
      addTitle: string;
      searchPlaceholder: string;
      searchClearLabel: string;
      allProviders: string;
      empty: string;
      noCandidates: string;
      limitReached: string;
      /** One-line summary on the Models page. */
      summaryDescription: string;
      off: string;
      edit: string;
      editLabel: string;
      done: string;
    };
    workerProfilesPanel: {
      add: string;
      addLimitReached: string;
      maxSimultaneousWorkers: string;
    };
    /** Wallpaper picker copy and its brief toasts. */
    wallpaper: {
      moduleInvalid: string; imageUnsupported: string; imageTooLarge: string;
      options: string;
      none: string;
      image: (index: number) => string;
      addImage: string;
      deleteImage: string;
      fit: string;
      fill: string;
      fitWhole: string;
      dim: string;
      blur: string;
      filter: string;
      noFilter: string;
      unsupportedType: string;
      tooLarge: string;
      unreadable: string;
      inUse: string;
      uploadFailed: string;
      deleteFailed: string;
      /** The project picker's first tile: follow the global wallpaper. */
      inherit: string;
      saveFailed: string;
      /** Toast after the agent changes a wallpaper; `undo` restores the previous one. */
      changed: string;
      undo: string;
      undoFailed: string;
      /** Picker marker on the user's own wallpaper modules. */
      mine: string;
      /** Toast when a shown user module stops working and the default wallpaper shows instead. */
      moduleFailed: (name: string) => string;
      /** The import-module tile's caption and accessible name. */
      importModule: string;
      /** Accessible name of a user module's delete button. */
      deleteModule: string;
      /** Fallback toast when the gateway's own import error has no message. */
      moduleImportFailed: string;
      moduleTooLarge: string;
      /** Toast deleting a module a setting or project still draws with (409 `wallpaper_module_in_use`). */
      moduleInUse: string;
      moduleDeleteFailed: string;
      /** Toast importing a module whose id is installed (409 `wallpaper_module_exists`); offers `replaceModule`. */
      moduleExists: string;
      /** That toast's action: import again, replacing the installed module. */
      replaceModule: string;
    };
    fields: {
      language: string;
      timezone: string;
      followUpBehavior: string;
      multilineSend: string;
      searchSettings: string;
      searchProvider: string;
      searchProviderApiKey: string;
      searchReaderBackend: string;
      searchPlanningEnabled: string;
      searchDefaultDepth: string;
      butlerModel: string;
      butlerReasoning: string;
      consolidationModel: string;
      consolidationTime: string;
      localReasoningBudget: string;
      contextLimit: string;
      /** Settings → General → Default permission: the new-chat field. */
      chatAccess: string;
      scheduleAccess: string;
      commandSandbox: string;
      planModeDefault: string;
      name: string;
      job: string;
      customJob: string;
      domain: string;
      workerPrompt: string;
      enabled: string;
      condition: string;
      model: string;
      reasoning: string;
      theme: string;
      textSize: string;
      showThinking: string;
      conversationBackground: string; conversationOverlay: string; conversationPlain: string;
      wallpaper: string;
      wallpaperMotion: string;
      wallpaperPauseOnBattery: string;
      collapseMessageBox: string;
      reduceMotion: string;
      composerDecoration: string;
      composerCharacter: string;
      translucentSidebar: string;
      desktopNotifications: string;
      desktopNotificationAssistantMessages: string;
      desktopNotificationTaskCompletions: string;
      desktopTray: string;
      bridgeMode: string;
      serverUrl: string;
      defaultProjectFolder: string;
      appName: string;
      appVersion: string;
      appRepository: string;
      appProtocol: string;
      developerMode: string;
      butlerNickname: string;
      principalName: string;
      preferredAddress: string;
      responseLanguage: string;
      profilingMode: string;
      profilingExtractorModel: string;
      profileMigrationImport: string;
      profileMigrationPrompt: string;
      profileMigrationDump: string;
      personaPreset: string;
      persona: string;
      eol: string;
      mcpServerId: string;
      mcpServerName: string;
      mcpTransport: string;
      mcpCommand: string;
      mcpArgs: string;
      mcpUrl: string;
      mcpCwd: string;
      mcpEnv: string;
      mcpHeaders: string;
    };
    options: {
      english: string;
      korean: string;
      queueWhileBusy: string;
      steerCurrentTurn: string;
      modifierEnterSendEnterNewline: (modifier: string) => string;
      enterSendShiftEnterNewline: string;
      system: string;
      textSizeDefault: string;
      textSizeLarge: string;
      textSizeLarger: string;
      light: string;
      dark: string;
      local: string;
      external: string;
      customPersona: string;
      profilingOff: string;
      profilingBasic: string;
      profilingDeep: string;
      profilingExtractorDefault: string;
      consolidationModelDefault: string;
      stdio: string;
      http: string;
      sse: string;
      searchProviderDuckDuckGo: string;
      searchProviderAuto: string;
      searchProviderBrave: string;
      searchProviderTavily: string;
      searchProviderOpenAi: string;
      searchProviderChatGpt: string;
      searchProviderDisabled: string;
      searchReaderBrowser: string;
      searchReaderLightweight: string;
      searchReaderAuto: string;
      searchReaderLightpanda: string;
      searchReaderJina: string;
      searchReaderDisabled: string;
      searchDepthQuick: string;
      searchDepthBalanced: string;
      searchDepthDeep: string;
      timezoneSearch: string;
      timezoneSearchClear: string;
      timezoneAll: string;
      timezoneEmpty: string;
    };
    descriptions: {
      runtimeSupportedModelsOnly: string;
      chatAccess: string;
      scheduleAccess: string;
      commandSandbox: string;
      commandSandboxUnavailable: string;
      language: string;
      timezone: string;
      consolidationModel: string;
      consolidationTime: string;
      consolidationModelDefault: string;
      localReasoningBudget: string;
      wallpaper: string;
      wallpaperMotion: string;
      wallpaperPauseOnBattery: string;
      composerDecoration: string;
      composerCharacter: string;
      /** Tooltip on the theme control while a real-time wallpaper sets light/dark. */
      collapseMessageBox: string;
      reduceMotion: string;
      reduceMotionSystem: string;
      wallpaperStill: string;
      themeFollowsWallpaper: string;
      /** Tooltip on a reasoning control the model leaves no choice in. */
      reasoningFixed: string;
      contextLimit: (maxLabel: string) => string;
      contextLimitClamped: (value: string) => string;
      responseLanguage: string;
      personaPreset: string;
      profilingMode: string;
      profilingOff: string;
      profilingBasic: string;
      profilingDeep: string;
      profilingExtractorModel: string;
      profilingExtractorDefault: string;
      profileMigration: string;
      profileMigrationImporting: string;
      profileMigrationApplied: CountFormatter;
      profileMigrationStored: string;
      profileMigrationNoNewInfo: string;
      systemEvents: string;
      systemEventsEmpty: string;
      updates: string;
      eolLastLoaded: (value: string) => string;
      mcpServers: string;
      mcpSecrets: string;
      skills: string;
      searchSettings: string;
      searchProvider: string;
      searchProviderApiKey: (envVar: string) => string;
      searchProviderApiKeyConfigured: string;
      searchReaderBackend: string;
      searchPlanning: string;
      desktopNotifications: string;
      desktopNotificationAssistantMessages: string;
      desktopNotificationTaskCompletions: string;
      desktopTray: string;
      developerMode: string;
    };
    logs: {
      sections: { level: string; viewer: string; storage: string };
      levelLabel: string;
      levels: Record<"minimal" | "standard" | "detailed" | "full", string>;
      levelMeta: Record<"minimal" | "standard" | "detailed" | "full", string>;
      fullConfirmTitle: string;
      fullConfirmBody: string;
      fullConfirm: string;
      fullActive: (minutes: number) => string;
      turnOff: string;
      freed: (size: string) => string;
      categories: string;
      categoriesChanged: (count: number) => string;
      categoryInherit: string;
      severity: Record<"error" | "warn" | "info" | "debug" | "trace", string>;
      search: string;
      filters: { level: string; source: string; category: string; period: string };
      allLevels: string;
      allSources: string;
      allCategories: string;
      sources: Record<"app" | "agent", string>;
      periods: Record<"hour" | "day" | "week" | "all", string>;
      live: string;
      liveLost: string;
      newLines: (count: number) => string;
      empty: string;
      loadFailed: string;
      tabs: { request: string; response: string; json: string };
      fields: Record<"time" | "message" | "level" | "category" | "process" | "event" | "duration" | "trace" | "span" | "chat" | "turn" | "error" | "method" | "url" | "status" | "headers" | "body", string>;
      bodyUnavailable: string;
      bodyFailed: string;
      copy: string;
      copied: string;
      copyJson: string;
      stores: Record<"app" | "main" | "debug" | "bodies", string>;
      storeMeta: (used: string, limit: string, retention: string) => string;
      retentionHours: (hours: number) => string;
      retentionDays: (days: number) => string;
      exportMenu: string;
      exportTitle: string;
      exportRange: string;
      includeBodies: string;
      exportAction: string;
      exported: string;
      exportFailed: string;
      clearMenu: string;
      clearTitle: string;
      clearBody: string;
      exportDescription: string;
      clearLabel: string;
      clearDescription: string;
      cleared: (size: string) => string;
      clearFailed: string;
      diagnosticsLabel: string;
      diagnosticsDescription: string;
      diagnosticsExport: string;
      trace: LogTraceCopy;
    };
    nativeNotifications: {
      status: {
        checking: string;
        unsupported: string;
        macosPermission: string;
        windowsShortcut: string;
        linuxLibnotify: string;
        platformDependent: string;
        browserUnsupported: string;
        unavailable: string;
      };
      settings: {
        macos: string;
        windows: string;
        fallback: string;
      };
    };
    security: {
      remoteAccess: string;
      remoteAccessDescription: string;
      addresses: string;
      noAddresses: string;
      bindErrors: {
        address_in_use: string;
        permission_denied: string;
        address_unavailable: string;
        bind_failed: string;
      };
      copyAddress: string;
      copied: string;
      code: string;
      pairDevice: string;
      expiresIn: (seconds: number) => string;
      invalidated: string;
      paired: string;
      pairingFailed: string;
      working: string;
      devices: string;
      noDevices: string;
      revoke: string;
      revokeDevice: (name: string) => string;
      revokeAll: string;
      revokeAllTitle: string;
      revokeAllConfirm: string;
      revokeFailed: string;
      hostOnly: string;
      /** 403 admin_credential_required: this computer, but the app's admin credential is missing. */
      adminRequired: string;
      /** The Advanced section header and the disclosure row that reveals allowed hosts. */
      advanced: string;
      advancedContents: string;
      hosts: string;
      hostsDescription: string;
      contentHosts: string;
      contentHostsDescription: string;
      contentHostPlaceholder: string;
      hostCount: (n: number) => string;
      hostPlaceholder: string;
      addHost: string;
      removeHost: (host: string) => string;
      invalidHost: string;
    };
    workStatus: {
      title: string;
      description: string;
      loading: string;
      empty: string;
      unavailable: string;
      details: string;
      latestReport: string;
      recentArtifacts: string;
      actions: (completed: number, total: number) => string;
      effects: (count: number) => string;
      states: Record<"running" | "completed" | "attention" | "operational_action" | "operational_interruption", string>;
      stages: Record<"conception" | "planning" | "execution" | "review" | "validation" | "reporting", string>;
    };
    systemEventLabels: {
      titles: {
        consolidation: string;
        profile: string;
        sessionSync: string;
        contextMaintenance: string;
        consolidationCycle: string;
      };
      statuses: {
        ok: string;
        completed: string;
        failed: string;
        running: string;
        notRun: string;
        unknown: string;
      };
      metrics: Record<string, string>;
      values: {
        yes: string;
        no: string;
        deep: string;
        basic: string;
        off: string;
      };
    };
    actions: {
      chooseFolder: string;
      applyPersonalization: string;
      savePersonalization: string;
      openProfileMigration: string;
      closeProfileMigration: string;
      copyMigrationPrompt: string;
      importProfileMigration: string;
      importProfileMigrationRunning: string;
      addMcpServer: string;
      testMcpServer: string;
      editMcpServer: string;
      deleteMcpServer: string;
      enableMcpServer: string;
      disableMcpServer: string;
      importSkill: string;
      createSkillWithChat: string;
      checkUpdates: string;
      receivePreviewVersions: string;
      receivePreviewVersionsDescription: string;
      updateComponent: string;
      upToDate: string;
      updateChecking: string;
      updateUnavailable: string;
      updateChoice: string;
      updateCheckpoint: string;
      updateAfterWork: string;
      updateNow: string;
      updateDeferred: string;
      updateRestarting: string;
      updateApplying: string;
    };
    placeholders: {
      butlerNickname: string;
      principalName: string;
      preferredAddress: string;
      profileMigrationDump: string;
      persona: string;
      eol: string;
      mcpArgs: string;
      mcpEnv: string;
      mcpHeaders: string;
    };
    errors: {
      saveFailed: string;
      loadPersonalization: string;
      updateSettings: string;
      chooseFolder: string;
      updatePersonalization: string;
      profileMigration: string;
      profileMigrationProfilingOff: string;
      updateLocalReasoningBudget: string;
      loadAppInfo: string;
      updateDeveloperMode: string;
      loadUpdates: string;
      checkUpdates: string;
      applyUpdate: string;
    };
    localModels: {
      apiKey: string;
      apiKeyDescription: string;
      apiKeyPlaceholder: string;
      apiKeyRemoved: string;
      removeApiKey: string;
      title: string;
      description: string;
      provider: string;
      apiInfoTitle: string;
      modelInfoTitle: string;
      apiType: string;
      apiDescription: string;
      platformHint: string;
      serverUrl: string;
      discoverModels: string;
      discovering: string;
      registerModel: string;
      registering: string;
      saveModel: string;
      saving: string;
      showAdvanced: string;
      hideAdvanced: string;
      unsavedChanges: string;
      discoveredModel: string;
      discoveredModelDescription: string;
      manualFallback: string;
      modelId: string;
      displayName: string;
      maxContext: string;
      responseTimeout: string;
      responseTimeoutDescription: (defaultSeconds: number | undefined) => string;
      responseTimeoutError: (range: { min: number; max: number } | undefined) => string;
      imageInput: string;
      registeredLocalModels: string;
      customOpenAiCompatible: string;
      discoveredStatus: (count: number) => string;
      registeredStatus: (modelName: string) => string;
      savedStatus: (modelName: string) => string;
      editingStatus: (modelName: string) => string;
      deleteConfirm: (modelName: string) => string;
      deletedStatus: (modelName: string) => string;
      editLabel: (modelName: string) => string;
      deleteLabel: (modelName: string) => string;
      reasoningBudgetLabel: (percent: string) => string;
      errors: {
        discover: string;
        register: string;
        update: string;
        delete: string;
      };
    };
    modelManagement: {
      title: string;
      addTitle: string;
      editTitle: string;
      manageButton: string;
      addButton: string;
      registeredTitle: string;
      emptyRegistered: string;
      provider: string;
      model: string;
      authMethod: string;
      apiBaseUrl: string;
      apiKey: string;
      credential: string;
      credentialLabel: string;
      newCredential: string;
      chatgptOauth: string;
      apiKeyAuth: string;
      save: string;
      saveAdd: string;
      saveEdit: string;
      saving: string;
      edit: string;
      delete: string;
      deleteConfirm: (modelName: string) => string;
      registeredStatus: (modelName: string) => string;
      deletedStatus: (modelName: string) => string;
      editLabel: (modelName: string) => string;
      deleteLabel: (modelName: string) => string;
      authTag: (authType: string, credential: string) => string;
      errors: {
        save: string;
        delete: string;
        oauthLogin: string;
      };
    };
    /** Settings > Models saved API keys (#217). */
    connectedAccounts: {
      empty: string;
      provider: string;
      kind: Record<"sign_in" | "legacy_sign_in", string>;
      obtained: (date: string) => string;
      expires: (date: string) => string;
      signOut: string;
      signOutOf: (name: string) => string;
      confirm: (name: string) => string;
      done: string;
      revokeUnconfirmed: string;
      error: string;
    };
    savedKeys: {
      empty: string;
      /** Registered models that use the key; 0 reads as not in use. */
      usedBy: (count: number) => string;
      /** Where the key is kept: this computer's data folder, or the system store. */
      storage: { local: string; keychain: string; secretService: string; credentialManager: string };
      replace: string;
      replaceLabel: (name: string) => string;
      newKey: string;
      save: string;
      cancel: string;
      checking: string;
      replacedStatus: (name: string) => string;
      delete: string;
      deleteLabel: (name: string) => string;
      /** Tooltip on Delete for the default model's key. */
      deleteDefaultHint: string;
      deleteConfirm: (name: string) => string;
      /** Deleting also removes the models that use the key. */
      deleteConfirmModels: (name: string, count: number) => string;
      deletedStatus: (name: string) => string;
      errors: { delete: string };
    };
    /** Settings → Browser → Sign-ins. Passwords are never shown. */
    signIns: {
      empty: string;
      /** Tooltip when only the owner-only file store exists. */
      unavailable: string;
      add: string;
      site: string;
      sitePlaceholder: string;
      username: string;
      password: string;
      save: string;
      cancel: string;
      saved: string;
      failed: string;
      policyLabel: string;
      policy: { always: string; ask: string; never: string };
      noPassword: string;
      conversations: (count: number) => string;
      lastUsed: (when: string) => string;
      notUsed: string;
      allConversations: string;
      deletePassword: string;
      deleteConfirm: (site: string) => string;
      signOut: string;
      signedOut: string;
      revoke: string;
      revokeConfirm: (site: string) => string;
      revoked: string;
    };
    /** Settings → Browser → Payment methods and Profile details. Card numbers,
     * CVCs and identity numbers are never shown; a card number is revealed only
     * after the operating system verifies the user. */
    vault: {
      unavailable: string;
      emptyCards: string;
      emptyProfiles: string;
      emptyPurchaseSites: string;
      add: string;
      save: string;
      cancel: string;
      edit: string;
      delete: string;
      saved: string;
      failed: string;
      nickname: string;
      cardNumber: string;
      expiry: string;
      cvc: string;
      holderName: string;
      pin2: string;
      ownerId: string;
      keepSecret: string;
      reveal: string;
      revealUnavailable: string;
      hide: string;
      expired: string;
      deleteConfirm: (name: string) => string;
      askEveryTime: string;
      allowedSites: (count: number) => string;
      site: string;
      sitePlaceholder: string;
      addSite: string;
      removeSite: (site: string) => string;
      lastUsed: (when: string) => string;
      notUsed: string;
      familyName: string;
      givenName: string;
      latinName: string;
      organization: string;
      country: string;
      postalCode: string;
      region: string;
      city: string;
      addressLine1: string;
      addressLine2: string;
      idSection: string;
      issuingCountry: string;
      autofillName: string;
      latinSurname: string;
      latinGiven: string;
      birthDate: string;
      gender: string;
      genderOptions: { M: string; F: string };
      nationality: string;
      passportNumber: string;
      passportExpiry: string;
      rrn: string;
      phone: string;
      email: string;
      profileName: string;
      nameSection: string;
      contactSection: string;
      addressSection: string;
      otherSection: string;
      passport: string;
    };
    /** Settings → Security → import from another browser (counts only). */
    browsingAgent: {
      label: string;
      auto: (model: string) => string;
      off: string;
      conversationModel: string;
    };
    browserImport: {
      chooseItems: string;
      /** One-line purpose under the import title. */
      purpose: string;
      /** Secondary action: import exported bookmark or password files. */
      fromFile: string;
      importing: string;
      history: string;
      result: (bookmarks: number, passwords: number, updated: number, history?: number, invalid?: number) => string;
      more: string;
      pickFolder: string;
      diskAccess: string;
      restartAfterAccess: string;
      closeBrowser: string;
      retry: string;
      primaryPassword: string;
      wrongPrimaryPassword: string;
      exportPasswords: string;
      waitingCsv: string;
      cancel: string;
      skip: string;
      continue: string;
      source: string;
      noSources: string;
      bookmarks: string;
      passwords: string;
      htmlFile: string;
      csvFile: string;
      chooseFile: string;
      preview: string;
      bookmarkCount: (count: number, folders: number) => string;
      passwordCount: (count: number, sites: number) => string;
      run: string;
      imported: (count: number, skipped: number) => string;
      deleteCsv: string;
      fullDiskAccess: string;
      failed: string;
      needsKeychain: string;
      /** The settings button and the import dialog's title. */
      open: string;
      /** Label of the settings row that opens the dialog. */
      dataLabel: string;
      /** Dialog step names (step 2 uses chooseItems, step 3 uses run) and the stepper's accessible name. */
      chooseBrowser: string;
      steps: string;
      next: string;
      back: string;
      done: string;
    };
    /** Import from other AI tools: instructions and MCP servers, never secrets. */
    agentImport: {
      /** One-line purpose under the section title. */
      purpose: string;
      /** What a detected tool holds (instructions, MCP server count). */
      found: (instructions: boolean, servers: number) => string;
      run: string;
      importing: string;
      result: (instructions: number, servers: number, needsSecret: number) => string;
      nothingNew: string;
      more: string;
      noSources: string;
      failed: string;
      retry: string;
    };
  };
  titlebar: {
    hideLeftPanel: string;
    showLeftPanel: string;
    resizeLeftPanel: string;
    resizeRightPanel: string;
    /** Second line of a resize handle's hover hint, under its label. */
    dragToResize: string;
    commandPalette: string;
    sessionWorktree: (branch?: string) => string;
    localWorkspace: (branch?: string) => string;
    sessionFolder: (folder: string, branch?: string) => string;
    hideRightPanel: string;
    showRightPanel: string;
    minimizeWindow: string;
    maximizeWindow: string;
    closeWindow: string;
  };
  commandPalette: {
    label: string;
    placeholder: string;
    close: string;
    loading: string;
    empty: string;
    failed: string;
    kindLabels: Record<"chat" | "project" | "project_session" | "group" | "automation" | "settings", string>;
    /** Keyed by the stable settings result id suffix (`settings:<key>`). */
  };
  feedback: {
    retry: string;
    attachmentFailed: string;
    attachmentRetry: (names: string) => string;
    attachmentTooLarge: string;
    attachmentEmpty: (names: string) => string;
    attachmentSizeLimit: (names: string, limit: string) => string;
    reconnecting: string;
    reconnectingShort: string;
    agentStopped: string;
    agentRestarting: string;
    agentRestartFailed: string;
    /** A browser client saw the desktop app reset Butler. */
    agentReset: string;
    reconnect: string;
    agentStart: string;
    agentStartFailed: string;
    dashboardLoading: string;
    dashboardFailed: string;
    dashboardRetry: string;
    projectMissing: string;
    projectMissingHelp: string;
    newChat: string;
  };
}

export interface InterfaceTextReference {
  key: "workerStatus" | "toolTitle" | "checkingPrevious" | "checkingRequest" | "toolWorking" | "checkingInformation" | "commandExecuting" | "conceptionTitle" | "planningNext" | "reportTitle" | "conceptionSummary" | "workInProgress" | "toolsSummary";
  parameters?: { phase?: string; toolName?: string; target?: string; text?: string; tools?: Array<{ name: string; target?: string }> };
}

export interface InterfaceContentReferences {
  title?: InterfaceTextReference;
  summary?: InterfaceTextReference;
  nextStep?: InterfaceTextReference;
}
