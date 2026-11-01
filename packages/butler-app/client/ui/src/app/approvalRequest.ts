import { maskActionSecrets } from "./maskActionSecrets.ts";
import { appCopy } from "./copy.ts";
import type { AppCopy } from "./copy.ts";
import { approvalTargetsFromTransport, isAbsolutePath } from "./approvalTargets.ts";
import { scheduleTiming } from "./scheduleLabels.ts";
import type { AccessMode, ApprovalRisk, ApprovalSummary, AuthorityApprovalCard, ProjectHookLine } from "./types.ts";

type ApprovalRequestCopy = AppCopy["interfaceTemplates"]["approvalRequest"];

/** The `approval.action_kind` values the agent sends (#277). */
export const APPROVAL_ACTION_KINDS = [
  "generate_image", "edit_image", "edit_files", "run_command", "network_command", "web_request", "use_connector", "manage_schedule",
  "update_project", "start_conversation", "restart_service", "create_worktree", "switch_folder", "project_hooks", "other",
] as const;
export type ApprovalActionKind = (typeof APPROVAL_ACTION_KINDS)[number];

/** Kinds whose example is the command line, shown as sent. */
const COMMAND_KINDS: ReadonlySet<string> = new Set(["run_command", "network_command"]);

/** The approval card's content in the app language. */
export interface ApprovalRequestView {
  /** One plain question: what, where and how many. */
  title: string;
  /** Up to three examples, then a "+N more" line; else the targets, else the reason. Never cut. */
  details: string[];
  /** Path lines eligible for visual abbreviation; commands remain verbatim. */
  pathDetails?: string[];
  /** As the agent sent it; unknown or missing reads as high. */
  risk: ApprovalRisk;
  /** What "Always allow in this conversation" covers. */
  conversationScope?: string;
  /** Picks the icon; `other` for unknown kinds and agents without `approval`. */
  actionKind: ApprovalActionKind;
}

const MAX_EXAMPLES = 3;
/** Target kinds that say what a request without examples acts on. */
const DETAIL_TARGET_KINDS: ReadonlySet<string> = new Set(["connector", "schedule", "other", "outside", "file"]);
const RISKS: readonly string[] = ["low", "medium", "high"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Narrows a request's transport `approval`. Malformed targets and examples are
 * dropped; a missing kind or an invalid count drops the whole summary, so the
 * card falls back to the legacy text. Target and example paths come out
 * project-relative inside the root and absolute outside; command lines stay as sent.
 */
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
  const projectHooks = normalizeProjectHooks(value.project_hooks);
  return {
    actionKind, targets, count, examples,
    ...(projectHooks ? { projectHooks } : {}),
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

function normalizeProjectHooks(value: unknown): ApprovalSummary["projectHooks"] {
  if (!isRecord(value) || typeof value.folder !== "string" || !Array.isArray(value.hooks)) return undefined;
  const hooks = value.hooks.flatMap((hook): ProjectHookLine[] => {
    if (!isRecord(hook) || typeof hook.event !== "string" || typeof hook.command !== "string") return [];
    const tools = Array.isArray(hook.tools) ? hook.tools.filter((tool): tool is string => typeof tool === "string") : [];
    return [{ event: hook.event, tools, command: hook.command }];
  });
  return { folder: value.folder, ...(value.unsandboxed === true ? { unsandboxed: true } : {}), hooks };
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
  return { tool: value.tool, access: value.access, targets,
    ...(normalizeImageOperation(value.image) ? { image: normalizeImageOperation(value.image) } : {}),
    ...(typeof value.browser_tab === "string" ? { browser_tab: value.browser_tab } : {}),
    ...(browser_steps ? { browser_steps } : {}),
    ...(typeof value.sign_in_step === "string" ? { sign_in_step: value.sign_in_step } : {}),
    ...(typeof value.wait_reason === "string" ? { wait_reason: value.wait_reason } : {}),
    ...((value.browser_mode === "signed_out" || value.browser_mode === "signed_in") ? { browser_mode: value.browser_mode } : {}),
    ...(value.allow_site === "signed_in" || value.allow_site === "payment" ? { allow_site: value.allow_site } : {}),
    ...(typeof value.allow_conversation === "boolean" ? { allow_conversation: value.allow_conversation } : {}),
    ...(typeof value.command === "string" && value.command.trim() ? { command: value.command } : {}) };
}

/**
 * The card for a pending request: a sentence per action kind; the generic
 * sentence for a kind this App does not know; the legacy `scope` text (then
 * the reason) from an agent that sends no `approval`. `risk` is shown as the
 * agent sent it; the App never classifies.
 */
export function approvalRequestView(
  card: Pick<AuthorityApprovalCard, "approval" | "scope" | "reason">,
  copy: ApprovalRequestCopy,
  toolLabels: Record<string, string> = {},
): ApprovalRequestView {
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
  const workspace = workspaceLabel(approval);
  const operation = approval.operation;
  // A tool without a readable label reads as its action kind's sentence, never its internal name.
  const label = operation ? toolLabels[operation.tool] : undefined;
  return {
    title: actionKind === "generate_image" || actionKind === "edit_image" ? sentence(actionKind, approval, workspace, copy) : operation && label && !SENTENCE_KINDS.has(actionKind) ? copy.operation(label, operation.access === "read_only")
      : sentence(actionKind, approval, workspace, copy),
    details: [...(card.reason === "authority.taintReason" ? [copy.taintReason] : []),
      ...(card.reason === "authority.unsandboxedReason" ? [copy.unsandboxedReason] : []),
      ...(actionKind === "web_request" ? [copy.webRequestDesc] : []),
      ...actionDetails(approval, actionKind, card, copy)],
    pathDetails: operation?.targets ?? [...(!COMMAND_KINDS.has(actionKind) ? approval.examples.filter(isAbsolutePath) : []),
      ...approval.targets.filter(target => target.kind === "outside").map(target => target.path)],
    risk: approval.risk ?? "high",
    conversationScope: approval.targets.some(target => target.kind === "outside") ? copy.covers.other : actionKind === "edit_files" ? copy.covers.editFiles(workspace)
      : COMMAND_KINDS.has(actionKind) ? copy.covers.command(workspace)
        : copy.covers.other,
    actionKind,
  };
}

/** A skipped operation is a statement; its target uses the card's exact detail formatting. */
export function approvalActionView(approval: ApprovalSummary, copy: ApprovalRequestCopy, toolLabels: Record<string, string>) {
  const kind = knownActionKind(approval);
  return {
    label: (approval.operation && toolLabels[approval.operation.tool]) || toolLabels[approval.actionKind] || toolLabels.fallback,
    // The notice is not the decision card. No command appears in it, so it cannot mislead or leak.
    target: COMMAND_KINDS.has(kind) || approval.operation?.command ? "" : maskActionSecrets(actionDetails(approval, kind, { reason: "" }, copy)[0] ?? ""),
  };
}

function knownActionKind(approval: ApprovalSummary): ApprovalActionKind {
  return (APPROVAL_ACTION_KINDS as readonly string[]).includes(approval.actionKind) ? approval.actionKind as ApprovalActionKind : "other";
}

/** The action's details, separate from permission notices and card explanations. */
function actionDetails(approval: ApprovalSummary, kind: ApprovalActionKind,
  card: Pick<AuthorityApprovalCard, "scope" | "reason">, copy: ApprovalRequestCopy): string[] {
  const { schedule, operation, projectHooks } = approval;
  if (projectHooks) return [projectHooks.folder, copy.projectHooks.receives,
    ...(projectHooks.unsandboxed ? [copy.projectHooks.unsandboxed] : []), ...projectHooks.hooks.map(projectHookText)];
  if (schedule) return [schedule.title,
    ...(schedule.scheduleType !== "update" ? [scheduleTiming(schedule)]
      : !schedule.accessMode && typeof schedule.browserSignin !== "boolean" && typeof schedule.browserPayment !== "boolean" ? [copy.scheduleUnavailable] : []),
    ...(schedule.accessMode ? [copy.scheduleMode(accessLabel(schedule.accessMode))] : []),
    ...(typeof schedule.browserSignin === "boolean" ? [copy.scheduleSignin(schedule.browserSignin)] : []),
    ...(typeof schedule.browserPayment === "boolean" ? [copy.schedulePayment(schedule.browserPayment)] : []), ...approval.examples].filter(Boolean);
  if (kind === "manage_schedule") return [copy.scheduleUnavailable];
  // An example is a capped copy of the command: when the operation carries the whole command, a prefix of it is a duplicate.
  const examples = approval.examples.filter(example => !operation?.command || example === operation.command || !operation.command.startsWith(example));
  return operation ? [...new Set([...operationDetails(operation, copy), ...examples])] : details(approval, kind, card, copy);
}

/** "Event (tools) · exact command". */
export function projectHookText(hook: ProjectHookLine): string {
  const tools = hook.tools.length ? ` (${hook.tools.join(", ")})` : "";
  return `${hook.event}${tools} · ${hook.command}`;
}

/** Kinds whose own sentence names the action better than a tool label. */
const SENTENCE_KINDS: ReadonlySet<string> = new Set(["web_request", "manage_schedule", "project_hooks"]);

/** The exact operation, as the local decision shows it. */
function operationDetails(operation: NonNullable<ApprovalSummary["operation"]>, copy: ApprovalRequestCopy): string[] {
  if (operation.image) {
    const image = operation.image, c = appCopy.conversation.imageTools;
    const quality = c.quality[image.quality as keyof typeof c.quality] ?? image.quality;
    return [`${c.model}: ${image.model}`, `${c.size}: ${image.size === "auto" ? c.default : image.size}`,
      `${c.qualityLabel}: ${image.quality === "auto" ? c.default : quality}`, `${c.prompt}: ${image.prompt}`];
  }
  return [...(operation.command ? [operation.command] : []),
    ...operation.targets.map((target, index) => index === 0 && operation.browser_mode ? `${target} · ${copy.browserMode[operation.browser_mode]}` : target),
    ...(operation.tool === "browser_sign_in_wait" ? [copy.signInStep(operation.sign_in_step ?? "unknown_form")] : []),
    ...(operation.tool === "browser_pay_wait" ? [copy.payStep(operation.wait_reason ?? "unknown_form")] : []),
    ...(operation.browser_steps ?? []).map(step => [copy.browserStep(step.action, step.role, step.name, step.frame), step.value_preview, ...step.addons].filter(Boolean).join(" · "))];
}

function sentence(kind: ApprovalActionKind, approval: ApprovalSummary, workspace: string | null, copy: ApprovalRequestCopy): string {
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
    case "project_hooks": return copy.projectHooks.title;
    case "other": return copy.generic;
  }
}

/** The workspace's label: the folder's first, else another target's; `null` reads as "this workspace". */
function workspaceLabel(approval: ApprovalSummary): string | null {
  const label = (approval.targets.find((target) => target.kind === "folder" && target.label?.trim())
    ?? approval.targets.find((target) => target.label?.trim()))?.label?.trim();
  return label || null;
}

/** `automation:create:<id>`, `automation:delete_automation:<id>` or `automation:due:<now>` (the agent's schedule target). */
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
): string[] {
  const notice = approval.commandAccess === "read_only_unisolated" ? [copy.readOnlyUnisolated] : [];
  const shown = approval.examples.slice(0, MAX_EXAMPLES).map((example, index) =>
    approval.examplesTruncated?.[index] ? `${example}…` : example);
  const outside = approval.targets.filter(target => target.kind === "outside").map(target => target.path);
  if (shown.length) {
    const additionalOutside = outside.filter(path => !shown.includes(path));
    const rest = approval.count - shown.length - (kind === "edit_files" ? additionalOutside.length : 0);
    return [...notice, ...additionalOutside, ...shown, ...(rest > 0 ? [copy.more(rest)] : [])];
  }
  // Without examples, say what the request acts on: its targets, else the reason.
  const targets = approval.targets.filter((target) => DETAIL_TARGET_KINDS.has(target.kind)).map((target) => target.path);
  const lines = targets.map((line) => line.trim()).filter(Boolean);
  if (lines.length || kind !== "other") return lines;
  const fallback = (card.scope?.description ?? card.reason).trim();
  return fallback ? [fallback] : [];
}

/** A step only the user can do in a tab (a sign-in step, a secure field, ...):
 * a hand-off, not a permission. The tab id never reaches the card. */
export interface BrowserHandoffView { title: string; details: string[]; signIn: boolean }

export function browserHandoffView(
  card: Pick<AuthorityApprovalCard, "approval">,
  copy: ApprovalRequestCopy,
  canOpenTab: boolean,
): BrowserHandoffView | undefined {
  const operation = card.approval?.operation;
  const where = canOpenTab ? copy.signInHandoff.inTab : copy.signInHandoff.onDesktop;
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
function accessLabel(mode: AccessMode): string {
  const p = appCopy.permissions;
  return { auto: p.auto, read_only: p.readOnly, ask_first: p.askAlways, ask_except_reads: p.askFirst, full_access: p.fullAccess }[mode];
}

function normalizeImageOperation(value: unknown): import("./types").ImageApprovalOperation | undefined {
  if (!isRecord(value) || !["action", "model", "model_ref", "size", "quality", "prompt"].every(key => typeof value[key] === "string")
    || !Array.isArray(value.images) || !value.images.every(id => typeof id === "string")) return;
  return { action: value.action as string, model: value.model as string, model_ref: value.model_ref as string,
    size: value.size as string, quality: value.quality as string, prompt: value.prompt as string, images: value.images as string[],
    ...(typeof value.mask === "string" ? { mask: value.mask } : {}) };
}
