import { beforeEach, expect, test } from "bun:test";
import { useComposerStore } from "./composerStore.ts";

beforeEach(() => {
  useComposerStore.setState({
    draftRevision: 0,
    draftSessionId: "draft:chat",
    text: "",
  });
});

test("composer store activates and restores independent session drafts", () => {
  const sessionARevision = useComposerStore
    .getState()
    .activateDraftSession("session-a", "alpha");
  expect(useComposerStore.getState().text).toBe("alpha");

  useComposerStore.getState().activateDraftSession("session-b", "beta");
  expect(useComposerStore.getState().text).toBe("beta");

  useComposerStore.getState().activateDraftSession("session-a", "alpha");
  expect(useComposerStore.getState().text).toBe("alpha");
  expect(sessionARevision).toBeGreaterThan(0);
});

test("late restore cannot overwrite typing after session activation", () => {
  const revision = useComposerStore
    .getState()
    .activateDraftSession("session-a", "local");
  useComposerStore.getState().setText("new typing");
  const restored = useComposerStore.getState().restoreDraftSession({
    revision,
    sessionId: "session-a",
    text: "stale durable value",
  });

  expect(useComposerStore.getState().text).toBe("new typing");
  expect(restored).toBe(false);
});

test("late restore for another session cannot bleed into the active draft", () => {
  const sessionARevision = useComposerStore
    .getState()
    .activateDraftSession("session-a", "alpha");
  useComposerStore.getState().activateDraftSession("session-b", "beta");
  const restored = useComposerStore.getState().restoreDraftSession({
    revision: sessionARevision,
    sessionId: "session-a",
    text: "late alpha",
  });

  expect(useComposerStore.getState().draftSessionId).toBe("session-b");
  expect(useComposerStore.getState().text).toBe("beta");
  expect(restored).toBe(false);
});
