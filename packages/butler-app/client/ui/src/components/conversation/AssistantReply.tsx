import { appCopy, useAppLocale } from "@/app/copy";
import { Typo } from "@/butler-ds";
import { GeneratedImages } from "../images/GeneratedImages";
import type { MessageRecord } from "@/app/types";
import type { RefreshFileUrls } from "@/hooks/useMessageFileSource";
import { MessageMarkdown } from "./MessageMarkdown";
import { AnswerBlocks } from "./AnswerBlocks";

/** Text and structured answers keep the same order in every assistant body. */
export function AssistantReply({ message, refreshFileUrls }: { message: MessageRecord; refreshFileUrls: RefreshFileUrls }) {
  return <>
    <AssistantReplyText message={message} refreshFileUrls={refreshFileUrls} />
    <GeneratedImages message={message} />
    <AnswerBlocks sets={message.answer_blocks} messageId={message.id} replyText={message.text} sessionId={message.chat_id} turnId={message.turn_id} />
  </>;
}

export function AssistantReplyText({ message, refreshFileUrls }: { message: MessageRecord; refreshFileUrls: RefreshFileUrls }) {
  useAppLocale();
  if (message.initiated?.kind === "work_failed") return <Typo.Body wrap="anywhere" data-test-class="initiated-work-failed">
    {appCopy.conversation.initiated.workFailed(message.initiated.state, message.initiated.reason_code)}
  </Typo.Body>;
  return <MessageMarkdown artifacts={message.artifacts} attachments={message.attachments}
    refreshFileUrls={refreshFileUrls} streaming={message.status === "streaming"} text={message.text} />;
}
