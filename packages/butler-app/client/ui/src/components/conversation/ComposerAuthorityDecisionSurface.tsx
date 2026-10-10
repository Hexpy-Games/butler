import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { ApprovalActionKind } from "@/app/approvalRequest.ts";
import type { ApprovalRisk } from "@/app/types.ts";
import {
  Button, ButtonContainer, Clock3, ComposerDecisionPanel, Folder, GitBranch, Globe2, ListChecks, McpServer,
  MessageSquarePlus, RefreshCcw, ShieldCheck, SplitButton, Tag, Terminal, Typo, type TagTone,
} from "@/butler-ds";
import type { ComposerAuthorityDecision } from "./useComposerAuthorityDecision";
import { ComposerBrowserHandoffSurface } from "./ComposerBrowserHandoffSurface";

/** What the request touches, at a glance: a folder for file edits (as in the README demo), a terminal for commands. */
const KIND_ICONS: Record<ApprovalActionKind, typeof ShieldCheck> = {
  edit_files: Folder, run_command: Terminal, network_command: Globe2, use_connector: McpServer,
  manage_schedule: Clock3, update_project: ListChecks, start_conversation: MessageSquarePlus,
  restart_service: RefreshCcw, create_worktree: GitBranch, other: ShieldCheck,
};
const RISK_TONES: Record<ApprovalRisk, TagTone> = { low: "neutral", medium: "warning", high: "danger" };

export function ComposerAuthorityDecisionSurface({ decision }: { decision: ComposerAuthorityDecision }) {
  useAppLocale();
  const { handoff } = decision;
  if (handoff) return <ComposerBrowserHandoffSurface decision={{ ...decision, handoff }} />;
  const Icon = KIND_ICONS[decision.actionKind];
  return <ComposerDecisionPanel
    icon={<Icon aria-hidden="true" size="lg" />}
    eyebrow={appCopy.composer.permission}
    title={decision.title}
    details={decision.details}
    detailsShowMoreLabel={appCopy.conversation.messageActions.showMore}
    detailsShowLessLabel={appCopy.conversation.messageActions.showLess}
    onOpen={decision.onOpenSource}
    error={decision.error}
    aside={<>
      <Tag tone={RISK_TONES[decision.risk] ?? "danger"} data-test-class="approval-risk">
        {appCopy.interfaceTemplates.approvalRequest.risk[decision.risk]}
      </Tag>
      {decision.pendingCount > 1 ? <Typo.Caption>+{decision.pendingCount - 1}</Typo.Caption> : null}
    </>}
    data-test-class="composer-authority-decision"
    actions={(complete) => <ButtonContainer size="sm" justify="end">
      <Button type="button" size="sm" variant="secondary" disabled={decision.pending} onClick={() => complete(decision.onDeny)}>{appCopy.interfaceDetails.deny}</Button>
      <SplitButton size="sm" text={appCopy.interfaceDetails.allowOnce} disabled={decision.pending} onClick={() => complete(decision.onAllow)}
        menuLabel={appCopy.interfaceDetails.allowScope} menuSide="top"
        items={[{
          key: "conversation", label: appCopy.interfaceDetails.allowConversation, disabled: !decision.scope,
          description: [decision.conversationScope, appCopy.interfaceDetails.allowDescription], onSelect: () => complete(decision.onAllowConversation),
        }]} />
    </ButtonContainer>}
  />;
}
