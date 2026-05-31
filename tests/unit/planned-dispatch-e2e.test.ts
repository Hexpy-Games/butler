import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pollWorkerResultsOnce } from "../../packages/butler-agent/src/interfaces/gateway/worker-result-monitor.ts";
import { createButlerToolExecutor } from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { toTelegramMarkdownV2 } from "../../packages/butler-agent/src/interfaces/transport/telegram/markdown-v2.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-planned-e2e-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function completeWorker(workerTaskId: string, result: string): void {
  const taskDir = join(tempDir, "tasks", workerTaskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(taskDir, "result.md"), `${result}\n`, "utf8");
}

test("PD-E2E-02 planned task creates plan, runs, reviews PASS, reports, and delivers", async () => {
  let workerIndex = 0;
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: () => {
      workerIndex += 1;
      return {
        task_id: `worker-${workerIndex}`,
        status: "RUNNING",
        message: "stubbed",
      };
    },
  });

  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "검토된 보고서를 만든다",
      acceptance_criteria: ["검증 증거가 있다"],
      verification_commands: ["bun test"],
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({ name: "run_planned_task", args: { task_id: created.task_id }, rawArguments: "{}" });
  completeWorker("worker-1", "verification evidence exists");

  const reviewPromotions: string[] = [];
  expect(await pollWorkerResultsOnce({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/main",
    chatId: "123",
    handlePlannedTaskReadyForReview: (promotion) => {
      reviewPromotions.push(promotion.plannedTaskId);
    },
  })).toBe(0);
  expect(reviewPromotions).toEqual([created.task_id]);

  await execute({
    name: "review_planned_task",
    args: {
      task_id: created.task_id,
      criteria: [{ criterion: "검증 증거가 있다", verdict: "PASS", evidence: "verification evidence exists" }],
      goal_review: { verdict: "PASS", evidence: "verification evidence exists" },
    },
    rawArguments: "{}",
  });
  await execute({
    name: "write_planned_public_report",
    args: {
      task_id: created.task_id,
      report: "검토된 보고서가 준비되었습니다.\n\n검증 증거를 바탕으로 사용자에게 전달할 결론을 정리했습니다.",
      outcome: "검토된 보고서가 준비되었습니다.",
      what_was_done: ["계획된 작업을 실행하고 검증 증거를 확인했습니다."],
      residual_risk: [],
      next_action: "필요하면 다음 작업을 이어가겠습니다.",
    },
    rawArguments: "{}",
  });

  const deliveries: string[] = [];
  expect(await pollWorkerResultsOnce({
    butlerHome: tempDir,
    butlerData: tempDir,
    sessionId: "butler/main",
    chatId: "123",
    sendTelegram: async (delivery) => {
      deliveries.push(delivery.text);
      return { ok: true, transportMessageId: String(deliveries.length) };
    },
  })).toBe(1);
  expect(deliveries[0]).toContain(toTelegramMarkdownV2("검토된 보고서가 준비되었습니다."));
  expect(deliveries[0]).toContain(toTelegramMarkdownV2("사용자에게 전달할 결론을 정리했습니다."));
  expect(deliveries[0]).not.toContain("Verdict: PASS");
});

test("PD-E2E-03 planned review FAIL repairs autonomously and reaches reportable PASS", async () => {
  let workerIndex = 0;
  const execute = createButlerToolExecutor({
    butlerHome: tempDir,
    butlerData: tempDir,
    dispatchTask: () => {
      workerIndex += 1;
      return {
        task_id: `repair-worker-${workerIndex}`,
        status: "RUNNING",
        message: "stubbed",
      };
    },
  });

  const created = await execute({
    name: "create_planned_task",
    args: {
      goal: "실패 후 자율 수리한다",
      acceptance_criteria: ["최종 검증 통과"],
      repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    },
    rawArguments: "{}",
  }) as { task_id: string };
  await execute({ name: "run_planned_task", args: { task_id: created.task_id }, rawArguments: "{}" });
  completeWorker("repair-worker-1", "verification failed");
  await pollWorkerResultsOnce({ butlerHome: tempDir, butlerData: tempDir, sessionId: "butler/main", chatId: "123" });
  await execute({
    name: "review_planned_task",
    args: {
      task_id: created.task_id,
      criteria: [{ criterion: "최종 검증 통과", verdict: "FAIL", evidence: "verification failed" }],
      repair_recommendation: "Fix verification failure.",
    },
    rawArguments: "{}",
  });
  expect(await execute({
    name: "repair_planned_task",
    args: { task_id: created.task_id },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    attempt: 2,
    status: "PLANNED_RUNNING",
  });

  completeWorker("repair-worker-2", "final verification passed");
  await pollWorkerResultsOnce({ butlerHome: tempDir, butlerData: tempDir, sessionId: "butler/main", chatId: "123" });
  expect(await execute({
    name: "review_planned_task",
    args: {
      task_id: created.task_id,
      attempt: 2,
      criteria: [{ criterion: "최종 검증 통과", verdict: "PASS", evidence: "final verification passed" }],
      goal_review: { verdict: "PASS", evidence: "final verification passed" },
    },
    rawArguments: "{}",
  })).toMatchObject({
    ok: true,
    verdict: "PASS",
    status: "REVIEW_PASSED",
  });
});
