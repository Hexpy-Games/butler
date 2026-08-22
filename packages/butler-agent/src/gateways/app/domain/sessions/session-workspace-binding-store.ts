import type { SessionBindingStore } from
  "../../../../test-support/harness/session-store.ts";

export type AppSessionWorkspaceBindingStore = Pick<
  SessionBindingStore,
  "getBySessionId" | "upsert" | "rebindWorkspace" | "deleteSession" | "close"
>;
