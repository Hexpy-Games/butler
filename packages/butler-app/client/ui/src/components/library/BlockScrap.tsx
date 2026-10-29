import { AnswerBlocks } from "../conversation/AnswerBlocks";
import type { LibraryItem } from "../browser/libraryStore";

/** The frozen spec uses the answer renderer at the available drawer width. */
export function BlockScrap({ item, preview }: { item: LibraryItem; preview?: boolean }) {
  if (!item.block) return null;
  return <AnswerBlocks sets={[{ call_id: item.id, set_ids: [], spec: item.block }]} sessionId={item.origin?.session}
    messageId={item.origin?.message} replyText={item.title} saved preview={preview} />;
}
