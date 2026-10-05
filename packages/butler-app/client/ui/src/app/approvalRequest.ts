import type { AppCopy } from "./copy.ts";
import { approvalTargetsFromTransport, isAbsolutePath } from "./approvalTargets.ts";
import type { ApprovalRisk, ApprovalSummary, AuthorityApprovalCard } from "./types.ts";

type ApprovalRequestCopy = AppCopy["interfaceTemplates"]["approvalRequest"];

/** The `approval.action_kind` values the agent sends (#277). */
export const APPROVAL_ACTION_KINDS = [
  "edit_files", "run_command", "network_command", "use_connector", "manage_schedule",
  "update_project", "start_conversation", "restart_service", "create_worktree", "other",
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
  /** As the agent sent it; unknown or missing reads as high. */
  risk: ApprovalRisk;
  /** What "Always allow in this conversation" covers. */
  conversationScope?: string;
  /** Picks the icon; `other` for unknown kinds and agents without `approval`. */
  actionKind: ApprovalActionKind;
}

const MAX_EXAMPLES = 3;
/** Target kinds that say what a request without examples acts on. */
const DETAIL_TARGET_KINDS: ReadonlySet<string> = new Set(["connector", "schedule", "other"]);
const RISKS: readonly string[] = ["low", "medium", "high"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Narrows a request's transport `approval`. Malformed targets and examples are
 * dropped; a missing kind or an invalid count drops the whole summary, so the
 * card falls back to the legacy text. Target and example paths come out
 * relative (see `approvalTargetsFromTransport`); command lines stay as sent.
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
  return {
    actionKind, targets, count, examples,
    ...(operation ? { operation } : {}),
    ...(value.command_access === "read_only_unisolated" ? { commandAccess: value.command_access } : {}),
    ...(examplesTruncated.some(Boolean) ? { examplesTruncated } : {}),
    ...(typeof risk === "string" && RISKS.includes(risk) ? { risk: risk as ApprovalRisk } : {}),
  };
}

function normalizeOperation(value: unknown): ApprovalSummary["operation"] {
  if (!isRecord(value) || typeof value.tool !== "string" || !value.tool.trim()
    || (value.access !== "read_only" && value.access !== "change")) return undefined;
  const targets = (Array.isArray(value.targets) ? value.targets : [])
    .filter((target): target is string => typeof target === "string" && Boolean(target.trim()));
  return { tool: value.tool, access: value.access, targets,
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
  const actionKind = (APPROVAL_ACTION_KINDS as readonly string[]).includes(approval.actionKind)
    ? approval.actionKind as ApprovalActionKind : "other";
  const workspace = workspaceLabel(approval);
  const operation = approval.operation;
  return {
    title: operation ? copy.operation(toolLabels[operation.tool] ?? operation.tool.replaceAll("_", " "), operation.access === "read_only")
      : sentence(actionKind, approval, workspace, copy),
    details: operation ? [...(operation.command ? [operation.command] : []), ...operation.targets]
      : details(approval, actionKind, card, copy),
    risk: approval.risk ?? "high",
    conversationScope: approval.targets.some(target => target.kind === "outside") ? copy.covers.other : actionKind === "edit_files" ? copy.covers.editFiles(workspace)
      : COMMAND_KINDS.has(actionKind) ? copy.covers.command(workspace)
        : copy.covers.other,
    actionKind,
  };
}

function sentence(kind: ApprovalActionKind, approval: ApprovalSummary, workspace: string | null, copy: ApprovalRequestCopy): string {
  const outside = approval.targets.some(target => target.kind === "outside");
  switch (kind) {
    case "edit_files": return outside ? copy.editFilesOutside(approval.count) : copy.editFiles(approval.count, workspace);
    case "run_command": return outside ? copy.runCommandOutside : copy.runCommand(workspace);
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
    case "other": return copy.generic;
  }
}

/** The workspace's label: the folder's first, else another target's; `null` reads as "this workspace". */
function workspaceLabel(approval: ApprovalSummary): string | null {
  const label = (approval.targets.find((target) => target.kind === "folder" && target.label?.trim())
    ?? approval.targets.find((target) => target.label?.trim()))?.label?.trim();
  return label || null;
}

/** `automation:create|delete|due:<id>` (the agent's schedule target): the operation and the schedule. */
function scheduleOperation(approval: ApprovalSummary): { operation: "create" | "delete" | "run" | "change"; id: string } {
  const path = approval.targets.find((target) => target.kind === "schedule")?.path ?? "";
  const [, operation = "", ...rest] = path.split(":");
  const id = rest.join(":");
  if (operation === "create") return { operation: "create", id };
  if (operation === "delete") return { operation: "delete", id };
  if (operation === "due") return { operation: "run", id: "" };
  return { operation: "change", id: path };
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
  if (shown.length) {
    const rest = approval.count - shown.length;
    return rest > 0 ? [...notice, ...shown, copy.more(rest)] : [...notice, ...shown];
  }
  // Without examples, say what the request acts on: its targets, else the reason.
  const targets = kind === "manage_schedule"
    ? [scheduleOperation(approval).id]
    : approval.targets.filter((target) => DETAIL_TARGET_KINDS.has(target.kind)).map((target) => target.path);
  const lines = targets.map((line) => line.trim()).filter(Boolean);
  if (lines.length || kind !== "other") return lines;
  const fallback = (card.scope?.description ?? card.reason).trim();
  return fallback ? [fallback] : [];
}
