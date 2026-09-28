import type { AppCopy } from "./copy.ts";
import type { ApprovalRisk, ApprovalSummary, AuthorityApprovalCard } from "./types.ts";

type ApprovalRequestCopy = AppCopy["interfaceTemplates"]["approvalRequest"];

/** The `approval.action_kind` values the agent sends (#277). */
export const APPROVAL_ACTION_KINDS = [
  "edit_files", "run_command", "network_command", "use_connector", "manage_schedule",
  "update_project", "start_conversation", "restart_service", "create_worktree", "other",
] as const;
export type ApprovalActionKind = (typeof APPROVAL_ACTION_KINDS)[number];

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
const RISKS: readonly string[] = ["low", "medium", "high"];
const HOME_FOLDER = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)[\\/](Desktop|Documents|Downloads)$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Narrows a request's transport `approval`. Malformed targets and examples are
 * dropped; a missing kind or an invalid count drops the whole summary, so the
 * card falls back to the legacy text.
 */
export function normalizeApprovalSummary(value: unknown): ApprovalSummary | undefined {
  if (!isRecord(value)) return undefined;
  const { action_kind: actionKind, count = 1, risk } = value;
  if (typeof actionKind !== "string" || !actionKind.trim()) return undefined;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined;
  const targets = (Array.isArray(value.targets) ? value.targets : []).flatMap((target) =>
    isRecord(target) && typeof target.kind === "string" && typeof target.path === "string"
      ? [{ kind: target.kind, path: target.path }] : []);
  const examples = (Array.isArray(value.examples) ? value.examples : [])
    .filter((example): example is string => typeof example === "string" && example.trim() !== "");
  return {
    actionKind, targets, count, examples,
    ...(typeof risk === "string" && RISKS.includes(risk) ? { risk: risk as ApprovalRisk } : {}),
  };
}

/**
 * The card for a pending request: a sentence per action kind; the generic
 * sentence for a kind this App does not know; the legacy `scope` text (then
 * the reason) from an agent that sends no `approval`.
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
  const folder = folderName(approval, copy);
  return {
    title: sentence(actionKind, approval, folder, copy),
    details: details(approval, copy),
    ...(approval.risk ? { risk: approval.risk } : {}),
    conversationScope: actionKind === "edit_files" ? copy.covers.editFiles(folder)
      : actionKind === "run_command" || actionKind === "network_command" ? copy.covers.command(folder)
        : copy.covers.other,
    actionKind,
  };
}

function sentence(kind: ApprovalActionKind, approval: ApprovalSummary, folder: string | null, copy: ApprovalRequestCopy): string {
  switch (kind) {
    case "edit_files": return copy.editFiles(approval.count, folder);
    case "run_command": return copy.runCommand(folder);
    case "network_command": return copy.networkCommand(folder);
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

/** The request's folder by name: a home folder as people know it, else its last path part. */
function folderName(approval: ApprovalSummary, copy: ApprovalRequestCopy): string | null {
  const path = approval.targets.find((target) => target.kind === "folder")?.path.trim().replace(/(?<=.)[\\/]+$/u, "");
  if (!path) return null;
  const home = HOME_FOLDER.exec(path)?.[1] as keyof ApprovalRequestCopy["homeFolders"] | undefined;
  if (home) return copy.homeFolders[home];
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? null;
}

function details(approval: ApprovalSummary, copy: ApprovalRequestCopy): string[] {
  const shown = approval.examples.slice(0, MAX_EXAMPLES);
  // Without examples there is nothing to continue: a single call is not "+1 more".
  const rest = shown.length > 0 ? approval.count - shown.length : 0;
  return rest > 0 ? [...shown, copy.more(rest)] : shown;
}
