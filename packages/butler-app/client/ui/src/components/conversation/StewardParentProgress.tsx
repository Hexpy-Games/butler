import { useSessionViewSubscription } from "@/components/layout/hooks/useSessionViewSubscription.ts";
import { useAppLocale } from "@/app/copy.ts";
import { useId, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import {
  Button,
  ButtonContainer,
  ChevronDown,
  ChevronRight,
  Eye,
  IconButton,
  Play,
  Stack,
  SurfacePanel,
  Typo,
} from "@/butler-ds";
import type { AnchoredStewardProgress } from "./stewardParentProgressProjection.ts";
import {
  effectiveStewardStatus,
  stewardProgressStatus,
  stewardCurrentActivityTitle,
} from "./stewardProgressPresentation.ts";
import { workerActivityTitle } from "./workerActivityTitle.ts";
import { WorkBlockDetails } from "./WorkBlockDetails.tsx";
import { useWorkBlockExpanded } from "./workBlockExpansion.ts";
import { workBlockLatestStatus } from "./workBlockLatestStatus.ts";

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
  const [detailsOpen, toggleDetails] = useWorkBlockExpanded(child.session_id);
  const detailsId = useId();
  const openSessionObserver = useButlerStore(
    (state) => state.openSessionObserver,
  );
  const resumeObservedSteward = useButlerStore(
    (state) => state.resumeObservedSteward,
  );
  const turn = child.active_turn ?? child.latest_turn;
  const live = Boolean(child.active_turn || child.waiting_for_children);
  const activityLabel = workerActivityTitle(
    stewardCurrentActivityTitle(child),
    child.title,
  );
  const latestStatus = workBlockLatestStatus(rows, turn?.id, live, effectiveStewardStatus(child)) ?? activityLabel;
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
          {child.active_turn ? ` · ${activityLabel}` : ""}
        </Typo.Caption>
        <Stack align="row" cross="center" gap="sm" justify="between">
          <Typo.Caption
            aria-label={latestStatus}
            data-test-class="steward-tool-summary"
            grow
            minWidth="0"
            title={latestStatus}
            tone="secondary"
            truncate
          >
            {latestStatus}
          </Typo.Caption>
          <Button
            aria-controls={detailsOpen ? detailsId : undefined}
            aria-expanded={detailsOpen}
            data-test-class="work-block-details-toggle"
            iconEnd={detailsOpen ? <ChevronDown size="sm" /> : <ChevronRight size="sm" />}
            onClick={toggleDetails}
            text={appCopy.conversation.work.showDetailsLabel}
            type="button"
            variant="inline"
          />
        </Stack>
        <WorkBlockDetails id={detailsId} live={live}
          open={detailsOpen} sessionId={child.session_id} title={child.title} view={view} />
      </Stack>
    </SurfacePanel>
  );
}
