import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearTurnContextAtom,
  createTurnContextAtomId,
  persistTurnContextAtom,
  readTurnContextAtom,
} from "../../packages/butler-agent/src/agent/turn/turn-continuation-context.ts";
import { isTerminalTurnState } from "../../packages/butler-agent/src/agent/turn/turn-kernel.ts";

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "butler-turn-kernel-context-"));
}

test("turn context atom persists, reads, and clears", () => {
  const butlerData = tempWorkspace();
  try {
    const sessionId = "butler/main/context-read";
    const turnId = "turn-context-read";
    persistTurnContextAtom({
      butlerData,
      sessionId,
      turnId,
      state: "continuing",
      sourceErrorCode: "prompt_usage_model_call_budget_exhausted",
      reason: "internal scheduler rollover",
      unresolvedObservations: [{ kind: "tool_result", id: "obs-1" }],
    });
    const persistedPath = join(
      butlerData,
      "state",
      "turn-kernel",
      createTurnContextAtomId(sessionId, turnId),
    );
    expect(existsSync(persistedPath)).toBe(true);
    const persisted = readTurnContextAtom({ butlerData, sessionId, turnId });
    expect(persisted).not.toBeNull();
    expect(persisted).toMatchObject({
      sessionId,
      turnId,
      state: "continuing",
      sourceErrorCode: "prompt_usage_model_call_budget_exhausted",
      reason: "internal scheduler rollover",
      unresolvedObservations: [{ kind: "tool_result", id: "obs-1" }],
    });
    clearTurnContextAtom({ butlerData, sessionId, turnId });
    expect(readTurnContextAtom({ butlerData, sessionId, turnId })).toBeNull();
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("turn context atom is not persisted for terminal states", () => {
  const butlerData = tempWorkspace();
  try {
    const sessionId = "butler/main/context-terminal";
    const turnId = "turn-context-terminal";
    persistTurnContextAtom({
      butlerData,
      sessionId,
      turnId,
      state: "completed",
      sourceErrorCode: "noop",
      reason: "completed already",
    });
    const persistedPath = join(
      butlerData,
      "state",
      "turn-kernel",
      createTurnContextAtomId(sessionId, turnId),
    );
    expect(existsSync(persistedPath)).toBe(false);
    expect(readTurnContextAtom({ butlerData, sessionId, turnId })).toBeNull();
    expect(isTerminalTurnState("completed")).toBe(true);
    expect(isTerminalTurnState("waiting_user")).toBe(true);
    expect(isTerminalTurnState("failed")).toBe(true);
    expect(isTerminalTurnState("runtime_fault")).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
