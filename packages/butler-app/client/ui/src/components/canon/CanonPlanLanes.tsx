import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { PlanCards } from "@/app/canonApi.ts";
import { Box, Button, KanbanBoard, KanbanLane, Plus } from "@/butler-ds";
import { EpicCard } from "./EpicCard.tsx";
import { CANON_LANES, canonLaneId } from "./canonLanes.ts";
export function CanonPlanLanes({ plan, selected, onSelect, onCreate }: {
  plan: PlanCards; selected: string | null; onSelect: (id: string) => void; onCreate: (planId: string) => void;
}) {
  useAppLocale();
  const ordinals = new Map(plan.works.map((epic, index) => [epic.id, index + 1]));
  return <Box paddingEnd="md"><KanbanBoard scroll data-plan-id={plan.id} data-test-class="canon-plan-lanes">
    {CANON_LANES.map(status => {
      const cards = plan.works.filter(epic => (epic.canon_status === "cancelled" ? "done" : epic.canon_status) === status);
      const label = status === "blocked" ? appCopy.canon.blockedLane : appCopy.canon.statuses[status];
      return <Box key={status} data-canon-lane={status}>
        <KanbanLane laneId={canonLaneId(plan.id, status)} label={`${plan.title} · ${label}`} height="content" title={`${label} · ${cards.length}`}>
          {cards.map(epic => <EpicCard key={epic.id} epic={epic} ordinal={ordinals.get(epic.id)}
            selected={selected === epic.id} onSelect={onSelect} />)}
          {status === "planned" && <Button variant="borderless" size="xs" onClick={() => onCreate(plan.id)}><Plus size="xs" />{appCopy.canon.newEpic}</Button>}
        </KanbanLane>
      </Box>;
    })}
  </KanbanBoard></Box>;
}
