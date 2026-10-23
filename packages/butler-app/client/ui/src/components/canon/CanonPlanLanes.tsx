import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { CanonStatus, PlanCards } from "@/app/canonApi.ts";
import { Box, Button, KanbanBoard, Plus, Section } from "@/butler-ds";
import { EpicCard } from "./EpicCard.tsx";
const LANES: CanonStatus[] = ["planned", "in_progress", "in_review", "blocked", "done"];
export function CanonPlanLanes({ plan, selected, onSelect, onCreate }: {
  plan: PlanCards; selected: string | null; onSelect: (id: string) => void; onCreate: (planId: string) => void;
}) {
  useAppLocale();
  const ordinals = new Map(plan.works.map((epic, index) => [epic.id, index + 1]));
  return <KanbanBoard scroll data-plan-id={plan.id} data-test-class="canon-plan-lanes">
    {LANES.map(status => {
      const cards = plan.works.filter(epic => (epic.canon_status === "cancelled" ? "done" : epic.canon_status) === status);
      const label = status === "blocked" ? appCopy.canon.blockedLane : appCopy.canon.statuses[status];
      return <Box key={status} surface="base" border="hairline" radius="control" padding="md" alignSelf="start" data-canon-lane={status}>
        <Section title={`${label} · ${cards.length}`} gap="sm">
          {cards.map(epic => <EpicCard key={epic.id} epic={epic} ordinal={ordinals.get(epic.id)}
            selected={selected === epic.id} onSelect={onSelect} />)}
          {status === "planned" && <Button variant="borderless" size="xs" onClick={() => onCreate(plan.id)}><Plus size="xs" />{appCopy.canon.newEpic}</Button>}
        </Section>
      </Box>;
    })}
  </KanbanBoard>;
}
