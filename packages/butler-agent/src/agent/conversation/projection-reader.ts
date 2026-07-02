import { AgentConversationStore } from "./store.ts";
import type { ConversationProjectionReader } from "./types.ts";

export interface ManagedConversationProjectionReader {
  reader: ConversationProjectionReader;
  close(): void;
}

export function createConversationProjectionReader(input: {
  butlerData: string;
}): ManagedConversationProjectionReader {
  const store = new AgentConversationStore({ butlerData: input.butlerData });
  return {
    reader: store,
    close() {
      store.close();
    },
  };
}
