import { useEffect, useRef, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { PlanCards } from "@/app/canonApi.ts";
import { Box, Button, ButtonContainer, ArrowLeft, ArrowRight, Grid, IconButton, KanbanBoard, KanbanLane, Plus } from "@/butler-ds";
import { EpicCard } from "./EpicCard.tsx";
import { CANON_LANES, canonLaneId } from "./canonLanes.ts";
export function CanonPlanLanes({ plan, selected, onSelect, onCreate }: {
  plan: PlanCards; selected: string | null; onSelect: (id: string) => void; onCreate: (planId: string) => void;
}) {
  useAppLocale();
  const frame = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false });
  useEffect(() => {
    const board = frame.current?.querySelector<HTMLElement>('[data-test-class="canon-plan-lanes"]');
    if (!board) return;
    const update = () => setEdges({ overflow: board.scrollWidth > board.clientWidth + 1,
      left: board.scrollLeft > 1, right: board.scrollLeft + board.clientWidth < board.scrollWidth - 1 });
    const observer = new ResizeObserver(update);
    observer.observe(board);
    board.addEventListener("scroll", update);
    update();
    return () => { observer.disconnect(); board.removeEventListener("scroll", update); };
  }, []);
  const scroll = (direction: number) => {
    const board = frame.current?.querySelector<HTMLElement>('[data-test-class="canon-plan-lanes"]');
    if (board) board.scrollBy({ left: direction * board.clientWidth * 0.8 });
  };
  const ordinals = new Map(plan.works.map((epic, index) => [epic.id, index + 1]));
  return <Grid ref={frame} columns="1" gap="xs">
    {edges.overflow && <ButtonContainer size="xs" justify="end">
      <IconButton label={appCopy.canon.previousLanes} disabled={!edges.left} onClick={() => scroll(-1)}>
        <ArrowLeft size="xs" />
      </IconButton>
      <IconButton label={appCopy.canon.nextLanes} disabled={!edges.right} onClick={() => scroll(1)}>
        <ArrowRight size="xs" />
      </IconButton>
    </ButtonContainer>}
    <Box paddingX="md" paddingStart="none"><KanbanBoard scroll data-plan-id={plan.id} data-test-class="canon-plan-lanes">
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
  </KanbanBoard></Box>
  </Grid>;
}
