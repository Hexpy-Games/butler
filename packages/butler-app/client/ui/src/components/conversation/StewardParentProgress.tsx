import type { ProgressRow } from "@/app/types.ts";
import { isVisibleToolActivity } from "@/app/conversation-progress";
import { useButlerStore } from "@/app/store.ts";
import { Button, Stack, SurfacePanel, Typo } from "@/butler-ds";
import { ToolchainDisclosureRow } from "./ToolchainDisclosureRow.tsx";
import type { AnchoredStewardProgress } from "./stewardParentProgressProjection.ts";

export function StewardParentProgress({
  progress,
}: {
  progress: AnchoredStewardProgress;
}) {
  const { child, rows } = progress;
  const openSessionObserver = useButlerStore(
    (state) => state.openSessionObserver,
  );
  const toolRows = stewardToolRows(rows);
  return (
    <SurfacePanel
      aria-label={child.title}
      data-test-class="steward-parent-progress steward-parent-progress-card"
      elevation="none"
      role="region"
    >
      <Stack gap="sm">
        <Typo.Label as="span">{child.title}</Typo.Label>
        <Typo.Caption data-test-class="steward-progress-status">
          {stewardProgressStatus(child)}
        </Typo.Caption>
        <Stack gap="xs" aria-label="도구 호출 내역">
          {toolRows.length > 0 ? toolRows.map((row) => (
            <ToolchainDisclosureRow key={row.id} row={row} />
          )) : (
            <Typo.Caption>도구 호출 내역이 아직 없습니다.</Typo.Caption>
          )}
        </Stack>
        <Button
          size="xs"
          text="진행 상세 보기"
          type="button"
          variant="borderless"
          onClick={() => openSessionObserver(child.session_id)}
        />
      </Stack>
    </SurfacePanel>
  );
}

function stewardProgressStatus(
  child: Pick<
    AnchoredStewardProgress["child"],
    "approved_plan_total" | "approved_plan_completed" | "status"
  >,
): string {
  if (child.status === "delivered") return "완료됨";
  if (child.status === "failed") return "실패함";
  if (child.status === "cancelled") return "중단됨";
  if (child.status === "idle") return "대기 중";
  const planTotal = child.approved_plan_total;
  const planCompleted = child.approved_plan_completed;
  if (planTotal !== undefined && planCompleted !== undefined) {
    const total = Math.max(1, planTotal);
    const completed = Math.min(total, Math.max(0, planCompleted));
    return `작업 중 · ${Math.min(total, completed + 1)}/${total}`;
  }
  return "작업 중";
}

function stewardToolRows(rows: ProgressRow[]): ProgressRow[] {
  const byTool = new Map<string, ProgressRow>();
  for (const row of rows) {
    if (!isVisibleToolActivity(row, "")) continue;
    byTool.set(row.tool_call_id ? `tool:${row.tool_call_id}` : `row:${row.id}`, row);
  }
  return [...byTool.values()];
}
