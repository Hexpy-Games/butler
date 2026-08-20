import type { ProgressRow } from "@/app/types.ts";
import { Typo } from "@/butler-ds";
import { TurnActivityPanel } from "./TurnActivityPanel.tsx";
import type { AnchoredStewardProgress } from "./stewardParentProgressProjection.ts";

export function StewardParentProgress({
  progress,
}: {
  progress: AnchoredStewardProgress;
}) {
  const { child, turn, rows } = progress;
  return (
    <section
      aria-label={child.title}
      data-test-class="steward-parent-progress"
    >
      <Typo.Caption data-test-class="steward-progress-capsule">
        {stewardProgressCapsule(
          child,
          rows,
          turn.progress.summary ?? "작업을 진행 중입니다.",
        )}
      </Typo.Caption>
      <TurnActivityPanel
        rows={rows}
        state={turn.state}
        startedAt={turn.created_at}
        turnId={turn.id}
      />
    </section>
  );
}

function stewardProgressCapsule(
  child: Pick<AnchoredStewardProgress["child"], "approved_plan_total" | "approved_plan_completed">,
  rows: ProgressRow[],
  currentStage: string,
): string {
  const planTotal = child.approved_plan_total;
  const planCompleted = child.approved_plan_completed;
  if (planTotal !== undefined && planCompleted !== undefined) {
    const total = Math.max(1, planTotal);
    const completed = Math.min(total, Math.max(0, planCompleted));
    const current = rows.find(
      (row) => !["completed", "delivered", "skipped"].includes(row.state),
    );
    return `작업 중 · ${Math.min(total, completed + 1)}/${total} · ${current?.safe_label ?? currentStage}`;
  }
  return `작업 중 · ${currentStage}`;
}
