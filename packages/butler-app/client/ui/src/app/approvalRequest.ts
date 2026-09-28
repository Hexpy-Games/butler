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
  /** Up to three examples, then a "+N more" line. */
  details: string[];
  risk?: ApprovalRisk;
  /** What "Always allow in this conversation" covers. */
  conversationScope?: string;
  /** Picks the icon; `other` for unknown kinds and agents without `approval`. */
  actionKind: ApprovalActionKind;
}

const MAX_EXAMPLES = 3;
/** Longer example paths are cut in the middle, keeping the file name. */
const MAX_PATH_CHARS = 44;
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
  const examples = (Array.isArray(value.examples) ? value.examples : [])
    .filter((example): example is string => typeof example === "string" && example.trim() !== "")
    .map((example) => COMMAND_KINDS.has(actionKind) || !isAbsolutePath(example) ? example : relative(example))
    .filter(Boolean);
  return {
    actionKind, targets, count, examples,
    ...(typeof risk === "string" && RISKS.includes(risk) ? { risk: risk as ApprovalRisk } : {}),
  };
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
): ApprovalRequestView {
  const { approval, scope } = card;
  if (!approval) {
    return {
      title: scope ? `${scope.title} · ${scope.description}` : card.reason,
      details: [],
      actionKind: "other",
      ...(scope ? { conversationScope: scope.description } : {}),
    };
  }
  const actionKind = (APPROVAL_ACTION_KINDS as readonly string[]).includes(approval.actionKind)
    ? approval.actionKind as ApprovalActionKind : "other";
  const workspace = workspaceLabel(approval);
  return {
    title: sentence(actionKind, approval, workspace, copy),
    details: details(approval, copy),
    ...(approval.risk ? { risk: approval.risk } : {}),
    conversationScope: actionKind === "edit_files" ? copy.covers.editFiles(workspace)
      : COMMAND_KINDS.has(actionKind) ? copy.covers.command(workspace)
        : copy.covers.other,
    actionKind,
  };
}

function sentence(kind: ApprovalActionKind, approval: ApprovalSummary, workspace: string | null, copy: ApprovalRequestCopy): string {
  switch (kind) {
    case "edit_files": return copy.editFiles(approval.count, workspace);
    case "run_command": return copy.runCommand(workspace);
    case "network_command": return copy.networkCommand(workspace);
    case "use_connector": {
      const path = approval.targets.find((target) => target.kind === "connector")?.path.trim() ?? "";
      const slash = path.indexOf("/");
      return slash > 0 ? copy.useConnector(path.slice(slash + 1) || null, path.slice(0, slash))
        : copy.useConnector(path || null, null);
    }
    case "manage_schedule": return copy.manageSchedule;
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

function details(approval: ApprovalSummary, copy: ApprovalRequestCopy): string[] {
  const command = COMMAND_KINDS.has(approval.actionKind);
  const shown = approval.examples.slice(0, MAX_EXAMPLES).map((example) => command ? example : truncateMiddle(example));
  // Without examples there is nothing to continue: a single call is not "+1 more".
  const rest = shown.length > 0 ? approval.count - shown.length : 0;
  return rest > 0 ? [...shown, copy.more(rest)] : shown;
}

/** Cuts a long path in the middle, at a folder boundary when it can, and keeps the file name whole when it fits. */
export function truncateMiddle(path: string, max = MAX_PATH_CHARS): string {
  if (path.length <= max) return path;
  const name = path.slice(path.search(/[^\\/]*$/u));
  if (name.length + 4 > max) {
    const keep = max - 1;
    return `${path.slice(0, Math.ceil(keep / 2))}…${path.slice(path.length - Math.floor(keep / 2))}`;
  }
  const head = path.slice(0, max - name.length - 3);
  const cut = Math.max(head.lastIndexOf("/"), head.lastIndexOf("\\"));
  return cut > 0 ? `${head.slice(0, cut)}/…/${name}` : `${path.slice(0, max - name.length - 2)}…/${name}`;
}
