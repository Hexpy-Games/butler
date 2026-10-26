import { useSessionViewSubscription } from "@/components/layout/hooks/useSessionViewSubscription.ts";
import { useAppLocale } from "@/app/copy.ts";
import { useId, useMemo, useState } from "react";
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
  WorkActivityDisclosure,
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
import { workBlockTail } from "./workBlockTail.ts";

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
  const tail = useMemo(() => workBlockTail(view, rows, turn?.id), [view, rows, turn?.id]);
  const status = stewardProgressStatus(child);
  return (
    <SurfacePanel
      aria-label={child.title}
      data-test-class="steward-parent-progress steward-parent-progress-card"
      elevation="none"
      radius="lg"
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
        <WorkActivityDisclosure
          data-test-class="work-block-disclosure"
          detailsId={detailsId}
          detailsLabel={appCopy.conversation.work.detailsRegionLabel(child.title)}
          expanded={detailsOpen}
          hiddenCount={tail.earlier}
          label={appCopy.conversation.work.disclosureLabel(status, latestStatus, tail.earlier)}
          latest={latestStatus}
          live={live}
          onToggle={toggleDetails}
          previous={tail.previous}
          status={status}
        >
          <WorkBlockDetails live={live} sessionId={child.session_id} view={view} />
        </WorkActivityDisclosure>
      </Stack>
    </SurfacePanel>
  );
}
