import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getAppCopy } from "@/app/copy.ts";
import { ComposerAdjunctPanels } from "./ComposerAdjunctPanels";

test("composer progress owns the canonical Work and Task list", () => {
  const html = renderToStaticMarkup(
    <ComposerAdjunctPanels
      queuedMessages={[]}
      onDeleteQueued={() => undefined}
      onEditQueued={() => undefined}
      showWorkers={false}
      taskTurnState="thinking"
      taskRows={[
        {
          id: "task-1",
          kind: "todo",
          state: "reviewing",
          safe_label: "실시간 진행 동기화",
          safe_input_label: "task-1",
          bridge_phase: "btcc_work_ledger",
          safe_detail_rows: [
            {
              id: "task-description",
              kind: "task_description",
              safe_label: "Task",
              safe_value: "전체 실행 경로에서 진행 상태가 실제 작업과 일치하도록 만든다.",
              state: "active",
            },
            {
              id: "task-outcome",
              kind: "task_outcome",
              safe_label: "Task outcome",
              safe_value: "현재 투영 경로를 확인 중이다.",
              state: "active",
            },
            {
              id: "work",
              kind: "work",
              safe_label: "Work",
              safe_value: "Synchronize canonical progress",
              state: "active",
            },
          ],
        },
        {
          id: "task-2",
          kind: "todo",
          state: "correction_required",
          safe_label: "Repair the failed review finding",
          safe_input_label: "task-2",
          bridge_phase: "btcc_work_ledger",
        },
        {
          id: "task-3",
          kind: "todo",
          state: "blocked",
          safe_label: "Wait for the required fixture",
          safe_input_label: "task-3",
          bridge_phase: "btcc_work_ledger",
        },
        {
          id: "task-4",
          kind: "todo",
          state: "skipped",
          safe_label: "Skip the superseded action",
          safe_input_label: "task-4",
          bridge_phase: "btcc_work_ledger",
        },
      ]}
    />,
  );

  expect(html).toContain("work-progress-panel");
  expect(html).not.toContain("Synchronize canonical progress");
  expect(html).toContain("실시간 진행 동기화");
  expect(html).toContain("전체 실행 경로에서 진행 상태가 실제 작업과 일치하도록 만든다.");
  expect(html).not.toContain("현재 투영 경로를 확인 중이다.");
  expect(html).toContain('data-state="reviewing"');
  expect(html).toContain('data-state="correction-required"');
  expect(html).toContain('data-state="blocked"');
  expect(html).toContain('data-state="skipped"');
  expect(html).toContain("Blocked");
  expect(html).toContain("Skipped");
});

test("work progress copy names blocked and skipped states in both locales", () => {
  const korean = getAppCopy("ko-KR").conversation.work;
  const english = getAppCopy("en-US").conversation.work;

  expect(korean.todoItemBlockedLabel).toBe("막힘");
  expect(korean.todoItemSkippedLabel).toBe("건너뜀");
  expect(english.todoItemBlockedLabel).toBe("Blocked");
  expect(english.todoItemSkippedLabel).toBe("Skipped");
});
