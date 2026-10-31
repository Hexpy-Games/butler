import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { isAbsolutePath } from "@/app/approvalTargets.ts";
import type { ApprovalActionKind } from "@/app/approvalRequest.ts";
import { visibleText } from "@/app/visibleText.ts";
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
  restart_service: RefreshCcw, create_worktree: GitBranch, switch_folder: Folder, other: ShieldCheck,
};
const RISK_TONES: Record<ApprovalRisk, TagTone> = { low: "neutral", medium: "warning", high: "danger" };

/**
 * Display only. A detail line is the exact action: never shortened, only made unambiguous. Hidden and
 * reflowing characters show as escapes, each line is its own left-to-right isolate, and runs of spaces
 * keep their width. A long path in the title is cut in the middle; its full text stays in the title attribute.
 */
function approvalText(text: string, decision: ComposerAuthorityDecision) {
  const shorten = (path: string) => isAbsolutePath(path) && path.length > 64
    ? `${path.slice(0, 30)}…${path.slice(-25)}` : path;
  const isTitle = text === decision.title;
  const escaped = visibleText(isTitle ? text.replace(/'([^']+)'/gu, (_, path: string) => `'${shorten(path)}'`) : text);
  // A run of spaces collapses under normal wrapping; a no-break space keeps each one's width (a real one is escaped above).
  const shown = escaped.replace(/ (?= )|^ | $/gu, "\u00A0");
  return <bdi dir="ltr" {...(escaped === text ? {} : isTitle ? { title: text, "aria-label": text } : {})}>{shown}</bdi>;
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
    renderText={(text) => approvalText(text, decision)}
    // No clamp: a long card scrolls in the details area, so Allow never sits over hidden text.
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
