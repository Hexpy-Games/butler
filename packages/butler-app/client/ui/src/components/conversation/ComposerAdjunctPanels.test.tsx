import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
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
              id: "task-outcome",
              kind: "task_outcome",
              safe_label: "Task outcome",
              safe_value: "실제 제품 경로 전체에서 진행 정보가 손실 없이 실시간으로 동기화된다.",
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
      ]}
    />,
  );

  expect(html).toContain("work-progress-panel");
  expect(html).not.toContain("Synchronize canonical progress");
  expect(html).toContain("실시간 진행 동기화");
  expect(html).toContain("실제 제품 경로 전체에서 진행 정보가 손실 없이 실시간으로 동기화된다.");
  expect(html).toContain('data-state="reviewing"');
  expect(html).toContain('data-state="correction-required"');
});
