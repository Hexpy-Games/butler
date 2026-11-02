import type { SessionView } from "@/app/types";
import { ScrollArea } from "@/butler-ds";
import { useFollowLatest } from "@/components/conversation/hooks/useFollowLatest";
import { ObservedSessionContext } from "@/components/conversation/observedSessionContext";
import { StepTimeline, type BoundaryVariant } from "./StepTimeline";
import type { StepPlan } from "./stepCardFixture";

export function StepDetails({ sessionId, view, live, plan, variant, fold }: {
  sessionId: string; view?: SessionView; live: boolean; plan: StepPlan; variant: BoundaryVariant; fold: boolean;
}) {
  const followLatest = useFollowLatest(live);
  return <ScrollArea maxHeight="sm" scrollRef={followLatest} dataTestClass="work-block-details-scroll">
    <ObservedSessionContext.Provider value={sessionId}>
      {view ? <StepTimeline view={view} plan={plan} variant={variant} fold={fold} live={live} /> : null}
    </ObservedSessionContext.Provider>
  </ScrollArea>;
}
