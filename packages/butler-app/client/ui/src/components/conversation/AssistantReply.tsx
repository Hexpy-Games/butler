import type { MessageRecord } from "@/app/types";
import type { RefreshFileUrls } from "@/hooks/useMessageFileSource";
import { MessageMarkdown } from "./MessageMarkdown";
import { AnswerBlocks } from "./AnswerBlocks";

/** Text and structured answers keep the same order in every assistant body. */
export function AssistantReply({ message, refreshFileUrls }: { message: MessageRecord; refreshFileUrls: RefreshFileUrls }) {
  return <>
    <MessageMarkdown artifacts={message.artifacts} attachments={message.attachments}
      refreshFileUrls={refreshFileUrls} streaming={message.status === "streaming"} text={message.text} />
    <AnswerBlocks sets={message.answer_blocks} messageId={message.id} replyText={message.text} sessionId={message.chat_id} turnId={message.turn_id} />
  </>;
}
