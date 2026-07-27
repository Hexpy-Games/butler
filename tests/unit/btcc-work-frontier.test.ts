import { describe, expect, test } from "bun:test";
import type { ReviewedManagedProgramState } from
  "../../packages/butler-agent/src/agent/btcc/work-ledger/index.ts";
import { canOpenPromotionFrontier } from
  "../../packages/butler-agent/src/agent/btcc/work-ledger/frontier-readiness.ts";
import { selectNextTaskOrClose } from
  "../../packages/butler-agent/src/agent/btcc/work/select-next-task-or-close.ts";

describe("BTCC dependency-driven Work frontier", () => {
  test("opens promotion when the remaining ordinary Task depends on it", () => {
    const program = fixtureProgram("implementation_open");

    expect(canOpenPromotionFrontier(program)).toBe(true);
  });

  test("continues a post-promotion Task before closing the Program", () => {
    const program = fixtureProgram("promotion_open");
    program.tasks[1]!.status = "accepted";

    expect(selectNextTaskOrClose({
      turnId: "turn-work-frontier",
      turnRevision: 12,
      program,
    })).toEqual({ kind: "select_task", task: program.tasks[2] });

    program.tasks[2]!.status = "accepted";
    expect(selectNextTaskOrClose({
      turnId: "turn-work-frontier",
      turnRevision: 13,
      program,
    })).toEqual({ kind: "complete_promotion" });
  });
});

function fixtureProgram(
  frontier: "implementation_open" | "promotion_open",
): ReviewedManagedProgramState {
  const implementation = task("implementation", 1, "workspace_artifact", "accepted", []);
  const promotion = task("promotion", 2, "repository_promotion", "planned", ["implementation"]);
  const reconciliation = task("reconciliation", 3, "non_artifact", "planned", ["promotion"]);
  return {
    frontier,
    tasks: [implementation, promotion, reconciliation],
  } as ReviewedManagedProgramState;
}

function task(
  id: string,
  executionOrdinal: number,
  kind: "workspace_artifact" | "repository_promotion" | "non_artifact",
  status: "accepted" | "planned",
  dependencies: string[],
): ReviewedManagedProgramState["tasks"][number] {
  const artifactPolicy = kind === "repository_promotion"
    ? { kind, targetScopeRef: "workspace:/repo", targetPath: "." }
    : kind === "workspace_artifact"
      ? {
          kind,
          workspaceScopeRef: "workspace:/repo",
          workspacePath: ".",
          baselinePolicy: "capture_at_workspace_provision" as const,
          mutationScope: { kind: "read_only" as const },
        }
      : { kind, targetScopeRefs: ["ledger:project"] };
  return {
    status,
    task: {
      ref: { id, sha256: `${id}-sha` },
      executionOrdinal,
      dependencyTaskRefs: dependencies.map((dependency) => ({
        id: dependency,
        sha256: `${dependency}-sha`,
      })),
      artifactPolicy,
    },
  } as ReviewedManagedProgramState["tasks"][number];
}
