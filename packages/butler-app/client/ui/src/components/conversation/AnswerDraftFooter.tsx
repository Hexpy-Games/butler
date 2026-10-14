import { CopyButton, MessageFooter, MessageStatusRow, Stack, Typo } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy";
import { draftStatus, useAnswerDrafts } from "@/app/answerDrafts";
import { AssistantStatusLabel } from "./AssistantStatusLabel";
import { useButlerMarkTheme } from "./hooks/useButlerMarkTheme";

/** Reserve the completed response's controls before handoff; keep live copy unavailable. */
export function AnswerDraftFooter({ turnId }: { turnId?: string }) {
  useAppLocale();
  const markTheme = useButlerMarkTheme();
  const draft = useAnswerDrafts(state => turnId ? state.answerDrafts[turnId] : undefined);
  if (!draft?.present || !draft.calls.some(call => call.raw.length)) return null;
  const label = appCopy.conversation.answerBlocks[draftStatus(draft)];
  return <>
    <MessageFooter><Stack invisible inline gap="none"><CopyButton
      copied={false} label={appCopy.conversation.messageActions.copyMessage}
      copiedLabel={appCopy.conversation.messageActions.copied} />
    </Stack></MessageFooter>
    <MessageStatusRow><AssistantStatusLabel label={label} markTheme={markTheme} state="complete">
      <Typo.Caption as="span" role="status">{label}</Typo.Caption>
    </AssistantStatusLabel></MessageStatusRow>
  </>;
}
