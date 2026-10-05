import { AdaptiveShell, AdaptiveShellSidebar, AdaptiveShellWorkspace } from "../../../../blocks/AdaptiveShell";
import { ComposerCard, ComposerCardTextarea, ComposerSendButton, ComposerCardInlineAction } from "../../../../blocks/ComposerCard";
import { ConversationScroll, ConversationShell, MessageListSurface } from "../../../../blocks/ConversationShell";
import { MarkdownContent } from "../../../../blocks/MarkdownContent";
import { MessageFooter, MessageRow, MessageStatusLabel, MessageStatusRow } from "../../../../blocks/MessageRow";
import { ButlerThinkingMark } from "../../../ButlerThinkingMark";
import { CopyButton } from "../../../CopyButton";
import { PillButton } from "../../../PillButton";
import { ButtonContainer } from "../../../ButtonContainer";
import { ScrollArea } from "../../../../blocks/ScrollArea";
import { FolderPlus, MessageSquarePlus, Plus } from "../../../Icons";
import { Typo } from "../../../Typo";
import type { LayersCopy } from "./layersCopy";
import { Sidebar } from "./LayersSidebar";

/** One finished turn as the product renders it: the user bubble with its footer, the markdown answer, its footer and the completed status. */
function Turn({ copy }: { copy: LayersCopy }) {
  return (
    <>
      <MessageRow
        role="user"
        footer={
          <MessageFooter dataTestClass="user-message-footer">
            <Typo.Text as="time" numeric="tabular">
              {copy.asked}
            </Typo.Text>
            <CopyButton copiedLabel={copy.copied} label={copy.copy} text={copy.ask} />
          </MessageFooter>
        }
      >
        {copy.ask}
      </MessageRow>
      <MessageRow role="assistant">
        <MarkdownContent>
          <p>{copy.answer}</p>
          <ul>
            {copy.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </MarkdownContent>
        <MessageFooter>
          <CopyButton copiedLabel={copy.copied} label={copy.copy} text={copy.answer} />
          <PillButton surface="glass" size="icon-lg" aria-label={copy.branchChat}>
            <MessageSquarePlus size="md" />
          </PillButton>
          <PillButton surface="glass" size="icon-lg" aria-label={copy.branchProject}>
            <FolderPlus size="md" />
          </PillButton>
          <span>{copy.worked}</span>
          <Typo.Text as="time" numeric="tabular">
            {copy.time}
          </Typo.Text>
        </MessageFooter>
        <MessageStatusRow dataTestClass="assistant-terminal-status-row">
          <MessageStatusLabel mark={<ButlerThinkingMark state="idle" />}>
            <Typo.Caption as="span">{copy.done}</Typo.Caption>
          </MessageStatusLabel>
        </MessageStatusRow>
      </MessageRow>
    </>
  );
}

/**
 * The page layer: the real shell (AdaptiveShell) with the sidebar and the
 * workspace, the conversation and the folded composer floating over it. The
 * titlebar row is left to the sticky sheet above, exactly where it sits.
 */
export function Page({ copy, compact }: { copy: LayersCopy; compact: boolean }) {
  return (
    <AdaptiveShell leftOpen={!compact} rightOpen={false}>
      <AdaptiveShellSidebar open={!compact}>
        <Sidebar copy={copy} />
      </AdaptiveShellSidebar>
      <AdaptiveShellWorkspace>
        <ConversationShell composerReserve={132}>
          <ConversationScroll masked={false} scrollable={false}>
            <MessageListSurface>
              <Turn copy={copy} />
            </MessageListSurface>
          </ConversationScroll>
          <ComposerCard floating large controls={
      <ScrollArea orientation="x" flush><ButtonContainer size="sm" wrap={false} grow>
        <PillButton surface="glass" size="icon-lg" aria-label={copy.more}>
                <Plus size="md" />
              </PillButton>
      </ButtonContainer></ScrollArea>
    }>
      <ComposerCardInlineAction action={<ComposerSendButton aria-label={copy.composer} disabled />}>
        <ComposerCardTextarea aria-label={copy.composer} placeholder={copy.composer} rows={1} />
      </ComposerCardInlineAction>

          </ComposerCard>
        </ConversationShell>
      </AdaptiveShellWorkspace>
    </AdaptiveShell>
  );
}
