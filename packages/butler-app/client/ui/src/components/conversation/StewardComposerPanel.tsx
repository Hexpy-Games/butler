import type { ProgressRow, StewardSessionSummaryView } from "@/app/types.ts";
import { ComposerAdjunctPanel, Typo } from "@/butler-ds";
import { TurnActivityPanel } from "./TurnActivityPanel.tsx";

export function StewardComposerPanel({
  child,
}: {
  child: StewardSessionSummaryView;
}) {
  const turn = child.active_turn;
  if (!turn) return null;
  const rows = turn.progress.safe_progress_rows;
  const capsule = stewardProgressCapsule(
    child,
    rows,
    turn.progress.summary ?? "작업을 진행 중입니다.",
  );
  return (
    <ComposerAdjunctPanel
      aria-label={child.title}
      data-test-class="steward-composer-panel"
      heading={child.title}
      collapsedSummary={capsule}
    >
      <Typo.Caption data-test-class="steward-progress-capsule">
        {capsule}
      </Typo.Caption>
      <TurnActivityPanel
        rows={rows}
        state={turn.state}
        startedAt={turn.created_at}
        turnId={turn.id}
      />
    </ComposerAdjunctPanel>
  );
}

function stewardProgressCapsule(
  child: Pick<StewardSessionSummaryView, "approved_plan_total" | "approved_plan_completed">,
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
