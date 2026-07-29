import { describe, expect, test } from "bun:test";
import { assertAcceptedCorrectionFitsCurrentTask } from
  "../../packages/butler-agent/src/agent/btcc/planning/correction-authority.ts";

const ref = (id: string) => ({ id, sha256: `${id}-sha` });

describe("BTCC correction authority", () => {
  test("rejects workspace mutation from a read-only validation Task", () => {
    expect(() => assertAcceptedCorrectionFitsCurrentTask(
      candidate({
        kind: "workspace_mutation",
        workspaceScopeRef: "workspace:/repo",
        writablePaths: ["tests/word-chain.test.ts"],
      }),
      task({ kind: "read_only" }),
    )).toThrow("must revise feedback_intent");
  });

  test("accepts an observation-only correction from a read-only Task", () => {
    expect(() => assertAcceptedCorrectionFitsCurrentTask(
      candidate({ kind: "observation_only" }),
      task({ kind: "read_only" }),
    )).not.toThrow();
  });

  test("accepts only mutation paths already owned by the current Task", () => {
    const current = task({
      kind: "contained_paths",
      writablePaths: ["tests"],
    });
    expect(() => assertAcceptedCorrectionFitsCurrentTask(
      candidate({
        kind: "workspace_mutation",
        workspaceScopeRef: "workspace:/repo",
        writablePaths: ["tests/word-chain.test.ts"],
      }),
      current,
    )).not.toThrow();
    expect(() => assertAcceptedCorrectionFitsCurrentTask(
      candidate({
        kind: "workspace_mutation",
        workspaceScopeRef: "workspace:/repo",
        writablePaths: ["src/word-chain.ts"],
      }),
      current,
    )).toThrow("must revise feedback_intent");
  });
});

function candidate(executionRequirement: Record<string, unknown>): any {
  return {
    correctionKind: "implementation_repair",
    correctionPlan: { executionRequirement },
  };
}

function task(mutationScope: Record<string, unknown>): any {
  return {
    ref: ref("task"),
    artifactPolicy: {
      kind: "workspace_artifact",
      workspaceScopeRef: "workspace:/repo",
      mutationScope,
    },
  };
}
