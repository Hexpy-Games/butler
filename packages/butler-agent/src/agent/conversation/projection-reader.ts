import type { ConversationProjectionReader } from "./types.ts";
import { createLazyConversationProjectionReader } from "./projection-reader-store.ts";

export interface ManagedConversationProjectionReader {
  reader: ConversationProjectionReader;
  close(): void;
}

export function createConversationProjectionReader(input: {
  butlerData: string;
}): ManagedConversationProjectionReader {
  const store = createLazyConversationProjectionReader({ butlerData: input.butlerData });
  return {
    reader: store,
    close() {
      store.close();
    },
  };
}
