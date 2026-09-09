import { afterEach, expect, test } from "bun:test";
import { prepareDashboardSend, useProjectDashboardState } from "../../packages/butler-app/client/ui/src/app/projectDashboardState.ts";

afterEach(() => useProjectDashboardState.setState({ projects: {} }));

test("dashboard questions start new sessions; only the same failed send reuses its created session and identity", () => {
  const first = prepareDashboardSend("project-a", "question-and-controls");
  expect(first.sessionId).toBeUndefined();
  useProjectDashboardState.getState().update("project-a", { pendingSend: { ...first, sessionId: "created-session" } });
  const retry = prepareDashboardSend("project-a", "question-and-controls");
  expect(retry.sessionId).toBe("created-session");
  expect(retry.clientMessageId).toBe(first.clientMessageId);
  const changed = prepareDashboardSend("project-a", "changed-question-or-controls");
  expect(changed.sessionId).toBeUndefined();
  expect(changed.clientMessageId).not.toBe(first.clientMessageId);
  useProjectDashboardState.getState().update("project-a", { pendingSend: undefined });
  const acceptedThenRepeated = prepareDashboardSend("project-a", "changed-question-or-controls");
  expect(acceptedThenRepeated.sessionId).toBeUndefined();
  expect(acceptedThenRepeated.clientMessageId).not.toBe(changed.clientMessageId);
  expect(prepareDashboardSend("project-b", "changed-question-or-controls").clientMessageId).not.toBe(acceptedThenRepeated.clientMessageId);
});
