import { useButlerStore } from "@/app/store.ts";
import {
  Button,
  Stack,
  SurfacePanel,
  Typo,
  WorkActivityToolGroup,
} from "@/butler-ds";
import { workActivityToolsFromRows } from "./toolchainUtils.tsx";
import type { AnchoredStewardProgress } from "./stewardParentProgressProjection.ts";
import {
  stewardProgressStatus,
  stewardToolRows,
} from "./stewardProgressPresentation.ts";

export function StewardParentProgress({
  progress,
}: {
  progress: AnchoredStewardProgress;
}) {
  const { child, rows } = progress;
  const openSessionObserver = useButlerStore(
    (state) => state.openSessionObserver,
  );
  const turn = child.active_turn ?? child.latest_turn;
  const toolRows = stewardToolRows(rows);
  const tools = workActivityToolsFromRows(toolRows, turn?.id);
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
          {tools.length > 0 ? (
            <WorkActivityToolGroup tools={tools} />
          ) : (
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
