import { useAppLocale, appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { StewardSessionSummaryView } from "@/app/types.ts";
import { Button, Stack } from "@/butler-ds";
import { useSessionViewSubscription } from "@/components/layout/hooks/useSessionViewSubscription.ts";
import { stewardCurrentActivityTitle, stewardPlanProgress, stewardProgressStatus } from "./stewardProgressPresentation.ts";
import { workerActivityTitle } from "./workerActivityTitle.ts";

/** A plan step's Worker: its title and live activity, read from the Worker's own view. */
export function StepWorkerCapsule({ worker }: { worker: StewardSessionSummaryView }) {
  useAppLocale();
  const view = useButlerStore(state => state.sessionViews[worker.session_id]);
  const refresh = useButlerStore(state => state.refreshSessionObserver);
  const open = useButlerStore(state => state.openSessionObserver);
  useSessionViewSubscription(worker.session_id, refresh);
  const child = view ? { ...worker, status: view.status, active_turn: view.active_turn,
    waiting_for_children: view.waiting_for_children,
    approved_plan_total: view.approved_plan_total ?? worker.approved_plan_total,
    approved_plan_completed: view.approved_plan_completed ?? worker.approved_plan_completed } : worker;
  const live = Boolean(child.active_turn || child.waiting_for_children);
  const activity = live
    ? workerActivityTitle(stewardCurrentActivityTitle(child), child.title)
    : stewardProgressStatus(child);
  const label = [child.title, live ? stewardPlanProgress(child) : null, activity].filter(Boolean).join(" · ");
  return (
    <Stack cross="start" gap="xs" data-test-class="step-worker-capsule" data-session-id={worker.session_id}>
      <Button variant="outline" shape="pill" aria-label={appCopy.interfaceTemplates.viewActivity(label)}
        title={activity} onClick={() => open(worker.session_id)} text={label} />
    </Stack>
  );
}
