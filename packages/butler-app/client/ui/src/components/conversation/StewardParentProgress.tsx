import { useSessionViewSubscription } from "@/components/layout/hooks/useSessionViewSubscription.ts";
import { useAppLocale } from "@/app/copy.ts";
import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import {
  ButtonContainer,
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
  stewardCurrentActivityTitle,
  stewardToolRows,
} from "./stewardProgressPresentation.ts";

export function StewardParentProgress({
  progress,
}: {
  progress: AnchoredStewardProgress;
}) {
  useAppLocale();
  const view = useButlerStore(state => state.sessionViews[progress.child.session_id]);
  const refresh = useButlerStore(state => state.refreshSessionObserver);
  useSessionViewSubscription(progress.child.session_id, refresh);
  const child = view ? { ...progress.child, active_turn: view.active_turn, latest_turn: view.latest_turn,
    status: view.status, approved_plan_total: view.approved_plan_total ?? progress.child.approved_plan_total,
    approved_plan_completed: view.approved_plan_completed ?? progress.child.approved_plan_completed, waiting_for_children: view.waiting_for_children } : progress.child;
  const rows = (child.active_turn ?? child.latest_turn)?.progress?.safe_progress_rows ?? progress.rows;
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
          <Typo.Label as="span" minWidth="0" title={child.title} truncate>
            {child.title}
          </Typo.Label>
          <ButtonContainer size="icon-sm">
            {turn?.retryable && !child.active_turn && !child.result ? (
              <IconButton
                opticalAlign="top-end"
                data-test-class="steward-resume-action"
                disabled={resuming}
                label={appCopy.conversation.work.resumeInterrupted}
                onClick={() => {
                  setResuming(true);
                  void resumeObservedSteward(child.relation.relation_id)
                    .finally(() => setResuming(false));
                }}
              >
                <Play size="md" />
              </IconButton>
            ) : null}
            <IconButton
              opticalAlign="top-end"
              data-test-class="steward-observer-action"
              label={appCopy.interfaceDetails.progressDetails}
              onClick={() => openSessionObserver(child.session_id)}
            >
              <Eye size="md" />
            </IconButton>
          </ButtonContainer>
        </Stack>
        <Typo.Caption data-test-class="steward-progress-status">
          {stewardProgressStatus(child)}
          {child.active_turn ? ` · ${stewardCurrentActivityTitle(child)}` : ""}
        </Typo.Caption>
        <Stack
          align="row"
          aria-label={appCopy.interfaceDetails.toolHistory}
          data-test-class="steward-tool-summary"
          gap="xs"
          wrap
        >
          <Typo.Caption tone="tertiary">{appCopy.interfaceDetails.toolUsage}</Typo.Caption>
          <Typo.Caption tone="secondary">
            {toolSummary || appCopy.interfaceDetails.noHistory}
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
    const label = tool.summaryLabel?.trim() || appCopy.interfaceDetails.tool;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");
}
