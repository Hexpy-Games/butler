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
import type { AnchoredStewardProgress } from "@/components/conversation/stewardParentProgressProjection.ts";
import {
  effectiveStewardStatus,
  stewardCurrentActivityTitle,
} from "@/components/conversation/stewardProgressPresentation.ts";
import { workerActivityTitle } from "@/components/conversation/workerActivityTitle.ts";
import { StepDetails } from "./StepDetails";
import type { StepPlan } from "./stepCardFixture";
import type { BoundaryVariant } from "./StepTimeline";

import { useWorkBlockExpanded } from "@/components/conversation/workBlockExpansion.ts";
import { workBlockLatestStatus } from "@/components/conversation/workBlockLatestStatus.ts";
import { workBlockTail } from "@/components/conversation/workBlockTail.ts";

function planStatus(plan: StepPlan): string {
  const actions = plan.actions;
  const failed = actions.find(action => action.status === "failed");
  if (failed) return `실패함 · ${failed.title}에서`;
  const done = actions.filter(action => action.status === "done").length;
  if (done === actions.length) return `완료됨 · ${actions.length}/${actions.length} 단계`;
  const running = actions.filter(action => action.status === "running").map(action => action.title);
  return `완료 ${done}/${actions.length}${running.length ? ` · 지금: ${running.join(", ")}` : ""}`;
}

export function StewardStepProgress({
  progress, plan, variant, fold,
}: {
  progress: AnchoredStewardProgress; plan: StepPlan; variant: BoundaryVariant; fold: boolean;
}) {
  useAppLocale();
  const view = useButlerStore(state => state.sessionViews[progress.child.session_id]);
  const refresh = useButlerStore(state => state.refreshSessionObserver);
  useSessionViewSubscription(progress.child.session_id, refresh);
  const child = view ? { ...progress.child, active_turn: view.active_turn, latest_turn: view.latest_turn,
    status: view.status, approved_plan_total: view.approved_plan_total ?? progress.child.approved_plan_total,
    approved_plan_completed: view.approved_plan_completed ?? progress.child.approved_plan_completed, waiting_for_children: view.waiting_for_children } : progress.child;
  const rows = (child.active_turn ?? child.latest_turn)?.progress?.safe_progress_rows ?? progress.rows;
  const [detailsOpen, toggleDetails] = useWorkBlockExpanded(child.session_id);
  const detailsId = useId();
  const turn = child.active_turn ?? child.latest_turn;
  const live = Boolean(child.active_turn || child.waiting_for_children);
  const activityLabel = workerActivityTitle(
    stewardCurrentActivityTitle(child),
    child.title,
  );
  const latestStatus = workBlockLatestStatus(rows, turn?.id, live, effectiveStewardStatus(child)) ?? activityLabel;
  const tail = useMemo(() => workBlockTail(view, rows, turn?.id), [view, rows, turn?.id]);
  const status = planStatus(plan);
  return (
    <SurfacePanel
      aria-label={child.title}
      data-test-class="steward-parent-progress steward-parent-progress-card"
      elevation="none"
      radius="lg"
      role="region"
    >
      <Stack gap="sm">
        <StepCardHeader child={child} />
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
          <StepDetails live={live} sessionId={child.session_id} view={view} plan={plan} variant={variant} fold={fold} />
        </WorkActivityDisclosure>
      </Stack>
    </SurfacePanel>
  );
}

function StepCardHeader({ child }: { child: AnchoredStewardProgress["child"] }) {
  const [resuming, setResuming] = useState(false);
  const openSessionObserver = useButlerStore(state => state.openSessionObserver);
  const resumeObservedSteward = useButlerStore(state => state.resumeObservedSteward);
  const turn = child.active_turn ?? child.latest_turn;
  return (
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
  );
}
