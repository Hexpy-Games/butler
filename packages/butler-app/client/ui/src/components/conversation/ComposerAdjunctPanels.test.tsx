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
          safe_label: "Exercise the real SSE reducer",
          safe_input_label: "task-1",
          bridge_phase: "btcc_work_ledger",
          safe_detail_rows: [
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
  expect(html).toContain("Synchronize canonical progress");
  expect(html).toContain("Exercise the real SSE reducer");
  expect(html).toContain('data-state="reviewing"');
  expect(html).toContain('data-state="correction-required"');
});
