import { expect, test } from "bun:test";
import {
  continuationResultRefLimit,
  createTurnContinuationBudgetState,
  parseTurnContinuationBudgetState,
  terminalReceiptFromState,
  transitionTurnContinuationBudget,
  TurnContinuationBudgetExhaustedError,
} from "../../packages/butler-agent/src/agent/btcc/turn/continuation-budget.ts";

const limits = {
  maxModelRequests: 2,
  maxToolRounds: 2,
  maxPromptTokens: 20,
  maxOutputTokens: 10,
  maxElapsedMs: 1_000,
  maxIdleMs: 500,
};

test("Turn continuation budget has the exact v1 fields and validates finite positive limits", () => {
  const state = createTurnContinuationBudgetState({
    turnId: "turn-budget",
    limits,
    nowMs: 100,
  });
  expect(state).toEqual({
    schemaVersion: "butler.turn-continuation-budget.v1",
    turnId: "turn-budget",
    consumedModelRequests: 0,
    consumedToolRounds: 0,
    consumedPromptTokens: 0,
    consumedOutputTokens: 0,
    startedAtMs: 100,
    lastProgressAtMs: 100,
    seenDurableResultRefs: [],
    limits,
    terminal: { status: "active", reason: null, exhaustedAtMs: null },
  });
  expect(parseTurnContinuationBudgetState(state, "turn-budget")).toEqual(state);
  expect(() => createTurnContinuationBudgetState({
    turnId: "turn-budget",
    limits: { ...limits, maxModelRequests: 0 },
    nowMs: 100,
  })).toThrow("maxModelRequests");
  expect(() => parseTurnContinuationBudgetState({
    ...state,
    consumedToolRounds: Number.POSITIVE_INFINITY,
  }, "turn-budget")).toThrow("consumedToolRounds");
  expect(() => parseTurnContinuationBudgetState({
    ...state,
    consumedPromptTokens: limits.maxPromptTokens + 1,
  }, "turn-budget")).toThrow("counters exceed their admitted limits");
  expect(() => parseTurnContinuationBudgetState({ ...state, extra: true }, "turn-budget"))
    .toThrow("exact fields");
  expect(() => parseTurnContinuationBudgetState({
    ...state,
    terminal: {
      status: "exhausted",
      reason: "max_model_requests",
      exhaustedAtMs: null,
    },
  }, "turn-budget")).toThrow("terminal null contract");
  expect(() => parseTurnContinuationBudgetState({
    ...state,
    terminal: { status: "exhausted", reason: null, exhaustedAtMs: 200 },
  }, "turn-budget")).toThrow("terminal null contract");
});

test("Turn continuation counters and refs are monotonic and ceilings exhaust before another dispatch", () => {
  let state = createTurnContinuationBudgetState({
    turnId: "turn-budget",
    limits,
    nowMs: 100,
  });
  state = transitionTurnContinuationBudget(state, { kind: "model_dispatch" }, 110);
  state = transitionTurnContinuationBudget(state, { kind: "tool_round" }, 120);
  state = transitionTurnContinuationBudget(state, {
    kind: "token_usage",
    promptTokens: 7,
    outputTokens: 3,
  }, 130);
  state = transitionTurnContinuationBudget(state, {
    kind: "durable_result_refs",
    refs: [`guided-result-${"a".repeat(64)}`, `guided-result-${"a".repeat(64)}`],
  }, 140);
  expect(state).toMatchObject({
    consumedModelRequests: 1,
    consumedToolRounds: 1,
    consumedPromptTokens: 7,
    consumedOutputTokens: 3,
    lastProgressAtMs: 140,
    seenDurableResultRefs: [`guided-result-${"a".repeat(64)}`],
    limits,
  });

  state = transitionTurnContinuationBudget(state, { kind: "model_dispatch" }, 150);
  expect(() => transitionTurnContinuationBudget(
    state,
    { kind: "model_dispatch" },
    160,
  )).toThrow(TurnContinuationBudgetExhaustedError);
  try {
    transitionTurnContinuationBudget(state, { kind: "model_dispatch" }, 160);
  } catch (error) {
    expect(error).toMatchObject({
      code: "turn_continuation_budget_exhausted",
      receipt: {
        status: "exhausted",
        reason: "max_model_requests",
        turnId: "turn-budget",
      },
    });
  }
});

test("Turn continuation token overshoot survives durable parse and restart receipt recovery", () => {
  const overshoots = [
    {
      reason: "max_prompt_tokens" as const,
      event: { kind: "token_usage" as const, promptTokens: 25, outputTokens: 0 },
      promptTokens: 25,
      outputTokens: 0,
    },
    {
      reason: "max_output_tokens" as const,
      event: { kind: "token_usage" as const, promptTokens: 0, outputTokens: 15 },
      promptTokens: 0,
      outputTokens: 15,
    },
  ];

  for (const overshoot of overshoots) {
    const initial = createTurnContinuationBudgetState({
      turnId: "turn-budget-overshoot",
      limits,
      nowMs: 100,
    });
    let exhaustedError: TurnContinuationBudgetExhaustedError | undefined;
    try {
      transitionTurnContinuationBudget(initial, overshoot.event, 110);
    } catch (error) {
      expect(error).toBeInstanceOf(TurnContinuationBudgetExhaustedError);
      exhaustedError = error as TurnContinuationBudgetExhaustedError;
    }
    expect(exhaustedError).toBeDefined();
    if (!exhaustedError) throw new Error("Expected token overshoot to exhaust");

    const durableState = JSON.parse(JSON.stringify(exhaustedError.state)) as unknown;
    const restored = parseTurnContinuationBudgetState(
      durableState,
      "turn-budget-overshoot",
    );
    expect(restored).toEqual(exhaustedError.state);
    expect(restored.consumedPromptTokens).toBe(overshoot.promptTokens);
    expect(restored.consumedOutputTokens).toBe(overshoot.outputTokens);
    expect(restored.terminal).toEqual({
      status: "exhausted",
      reason: overshoot.reason,
      exhaustedAtMs: 110,
    });
    expect(terminalReceiptFromState(restored)).toEqual(exhaustedError.receipt);

    let restartedError: TurnContinuationBudgetExhaustedError | undefined;
    try {
      transitionTurnContinuationBudget(restored, { kind: "model_dispatch" }, 111);
    } catch (error) {
      expect(error).toBeInstanceOf(TurnContinuationBudgetExhaustedError);
      restartedError = error as TurnContinuationBudgetExhaustedError;
    }
    expect(restartedError).toBeDefined();
    expect(restartedError?.receipt).toEqual(exhaustedError.receipt);
    expect(restartedError?.state).toEqual(restored);
  }
});

test("Turn continuation v1 durable ref bound is independent of compact replay limits", () => {
  expect(continuationResultRefLimit({ ...limits, maxToolRounds: 1 })).toBe(8);
  expect(continuationResultRefLimit({ ...limits, maxToolRounds: 2 })).toBe(16);
});

test("Turn continuation token overflow saturates safely and recovers its durable receipt", () => {
  const maxSafe = Number.MAX_SAFE_INTEGER;
  const scenarios = [
    {
      reason: "max_prompt_tokens" as const,
      limits: { ...limits, maxPromptTokens: maxSafe },
      promptTokens: maxSafe - 1,
      outputTokens: 0,
      event: { kind: "token_usage" as const, promptTokens: 2, outputTokens: 0 },
    },
    {
      reason: "max_output_tokens" as const,
      limits: { ...limits, maxOutputTokens: maxSafe },
      promptTokens: 0,
      outputTokens: maxSafe - 1,
      event: { kind: "token_usage" as const, promptTokens: 0, outputTokens: 2 },
    },
  ];

  for (const scenario of scenarios) {
    const initial = createTurnContinuationBudgetState({
      turnId: "turn-budget-safe-overflow",
      limits: scenario.limits,
      nowMs: 100,
    });
    const nearBoundary = parseTurnContinuationBudgetState({
      ...initial,
      consumedPromptTokens: scenario.promptTokens,
      consumedOutputTokens: scenario.outputTokens,
    }, "turn-budget-safe-overflow");

    let exhaustedError: TurnContinuationBudgetExhaustedError | undefined;
    try {
      transitionTurnContinuationBudget(nearBoundary, scenario.event, 110);
    } catch (error) {
      expect(error).toBeInstanceOf(TurnContinuationBudgetExhaustedError);
      exhaustedError = error as TurnContinuationBudgetExhaustedError;
    }
    expect(exhaustedError).toBeDefined();
    if (!exhaustedError) throw new Error("Expected safe integer overflow to exhaust");

    expect(exhaustedError.state.terminal).toEqual({
      status: "exhausted",
      reason: scenario.reason,
      exhaustedAtMs: 110,
    });
    expect(exhaustedError.state.consumedPromptTokens).toBe(
      scenario.reason === "max_prompt_tokens" ? maxSafe : 0,
    );
    expect(exhaustedError.state.consumedOutputTokens).toBe(
      scenario.reason === "max_output_tokens" ? maxSafe : 0,
    );

    const restored = parseTurnContinuationBudgetState(
      JSON.parse(JSON.stringify(exhaustedError.state)) as unknown,
      "turn-budget-safe-overflow",
    );
    expect(restored).toEqual(exhaustedError.state);
    expect(terminalReceiptFromState(restored)).toEqual(exhaustedError.receipt);

    let restartedError: TurnContinuationBudgetExhaustedError | undefined;
    try {
      transitionTurnContinuationBudget(restored, { kind: "model_dispatch" }, 111);
    } catch (error) {
      expect(error).toBeInstanceOf(TurnContinuationBudgetExhaustedError);
      restartedError = error as TurnContinuationBudgetExhaustedError;
    }
    expect(restartedError).toBeDefined();
    expect(restartedError?.receipt).toEqual(exhaustedError.receipt);
    expect(restartedError?.state).toEqual(restored);
  }
});

test("Turn continuation budget rejects unbounded refs and exposes typed no-progress/elapsed terminals", () => {
  const initial = createTurnContinuationBudgetState({
    turnId: "turn-budget",
    limits,
    nowMs: 100,
  });
  expect(() => transitionTurnContinuationBudget(initial, {
    kind: "durable_result_refs",
    refs: ["/private/raw-result"],
  }, 110)).toThrow("durable result ref");
  expect(() => transitionTurnContinuationBudget(
    initial,
    { kind: "no_progress" },
    110,
  )).toThrow(TurnContinuationBudgetExhaustedError);
  expect(() => transitionTurnContinuationBudget(
    initial,
    { kind: "model_dispatch" },
    1_100,
  )).toThrow(TurnContinuationBudgetExhaustedError);
  expect(() => transitionTurnContinuationBudget(
    initial,
    { kind: "model_dispatch" },
    600,
  )).toThrow(TurnContinuationBudgetExhaustedError);
});

test("Turn continuation token events keep unknown prompt usage unknown and derive the ref bound", () => {
  let state = createTurnContinuationBudgetState({
    turnId: "turn-budget-unknown",
    limits: { ...limits, maxToolRounds: 2 },
    nowMs: 100,
  });
  state = transitionTurnContinuationBudget(state, {
    kind: "token_usage",
    promptTokens: null,
    outputTokens: 3,
  }, 110);
  expect(state.consumedPromptTokens).toBe(0);
  expect(state.consumedOutputTokens).toBe(3);

  const refs = Array.from({ length: 16 }, (_, index) =>
    `guided-result-${String(index).padStart(2, "0")}-${"a".repeat(64)}`);
  state = transitionTurnContinuationBudget(state, {
    kind: "durable_result_refs",
    refs: refs.slice(0, 16),
  }, 120);
  expect(state.seenDurableResultRefs).toHaveLength(16);
  expect(() => transitionTurnContinuationBudget(state, {
    kind: "durable_result_refs",
    refs: [`guided-result-over-${"b".repeat(64)}`],
  }, 130)).toThrow(TurnContinuationBudgetExhaustedError);
});
