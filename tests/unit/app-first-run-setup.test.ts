import { expect, test } from "bun:test";
import {
  createInitialFirstRunState,
  detectFirstRunLanguage,
  FIRST_RUN_STORAGE_KEY,
  nextFirstRunState,
  parseFirstRunState,
  readFirstRunState,
  writeFirstRunState,
  type FirstRunState,
} from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("first-run language detection preselects Korean from system languages", () => {
  expect(detectFirstRunLanguage(["ko-KR", "en-US"])).toBe("ko");
  expect(detectFirstRunLanguage(["en-US"])).toBe("en");
});

test("first-run state machine enforces language safety install model order", () => {
  let state = createInitialFirstRunState("ko");
  state = nextFirstRunState(state, { type: "install_ready" });
  expect(state.step).toBe("language");

  state = nextFirstRunState(state, { type: "continue_language" });
  expect(state.step).toBe("safety");
  state = nextFirstRunState(state, { type: "open_model_setup" });
  expect(state.status).toBe("pending");
  expect(state.step).toBe("safety");

  state = nextFirstRunState(state, { type: "accept_safety" });
  expect(state.step).toBe("install");
  state = nextFirstRunState(state, {
    type: "install_ready",
    connection_mode: "existing-agent",
  });
  expect(state.step).toBe("model");
  state = nextFirstRunState(state, { type: "defer_model_setup" });
  expect(state.status).toBe("complete");
  expect(state.connection_mode).toBe("existing-agent");
});

test("first-run install failure can retry without completing setup", () => {
  let state = createInitialFirstRunState("en");
  state = nextFirstRunState(state, { type: "continue_language" });
  state = nextFirstRunState(state, { type: "accept_safety" });
  state = nextFirstRunState(state, { type: "begin_install" });
  expect(state.install_status).toBe("checking");

  state = nextFirstRunState(state, {
    type: "install_failed",
    error: "health failed",
  });
  expect(state).toMatchObject({
    status: "pending",
    step: "install",
    install_status: "failed",
    error_message: "health failed",
  });

  state = nextFirstRunState(state, { type: "retry_install" });
  expect(state).toMatchObject({
    status: "pending",
    step: "install",
    install_status: "checking",
  });
  expect(state.error_message).toBeUndefined();
});

test("first-run setup cancellation and resume never skip language", () => {
  const cancelled = nextFirstRunState(createInitialFirstRunState("ko"), {
    type: "cancel_setup",
  });
  expect(cancelled).toMatchObject({
    status: "pending",
    step: "language",
    install_status: "cancelled",
  });

  const resumed = parseFirstRunState({
    schema: "butler.app.first-run.v1",
    status: "pending",
    language: "ko",
    step: "install",
    language_confirmed: true,
    safety_accepted: true,
    install_status: "checking",
  }) as FirstRunState;
  expect(resumed.step).toBe("install");
  expect(resumed.install_status).toBe("idle");

  const corrupted = parseFirstRunState({
    schema: "butler.app.first-run.v1",
    status: "pending",
    language: "ko",
    step: "model",
    install_status: "ready",
  }) as FirstRunState;
  expect(corrupted.step).toBe("language");
  expect(corrupted.language_confirmed).toBe(false);

  const notReadyForModel = parseFirstRunState({
    schema: "butler.app.first-run.v1",
    status: "pending",
    language: "ko",
    step: "model",
    language_confirmed: true,
    safety_accepted: true,
    install_status: "failed",
  }) as FirstRunState;
  expect(notReadyForModel.step).toBe("install");
  expect(notReadyForModel.install_status).toBe("failed");

  const invalidLanguage = parseFirstRunState({
    schema: "butler.app.first-run.v1",
    status: "pending",
    language: "ja",
    step: "safety",
    language_confirmed: true,
  }) as FirstRunState;
  expect(invalidLanguage.step).toBe("language");
  expect(invalidLanguage.language).toBe("en");
  expect(invalidLanguage.language_confirmed).toBe(false);
});

test("first-run complete state requires prerequisite proof fields", () => {
  const corruptComplete = parseFirstRunState({
    schema: "butler.app.first-run.v1",
    status: "complete",
    language: "ko",
    step: "model",
  }) as FirstRunState;
  expect(corruptComplete).toMatchObject({
    status: "pending",
    language: "ko",
    step: "language",
  });

  const complete = parseFirstRunState({
    schema: "butler.app.first-run.v1",
    status: "complete",
    language: "ko",
    step: "model",
    language_confirmed: true,
    safety_accepted: true,
    install_status: "ready",
    completed_at: "2026-06-12T00:00:00.000Z",
  }) as FirstRunState;
  expect(complete).toMatchObject({
    status: "complete",
    language: "ko",
    step: "model",
    install_status: "ready",
  });
});

test("first-run state persists and falls back cleanly", () => {
  const storage = new MemoryStorage();
  const state = nextFirstRunState(createInitialFirstRunState("ko"), {
    type: "continue_language",
  });
  writeFirstRunState(storage, state);
  expect(storage.getItem(FIRST_RUN_STORAGE_KEY)).toContain('"step":"safety"');
  expect(readFirstRunState(storage, ["en-US"])).toMatchObject({
    language: "ko",
    step: "safety",
  });

  const empty = new MemoryStorage();
  expect(readFirstRunState(empty, ["ko-KR"])).toMatchObject({
    language: "ko",
    step: "language",
  });
});
