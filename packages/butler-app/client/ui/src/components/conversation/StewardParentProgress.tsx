import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import {
  Eye,
  IconButton,
  Play,
  Stack,
  SurfacePanel,
  Typo,
} from "@/butler-ds";
import { workActivityToolsFromRows } from "./toolchainUtils.tsx";
import type { AnchoredStewardProgress } from "./stewardParentProgressProjection.ts";
import {
  stewardProgressStatus,
  stewardToolRows,
} from "./stewardProgressPresentation.ts";
import styles from "./StewardParentProgress.module.css";

export function StewardParentProgress({
  progress,
}: {
  progress: AnchoredStewardProgress;
}) {
  const { child, rows } = progress;
  const [resuming, setResuming] = useState(false);
  const openSessionObserver = useButlerStore(
    (state) => state.openSessionObserver,
  );
  const resumeObservedSteward = useButlerStore(
    (state) => state.resumeObservedSteward,
  );
  const turn = child.active_turn ?? child.latest_turn;
  const toolRows = stewardToolRows(rows);
  const tools = workActivityToolsFromRows(toolRows, turn?.id);
  const toolSummary = summarizeTools(tools);
  return (
    <SurfacePanel
      aria-label={child.title}
      data-test-class="steward-parent-progress steward-parent-progress-card"
      elevation="none"
      role="region"
    >
      <Stack gap="sm">
        <Stack align="row" cross="start" gap="sm" justify="between">
          <Typo.Label
            as="span"
            className={styles.title}
            title={child.title}
          >
            {child.title}
          </Typo.Label>
          <Stack align="row" gap="xs">
            {turn?.retryable && !child.active_turn && !child.result ? (
              <IconButton
                className={styles.observerAction}
                data-test-class="steward-resume-action"
                disabled={resuming}
                label={appCopy.conversation.work.resumeInterrupted}
                onClick={() => {
                  setResuming(true);
                  void resumeObservedSteward(child.relation.relation_id)
                    .finally(() => setResuming(false));
                }}
              >
                <Play size={16} />
              </IconButton>
            ) : null}
            <IconButton
              className={styles.observerAction}
              data-test-class="steward-observer-action"
              label="진행 상세 보기"
              onClick={() => openSessionObserver(child.session_id)}
            >
              <Eye size={16} />
            </IconButton>
          </Stack>
        </Stack>
        <Typo.Caption data-test-class="steward-progress-status">
          {stewardProgressStatus(child)}
        </Typo.Caption>
        <Stack
          align="row"
          aria-label="도구 사용 내역"
          data-test-class="steward-tool-summary"
          gap="xs"
          wrap
        >
          <Typo.Caption className={styles.toolLabel}>도구 사용</Typo.Caption>
          <Typo.Caption className={styles.toolSummary}>
            {toolSummary || "내역 없음"}
          </Typo.Caption>
        </Stack>
      </Stack>
    </SurfacePanel>
  );
}

function summarizeTools(
  tools: ReturnType<typeof workActivityToolsFromRows>,
): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const label = tool.summaryLabel?.trim() || "도구";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");
}
