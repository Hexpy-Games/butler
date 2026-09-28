import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { ApprovalActionKind } from "@/app/approvalRequest.ts";
import type { ApprovalRisk } from "@/app/types.ts";
import {
  Button, ButtonContainer, ChevronDown, Clock3, ComposerDecisionPanel, Folder, GitBranch, Globe2, ListChecks, McpServer,
  MessageSquarePlus, RefreshCcw, ShieldCheck, SplitButton, Tag, Terminal, Typo, type TagTone,
} from "@/butler-ds";
import type { ComposerAuthorityDecision } from "./useComposerAuthorityDecision";

/** What the request touches, at a glance: a folder for file edits (as in the README demo), a terminal for commands. */
const KIND_ICONS: Record<ApprovalActionKind, typeof ShieldCheck> = {
  edit_files: Folder, run_command: Terminal, network_command: Globe2, use_connector: McpServer,
  manage_schedule: Clock3, update_project: ListChecks, start_conversation: MessageSquarePlus,
  restart_service: RefreshCcw, create_worktree: GitBranch, other: ShieldCheck,
};
const RISK_TONES: Record<ApprovalRisk, TagTone> = { low: "neutral", medium: "warning", high: "danger" };

export function ComposerAuthorityDecisionSurface({ decision }: { decision: ComposerAuthorityDecision }) {
  useAppLocale();
  const Icon = KIND_ICONS[decision.actionKind];
  return <ComposerDecisionPanel
    icon={<Icon aria-hidden="true" size="lg" />}
    title={decision.title}
    details={decision.details}
    onOpen={decision.onOpenSource}
    error={decision.error}
    aside={<>
      {decision.risk ? <Tag tone={RISK_TONES[decision.risk]} data-test-class="approval-risk">
        {appCopy.interfaceTemplates.approvalRequest.risk[decision.risk]}
      </Tag> : null}
      {decision.pendingCount > 1 ? <Typo.Caption>+{decision.pendingCount - 1}</Typo.Caption> : null}
      <Button type="button" size="sm" variant="borderless" aria-label={appCopy.interfaceDetails.composeLater} title={appCopy.interfaceDetails.composeLater} onClick={decision.onComposeMessage}>
        <ChevronDown aria-hidden="true" size="md" />
      </Button>
    </>}
    data-test-class="composer-authority-decision"
    actions={<ButtonContainer size="sm" justify="end">
      <Button type="button" size="sm" variant="secondary" disabled={decision.pending} onClick={decision.onDeny}>{appCopy.interfaceDetails.deny}</Button>
      <SplitButton size="sm" text={appCopy.interfaceDetails.allowOnce} disabled={decision.pending} onClick={decision.onAllow}
        menuLabel={appCopy.interfaceDetails.allowScope} menuSide="top"
        items={[{
          key: "conversation", label: appCopy.interfaceDetails.allowConversation, disabled: !decision.scope,
          description: [decision.conversationScope, appCopy.interfaceDetails.allowDescription], onSelect: decision.onAllowConversation,
        }]} />
    </ButtonContainer>}
  />;
}
