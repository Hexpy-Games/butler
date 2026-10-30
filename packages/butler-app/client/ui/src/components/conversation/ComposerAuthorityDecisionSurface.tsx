import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { isAbsolutePath } from "@/app/approvalTargets.ts";
import type { ApprovalActionKind } from "@/app/approvalRequest.ts";
import type { ApprovalRisk } from "@/app/types.ts";
import {
  ImageIcon, Pencil, Button, ButtonContainer, Clock3, ComposerDecisionPanel, Folder, GitBranch, Globe2, ListChecks, McpServer,
  MessageSquarePlus, RefreshCcw, ShieldCheck, SplitButton, Tag, Terminal, Typo, type TagTone,
} from "@/butler-ds";
import type { ComposerAuthorityDecision } from "./useComposerAuthorityDecision";
import { ComposerBrowserHandoffSurface } from "./ComposerBrowserHandoffSurface";

/** What the request touches, at a glance: a folder for file edits (as in the README demo), a terminal for commands. */
const KIND_ICONS: Record<ApprovalActionKind, typeof ShieldCheck> = {
  generate_image: ImageIcon, edit_image: Pencil, edit_files: Folder, run_command: Terminal, network_command: Globe2, web_request: Globe2, use_connector: McpServer,
  manage_schedule: Clock3, update_project: ListChecks, start_conversation: MessageSquarePlus,
  restart_service: RefreshCcw, create_worktree: GitBranch, switch_folder: Folder, project_hooks: Terminal, other: ShieldCheck,
};
const RISK_TONES: Record<ApprovalRisk, TagTone> = { low: "neutral", medium: "warning", high: "danger" };

/** Display only: retain the original path in the DS title and accessible label. */
function approvalPathText(text: string, decision: ComposerAuthorityDecision) {
  const shorten = (path: string) => isAbsolutePath(path) && path.length > 64
    ? `${path.slice(0, 30)}…${path.slice(-25)}` : path;
  const display = decision.pathDetails?.includes(text) ? shorten(text)
    : text === decision.title ? text.replace(/'([^']+)'/gu, (_, path: string) => `'${shorten(path)}'`) : text;
  return display === text ? text : <span title={text} aria-label={text}>{display}</span>;
}

export function ComposerAuthorityDecisionSurface({ decision, placement }: { placement?: "composer" | "conversation"; decision: ComposerAuthorityDecision }) {
  useAppLocale();
  const { handoff } = decision;
  if (handoff) return <ComposerBrowserHandoffSurface placement={placement} decision={{ ...decision, handoff }} />;
  const Icon = KIND_ICONS[decision.actionKind];
  return <ComposerDecisionPanel
    placement={placement}
    media={decision.media}
    icon={<Icon aria-hidden="true" size="lg" />}
    eyebrow={appCopy.composer.permission}
    title={decision.title}
    details={decision.details}
    renderText={(text) => approvalPathText(text, decision)}
    detailsShowMoreLabel={decision.actionKind === "manage_schedule" || decision.actionKind === "generate_image" || decision.actionKind === "edit_image" ? undefined : appCopy.conversation.messageActions.showMore}
    detailsShowLessLabel={decision.actionKind === "manage_schedule" || decision.actionKind === "generate_image" || decision.actionKind === "edit_image" ? undefined : appCopy.conversation.messageActions.showLess}
    onOpen={decision.onOpenSource}
    error={decision.error}
    aside={<>
      <Tag tone={RISK_TONES[decision.risk] ?? "danger"} data-test-class="approval-risk">
        {appCopy.interfaceTemplates.approvalRequest.risk[decision.risk]}
      </Tag>
      {decision.pendingCount > 1 ? <Typo.Caption>+{decision.pendingCount - 1}</Typo.Caption> : null}
    </>}
    data-test-class="composer-authority-decision"
    actions={(complete) => decision.actionKind === "project_hooks" ? <ButtonContainer size="sm" justify="end">
      <Button type="button" size="sm" variant="secondary" disabled={decision.pending} onClick={() => complete(decision.onDeny)}>{appCopy.interfaceTemplates.approvalRequest.projectHooks.deny}</Button>
      <Button type="button" size="sm" disabled={decision.pending} onClick={() => complete(decision.onAllow)}>{appCopy.interfaceTemplates.approvalRequest.projectHooks.allow}</Button>
    </ButtonContainer> : <ButtonContainer size="sm" justify="end">
      <Button type="button" size="sm" variant="secondary" disabled={decision.pending} onClick={() => complete(decision.onDeny)}>{appCopy.interfaceDetails.deny}</Button>
      <SplitButton size="sm" text={decision.allowSite ? appCopy.interfaceDetails.allowInChat : appCopy.interfaceDetails.allowOnce} disabled={decision.pending} onClick={() => complete(decision.onAllow)}
        menuLabel={appCopy.interfaceDetails.allowScope} menuSide="top"
        items={decision.allowSite ? [{
          key: "site", label: decision.allowSite === "payment" ? appCopy.interfaceDetails.allowPaymentSite : appCopy.interfaceDetails.allowSite,
          description: decision.allowSite === "signed_in" ? appCopy.interfaceDetails.allowSiteDescription : undefined,
          onSelect: () => complete(decision.onAllowSite ?? decision.onAllow),
        }] : [{
          key: "conversation", label: appCopy.interfaceDetails.allowConversation, disabled: !decision.scope,
          description: [decision.conversationScope, appCopy.interfaceDetails.allowDescription], onSelect: () => complete(decision.onAllowConversation),
        }]} />
    </ButtonContainer>}
  />;
}
