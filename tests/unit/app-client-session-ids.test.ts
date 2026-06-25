import { expect, test } from "bun:test";
import { isServerBackedSessionId } from "../../packages/butler-app/client/ui/src/app/sessionIds.ts";
import { optimisticSessionId } from "../../packages/butler-app/client/ui/src/app/optimisticSession.ts";
import { projectDraftId } from "../../packages/butler-app/client/ui/src/app/utils.ts";

test("server-backed session ids exclude draft and optimistic local ids", () => {
  expect(isServerBackedSessionId("session-real")).toBe(true);
  expect(isServerBackedSessionId("draft:chat")).toBe(false);
  expect(isServerBackedSessionId(projectDraftId("project-1"))).toBe(false);
  expect(isServerBackedSessionId(optimisticSessionId("client-message-1"))).toBe(
    false,
  );
});
