import { getAppCopy, type AppCopy, type AppLocale } from "../../../butler-i18n/src/index.ts";
import type { AnsweredUserQuestions, ConversationMessage, ApprovalSummaryWire, PendingUserQuestions, SessionView, UserQuestion, UserQuestionAnswer } from "../../../butler-protocol/src/index.ts";

type AccessMode = NonNullable<NonNullable<ApprovalSummaryWire["schedule"]>["access_mode"]>;
type ApprovalRisk = NonNullable<ApprovalSummaryWire["risk"]>;
type ApprovalTarget = ApprovalSummaryWire["targets"][number];
interface ApprovalSummary {
  operation?: ApprovalSummaryWire["operation"];
  commandAccess?: ApprovalSummaryWire["command_access"];
  schedule?: { title: string; scheduleType: "once" | "interval" | "daily" | "weekdays" | "update";
    browserSignin?: boolean; browserPayment?: boolean; time?: string; runAt?: string; startAt?: string;
    intervalSeconds?: number; accessMode?: AccessMode };
  actionKind: string; targets: ApprovalTarget[]; count: number; examples: string[];
  examplesTruncated?: boolean[]; risk?: ApprovalRisk;
}
export interface AuthorityApprovalCard {
  requestRef: string; category: "command" | "reviewed_effect"; reason: string; executable: string; commandCount: number;
  scope?: { title: string; description: string }; approval?: ApprovalSummary;
  sourceTurnId?: string; sourceCallId?: string; sourceSessionId?: string;
}

type ApprovalRequestCopy = AppCopy["interfaceTemplates"]["approvalRequest"];

export const APPROVAL_ACTION_KINDS = [
  "generate_image", "edit_image", "edit_files", "run_command", "network_command", "web_request", "use_connector", "manage_schedule",
  "update_project", "start_conversation", "restart_service", "create_worktree", "switch_folder", "other",
] as const;
export type ApprovalActionKind = (typeof APPROVAL_ACTION_KINDS)[number];

const COMMAND_KINDS: ReadonlySet<string> = new Set(["run_command", "network_command"]);

export type ApprovalDetail = string | { code: string };
export function detailText(line: ApprovalDetail): string {
  return typeof line === "string" ? line : line.code;
}

export interface ApprovalRequestView {
  title: string;
  details: ApprovalDetail[];
  pathDetails?: string[];
  risk: ApprovalRisk;
  conversationScope?: string;
  ruleText?: string;
  actionKind: ApprovalActionKind;
}

const MAX_EXAMPLES = 3;
const DETAIL_TARGET_KINDS: ReadonlySet<string> = new Set(["connector", "schedule", "other", "outside", "file"]);
const RISKS: readonly string[] = ["low", "medium", "high"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeApprovalSummary(value: unknown): ApprovalSummary | undefined {
  if (!isRecord(value)) return undefined;
  const { action_kind: actionKind, count = 1, risk } = value;
  if (typeof actionKind !== "string" || !actionKind.trim()) return undefined;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined;
  const { targets, relative } = approvalTargetsFromTransport(value.targets);
  const examples: string[] = [];
  const examplesTruncated: boolean[] = [];
  (Array.isArray(value.examples) ? value.examples : []).forEach((example, index) => {
    if (typeof example !== "string" || !example.trim()) return;
    const text = COMMAND_KINDS.has(actionKind) || !isAbsolutePath(example) ? example : relative(example);
    if (!text) return;
    examples.push(text);
    examplesTruncated.push(Array.isArray(value.examples_truncated) && value.examples_truncated[index] === true);
  });
  const operation = normalizeOperation(value.operation);
  const schedule = normalizeSchedule(value.schedule);
  return {
    actionKind, targets, count, examples,
    ...(operation ? { operation } : {}),
    ...(schedule ? { schedule } : {}),
    ...(value.command_access === "read_only_unisolated" ? { commandAccess: value.command_access } : {}),
    ...(examplesTruncated.some(Boolean) ? { examplesTruncated } : {}),
    ...(typeof risk === "string" && RISKS.includes(risk) ? { risk: risk as ApprovalRisk } : {}),
  };
}

type BrowserStep = NonNullable<NonNullable<ApprovalSummary["operation"]>["browser_steps"]>[number];
function normalizeBrowserSteps(value: unknown): BrowserStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((step): BrowserStep[] => {
    if (!isRecord(step) || typeof step.action !== "string" || typeof step.role !== "string"
      || typeof step.name !== "string" || typeof step.frame !== "string" || !Array.isArray(step.addons)
      || !step.addons.every((addon): addon is string => typeof addon === "string")) return [];
    return [{ action: step.action, role: step.role, name: step.name, frame: step.frame,
      ...(typeof step.value_preview === "string" ? { value_preview: step.value_preview } : {}), addons: step.addons }];
  });
}

function normalizeSchedule(value: unknown): ApprovalSummary["schedule"] {
  if (!isRecord(value) || typeof value.title !== "string"
    || (!["once", "interval", "daily", "weekdays", "update"].includes(String(value.schedule_type)))) return undefined;
  const text = (key: string) => typeof value[key] === "string" && value[key].trim() ? value[key] : undefined;
  const runAt = text("run_at");
  const startAt = text("start_at");
  return { title: value.title.trim(), scheduleType: value.schedule_type as NonNullable<ApprovalSummary["schedule"]>["scheduleType"],
    ...(typeof value.browser_signin === "boolean" ? { browserSignin: value.browser_signin } : value.schedule_type !== "update" ? { browserSignin: false } : {}),
    ...(typeof value.browser_payment === "boolean" ? { browserPayment: value.browser_payment } : value.schedule_type !== "update" ? { browserPayment: false } : {}),
    ...(text("time") ? { time: text("time") } : {}),
    ...(runAt ? { runAt } : {}), ...(startAt ? { startAt } : {}),
    ...(typeof value.interval_seconds === "number" ? { intervalSeconds: value.interval_seconds } : {}),
    ...(isAccessMode(value.access_mode) ? { accessMode: value.access_mode } : {}) };
}

function normalizeOperation(value: unknown): ApprovalSummary["operation"] {
  if (!isRecord(value) || typeof value.tool !== "string" || !value.tool.trim()
    || (value.access !== "read_only" && value.access !== "change")) return undefined;
  const targets = (Array.isArray(value.targets) ? value.targets : [])
    .filter((target): target is string => typeof target === "string" && Boolean(target.trim()));
  const browser_steps = normalizeBrowserSteps(value.browser_steps);
  const rule_prefixes = Array.isArray(value.rule_prefixes)
    ? value.rule_prefixes.filter((prefix): prefix is string => typeof prefix === "string" && !!prefix)
    : [];
  const rule = value.permission_rule;
  return { tool: value.tool, access: value.access, targets,
    ...(rule_prefixes.length ? { rule_prefixes } : {}),
    ...(isRecord(rule) && (rule.effect === "allow" || rule.effect === "deny")
      && (rule.kind === "command_prefix" || rule.kind === "folder")
      && (rule.scope === "conversation" || rule.scope === "always") && typeof rule.reason === "string"
      ? { permission_rule: { effect: rule.effect, kind: rule.kind, scope: rule.scope, reason: rule.reason } } : {}),
    ...(typeof value.browser_tab === "string" ? { browser_tab: value.browser_tab } : {}),
    ...(browser_steps ? { browser_steps } : {}),
    ...(typeof value.sign_in_step === "string" ? { sign_in_step: value.sign_in_step } : {}),
    ...(typeof value.wait_reason === "string" ? { wait_reason: value.wait_reason } : {}),
    ...((value.browser_mode === "signed_out" || value.browser_mode === "signed_in") ? { browser_mode: value.browser_mode } : {}),
    ...(value.allow_site === "signed_in" || value.allow_site === "payment" ? { allow_site: value.allow_site } : {}),
    ...(typeof value.allow_conversation === "boolean" ? { allow_conversation: value.allow_conversation } : {}),
    ...(typeof value.command === "string" && value.command.trim() ? { command: value.command } : {}) };
}

export function approvalRequestView(
  card: Pick<AuthorityApprovalCard, "approval" | "scope" | "reason">,
  appCopy: AppCopy,
  toolLabels: Record<string, string> = appCopy.guided.tools,
  locale: AppLocale = "en-US",
): ApprovalRequestView {
  const copy = appCopy.interfaceTemplates.approvalRequest;
  const { approval, scope } = card;
  if (!approval) {
    return {
      title: scope ? `${scope.title} · ${scope.description}` : card.reason,
      details: [],
      risk: "high",
      actionKind: "other",
      ...(scope ? { conversationScope: scope.description } : {}),
    };
  }
  const actionKind = knownActionKind(approval);
  const workspace = workspaceLabel(approval, copy);
  const operation = approval.operation;
  if (operation?.tool === "propose_permission_rule" && operation.permission_rule) {
    const { effect, kind, scope, reason } = operation.permission_rule;
    return {
      title: copy.proposeRule.title, risk: approval.risk ?? "medium", actionKind: "other",
      details: [
        ...(card.reason === "authority.taintReason" ? [copy.taintReason] : []),
        kind === "folder" ? copy.proposeRule.folder : copy.proposeRule.effect[effect][scope],
        { code: operation.targets[0] ?? "" },
        reason,
      ],
    };
  }
  const ruleText = operation?.rule_prefixes?.length
    ? appCopy.interfaceDetails.rulePrefixes(operation.rule_prefixes.join(", ")) : undefined;
  // A tool without a readable label reads as its action kind's sentence, never its internal name.
  const label = operation ? toolLabels[operation.tool] : undefined;
  return {
    title: actionKind === "generate_image" || actionKind === "edit_image" ? sentence(actionKind, approval, workspace, copy, appCopy) : operation && label && !SENTENCE_KINDS.has(actionKind) ? copy.operation(label, operation.access === "read_only")
      : sentence(actionKind, approval, workspace, copy, appCopy),
    details: [...(card.reason === "authority.taintReason" ? [copy.taintReason] : []),
      ...(card.reason === "authority.unsandboxedReason" ? [copy.unsandboxedReason] : []),
      ...(actionKind === "web_request" ? [copy.webRequestDesc] : []),
      ...actionDetails(approval, actionKind, card, copy, appCopy, locale)],
    pathDetails: operation?.targets.map(target => chatFolderShown(target, copy.chatFolder)) ?? [...(!COMMAND_KINDS.has(actionKind) ? approval.examples.filter(isAbsolutePath) : []),
      ...approval.targets.filter(target => target.kind === "outside").map(target => target.path)],
    risk: approval.risk ?? "high",
    ruleText,
    conversationScope: ruleText ?? (approval.targets.some(target => target.kind === "outside") ? copy.covers.other : actionKind === "edit_files" ? copy.covers.editFiles(workspace)
      : COMMAND_KINDS.has(actionKind) ? copy.covers.command(workspace)
        : copy.covers.other),
    actionKind,
  };
}

function knownActionKind(approval: ApprovalSummary): ApprovalActionKind {
  return (APPROVAL_ACTION_KINDS as readonly string[]).includes(approval.actionKind) ? approval.actionKind as ApprovalActionKind : "other";
}

function actionDetails(approval: ApprovalSummary, kind: ApprovalActionKind,
  card: Pick<AuthorityApprovalCard, "scope" | "reason">, copy: ApprovalRequestCopy, appCopy: AppCopy, locale: AppLocale): ApprovalDetail[] {
  const { schedule, operation } = approval;
  if (schedule) return [schedule.title,
    ...(schedule.scheduleType !== "update" ? [scheduleTiming(schedule, appCopy, locale)]
      : !schedule.accessMode && typeof schedule.browserSignin !== "boolean" && typeof schedule.browserPayment !== "boolean" ? [copy.scheduleUnavailable] : []),
    ...(schedule.accessMode ? [copy.scheduleMode(accessLabel(schedule.accessMode, appCopy))] : []),
    ...(typeof schedule.browserSignin === "boolean" ? [copy.scheduleSignin(schedule.browserSignin)] : []),
    ...(typeof schedule.browserPayment === "boolean" ? [copy.schedulePayment(schedule.browserPayment)] : []), ...approval.examples].filter(Boolean);
  if (kind === "manage_schedule") return [copy.scheduleUnavailable];
  // An example is a capped copy of the command: when the operation carries the whole command, a prefix of it is a duplicate.
  const examples = approval.examples.filter(example => !operation?.command || example === operation.command || !operation.command.startsWith(example));
  if (!operation) return details(approval, kind, card, copy);
  // Each text shows once, as its first line (the operation's command before an equal example), as the old Set did.
  const lines = [...operationDetails(operation, copy), ...examples.map(example => COMMAND_KINDS.has(kind) ? { code: example } : example)];
  return lines.filter((line, index) => lines.findIndex(other => detailText(other) === detailText(line)) === index);
}

const SENTENCE_KINDS: ReadonlySet<string> = new Set(["web_request", "manage_schedule"]);

function operationDetails(operation: NonNullable<ApprovalSummary["operation"]>, copy: ApprovalRequestCopy): ApprovalDetail[] {
  return [...(operation.command ? [{ code: operation.command }] : []),
    ...operation.targets.map(target => chatFolderShown(target, copy.chatFolder)).map((target, index) => index === 0 && operation.browser_mode ? `${target} · ${copy.browserMode[operation.browser_mode]}` : target),
    ...(operation.tool === "browser_sign_in_wait" ? [copy.signInStep(operation.sign_in_step ?? "unknown_form")] : []),
    ...(operation.tool === "browser_pay_wait" ? [copy.payStep(operation.wait_reason ?? "unknown_form")] : []),
    ...(operation.browser_steps ?? []).map(step => [copy.browserStep(step.action, step.role, step.name, step.frame), step.value_preview, ...step.addons].filter(Boolean).join(" · "))];
}

function sentence(kind: ApprovalActionKind, approval: ApprovalSummary, workspace: string | null, copy: ApprovalRequestCopy, appCopy: AppCopy): string {
  const outside = approval.targets.some(target => target.kind === "outside");
  switch (kind) {
    case "generate_image": return appCopy.guided.tools.generate_image;
    case "edit_image": return appCopy.guided.tools.edit_image;
    case "edit_files": return outside ? copy.editFilesOutside(approval.count) : copy.editFiles(approval.count, workspace);
    case "run_command": return outside ? copy.runCommandOutside : copy.runCommand(workspace);
    case "web_request": return copy.webRequest;
    case "network_command": return outside ? copy.networkCommandOutside : copy.networkCommand(workspace);
    case "use_connector": {
      const path = approval.targets.find((target) => target.kind === "connector")?.path.trim() ?? "";
      const slash = path.indexOf("/");
      return slash > 0 ? copy.useConnector(path.slice(slash + 1) || null, path.slice(0, slash))
        : copy.useConnector(path || null, null);
    }
    case "manage_schedule": return copy.manageSchedule[scheduleOperation(approval).operation];
    case "update_project": return copy.updateProject;
    case "start_conversation": return copy.startConversation;
    case "restart_service": return copy.restartService;
    case "create_worktree": return copy.createWorktree;
    case "switch_folder": return copy.switchFolder;
    case "other": return copy.generic;
  }
}

function workspaceLabel(approval: ApprovalSummary, copy: ApprovalRequestCopy): string | null {
  const label = (approval.targets.find((target) => target.kind === "folder" && target.label?.trim())
    ?? approval.targets.find((target) => target.label?.trim()))?.label?.trim();
  return label ? chatFolderShown(label, copy.chatFolder) : null;
}

function scheduleOperation(approval: ApprovalSummary): { operation: "create" | "delete" | "run" | "change" } {
  const path = approval.targets.find((target) => target.kind === "schedule")?.path ?? "";
  const [, operation = ""] = path.split(":");
  if (operation === "create") return { operation: "create" };
  if (operation === "delete" || operation === "delete_automation") return { operation: "delete" };
  if (operation === "due") return { operation: "run" };
  return { operation: "change" };
}

function details(
  approval: ApprovalSummary,
  kind: ApprovalActionKind,
  card: Pick<AuthorityApprovalCard, "scope" | "reason">,
  copy: ApprovalRequestCopy,
): ApprovalDetail[] {
  const notice = approval.commandAccess === "read_only_unisolated" ? [copy.readOnlyUnisolated] : [];
  const shown = shownExamples(approval);
  const outside = approval.targets.filter(target => target.kind === "outside").map(target => target.path);
  if (shown.length) {
    const additionalOutside = outside.filter(path => !shown.includes(path));
    const rest = approval.count - shown.length - (kind === "edit_files" ? additionalOutside.length : 0);
    return [...notice, ...additionalOutside, ...shown.map(example => COMMAND_KINDS.has(kind) ? { code: example } : example),
      ...(rest > 0 ? [copy.more(rest)] : [])];
  }
  // Without examples, say what the request acts on: its targets, else the reason.
  const targets = approval.targets.filter((target) => DETAIL_TARGET_KINDS.has(target.kind)).map((target) => target.path);
  const lines = targets.map((line) => line.trim()).filter(Boolean);
  if (lines.length || kind !== "other") return lines;
  const fallback = (card.scope?.description ?? card.reason).trim();
  return fallback ? [fallback] : [];
}

function shownExamples(approval: ApprovalSummary): string[] {
  return approval.examples.slice(0, MAX_EXAMPLES).map((example, index) => approval.examplesTruncated?.[index] ? `${example}…` : example);
}

export interface BrowserHandoffView { title: string; details: string[]; signIn: boolean }

export function browserHandoffView(
  card: Pick<AuthorityApprovalCard, "approval">,
  copy: ApprovalRequestCopy,
): BrowserHandoffView | undefined {
  const operation = card.approval?.operation;
  const where = copy.signInHandoff.onDesktop;
  const site = operation?.targets.find(Boolean);
  if (operation?.tool === "browser_sign_in_wait") {
    const step = copy.signInStep(operation.sign_in_step ?? "unknown_form");
    return { title: copy.signInHandoff.title, details: [site ? `${site} · ${step}` : step, where], signIn: true };
  }
  if (operation?.tool === "browser_pay_wait") {
    const step = copy.payStep(operation.wait_reason ?? "unknown_form");
    return { title: copy.payHandoff, details: [site ? `${site} · ${step}` : step, where], signIn: true };
  }
  if (operation?.tool !== "browser_wait_for_user") return undefined;
  const reason = operation.wait_reason ?? "other";
  return { title: copy.waitHandoff(reason), details: site ? [site, where] : [where], signIn: ["sign_in", "secure_field", "secure_keypad"].includes(reason) };
}

function isAccessMode(value: unknown): value is AccessMode {
  return typeof value === "string" && ["auto", "read_only", "ask_first", "ask_except_reads", "full_access"].includes(value);
}
function accessLabel(mode: AccessMode, appCopy: AppCopy): string {
  const p = appCopy.permissions;
  return { auto: p.auto, read_only: p.readOnly, ask_first: p.askAlways, ask_except_reads: p.askFirst, full_access: p.fullAccess }[mode];
}

export function normalizeApprovalCard(
  entry: unknown,
): AuthorityApprovalCard | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.request_ref !== "string" || !record.request_ref.trim()) {
    return null;
  }
  if (record.category !== "command" && record.category !== "reviewed_effect") return null;
  if (typeof record.reason !== "string" || !record.reason.trim()) return null;
  if (typeof record.executable !== "string" || !record.executable.trim()) {
    return null;
  }
  if (
    typeof record.command_count !== "number" ||
    !Number.isSafeInteger(record.command_count) ||
    record.command_count < 1
  ) {
    return null;
  }
  const approval = normalizeApprovalSummary(record.approval);
  return {
    requestRef: record.request_ref,
    category: record.category,
    reason: record.reason,
    executable: record.executable,
    commandCount: record.command_count,
    ...(record.scope && typeof record.scope === "object" && "title" in record.scope && "description" in record.scope &&
      typeof record.scope.title === "string" && typeof record.scope.description === "string"
      ? { scope: { title: record.scope.title, description: record.scope.description } } : {}),
    ...(approval ? { approval } : {}),
    ...(typeof record.source_turn_id === "string" ? { sourceTurnId: record.source_turn_id } : {}),
    ...(typeof record.source_call_id === "string" ? { sourceCallId: record.source_call_id } : {}),
    ...(typeof record.source_session_id === "string" ? { sourceSessionId: record.source_session_id } : {}),
  };
}

const ABSOLUTE_PATH = /^(?:\/|~(?:[\\/]|$)|[A-Za-z]:[\\/]|\\\\)/u;
const TRAILING_SEPARATORS = /(?<=.)[\\/]+$/u;

export function isAbsolutePath(path: string): boolean {
  return ABSOLUTE_PATH.test(path.trim());
}

function within(path: string, root: string | undefined): string | undefined {
  if (!root || !path.startsWith(root)) return undefined;
  const rest = path.slice(root.length);
  if (rest && !/^[\\/]/u.test(rest)) return undefined;
  if (rest.split(/[\\/]/u).includes("..")) return undefined;
  return rest.replace(/^[\\/]+/u, "");
}

export function approvalTargetsFromTransport(value: unknown): {
  targets: ApprovalTarget[];
  relative: (path: string) => string;
} {
  const raw = (Array.isArray(value) ? value : []).flatMap((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) return [];
    const { kind, path } = target as Record<string, unknown>;
    return typeof kind === "string" && typeof path === "string" ? [{ kind, path: path.trim() }] : [];
  });
  const root = raw.find((target) => target.kind === "folder" && isAbsolutePath(target.path))?.path
    .replace(TRAILING_SEPARATORS, "");
  const relative = (path: string) => {
    const trimmed = path.trim();
    if (!isAbsolutePath(trimmed)) return trimmed === "." ? "" : trimmed.replace(/^\.[\\/]/u, "");
    return within(trimmed.replace(TRAILING_SEPARATORS, ""), root) ?? trimmed;
  };
  const targets = raw.map(({ kind, path }): ApprovalTarget => {
    if (kind !== "folder") return { kind, path: relative(path) };
    const label = path.replace(TRAILING_SEPARATORS, "").replace(/^\.$/u, "");
    return { kind, path: "", ...(label ? { label } : {}) };
  });
  return { targets, relative };
}

export const CHAT_FOLDER_LABEL = "@chat-folder";
export function chatFolderShown(text: string, name: string): string {
  if (text === CHAT_FOLDER_LABEL) return name;
  return text.startsWith(`${CHAT_FOLDER_LABEL}/`) ? `${name}${text.slice(CHAT_FOLDER_LABEL.length)}` : text;
}

function scheduleTiming(value: NonNullable<ApprovalSummary["schedule"]>, appCopy: AppCopy, locale: AppLocale): string {
  if ((value.scheduleType === "daily" || value.scheduleType === "weekdays") && value.time) {
    const [hour, minute] = value.time.split(":").map(Number);
    const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC" })
      .format(new Date(Date.UTC(1970, 0, 1, hour, minute)));
    return value.scheduleType === "daily" ? appCopy.conversation.initiated.dailyAt(time) : appCopy.conversation.initiated.weekdaysAt(time);
  }
  const copy = appCopy.automations, seconds = value.intervalSeconds ?? 1800;
  const frequency = value.scheduleType === "once" ? copy.once : seconds % 3600 === 0 ? copy.everyHours(seconds / 3600)
    : seconds % 60 === 0 ? copy.everyMinutes(seconds / 60) : copy.everySeconds(seconds);
  const once = value.scheduleType === "once";
  const at = once ? value.runAt : value.startAt;
  if (!at || Number.isNaN(Date.parse(at))) return frequency;
  const time = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(at));
  return `${frequency} · ${once ? time : appCopy.automations.next(time)}`;
}

export interface QuestionDraft { id: string; selected: number[]; text: string; other: string; skipped: boolean }

export function answerOptions(q: UserQuestion) {
  return q.kind === "text" ? [] : q.options.filter(o => !o.kind || o.kind === "answer");
}
export function answerWire(questions: readonly UserQuestion[], answers: readonly QuestionDraft[]): UserQuestionAnswer[] {
  return questions.map(q => {
    const a = answers.find(a => a.id === q.id);
    const options = answerOptions(q);
    return { id: q.id, selected: a?.selected.flatMap(i => options[i] ? [options[i].id] : []) ?? [],
      custom: a?.other.trim() || a?.text.trim() || null, skipped: a?.skipped ?? true };
  });
}

export type PendingDecision = { kind: "approval"; card: AuthorityApprovalCard; count: number }
  | { kind: "handoff"; card: AuthorityApprovalCard } | { kind: "question"; request: PendingUserQuestions };

export function pendingDecision(view: SessionView): PendingDecision | null {
  const cards = (view.authority_requests ?? []).flatMap(record => {
    const card = normalizeApprovalCard(record);
    return card ? [card] : [];
  });
  if (cards[0]) return browserHandoffView(cards[0], getAppCopy().interfaceTemplates.approvalRequest)
    ? { kind: "handoff", card: cards[0] } : { kind: "approval", card: cards[0], count: cards.length };
  return view.pending_questions?.[0] ? { kind: "question", request: view.pending_questions[0] } : null;
}

export type ConversationRow = ConversationMessage | { id: string; questionAnswer: AnsweredUserQuestions };

export function withQuestionAnswers(
  messages: ConversationMessage[], answers: readonly AnsweredUserQuestions[], visible: (message: ConversationMessage) => boolean,
): ConversationRow[] {
  const firstAssistant = new Map<string, string>();
  const lastMessage = new Map<string, string>();
  const previousMessage = new Map<string, string | undefined>();
  for (const [index, message] of messages.entries()) {
    if (message.turn_id) lastMessage.set(message.turn_id, message.id);
    if (message.turn_id && message.role === "assistant" && !firstAssistant.has(message.turn_id)) {
      firstAssistant.set(message.turn_id, message.id);
    }
    previousMessage.set(message.id, messages[index - 1]?.id);
  }
  const after = new Map<string | undefined, ConversationRow[]>();
  const replaced = new Set<string>();
  for (const answer of answers) {
    if (answer.response.status !== "answered") continue;
    const id = previousMessage.has(answer.followup_message_id) ? previousMessage.get(answer.followup_message_id)
      : firstAssistant.get(answer.source_turn_id) ?? lastMessage.get(answer.source_turn_id) ?? messages.at(-1)?.id;
    replaced.add(answer.followup_message_id);
    const rows = after.get(id) ?? [];
    rows.push({ id: answer.request_ref, questionAnswer: answer });
    after.set(id, rows);
  }
  return [...(after.get(undefined) ?? []), ...messages.flatMap(message => [message, ...(after.get(message.id) ?? [])])]
    .filter(row => "questionAnswer" in row || (!replaced.has(row.id) && visible(row)));
}
