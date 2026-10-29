import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Blocks, CircleAlert, Eye, ICON_SIZE, Minus, Play, Trash2 } from "../../components/Icons";
import { LoadingIndicator } from "../../components/LoadingIndicator";
import { Typo } from "../../components/Typo";
import { OverflowActionMenu } from "../OverflowActionMenu";
import type { StepSortableRowContext, StepSortableRowSlots } from "./stepSortableContext";
import { applyStepSortableEdit, type StepSortableChain, type StepSortableTarget } from "./stepSortableModel";
import { StepSortableList } from "./StepSortableList";
import { demoChains, KO_DECK_LABELS, KO_STEP_LABELS, STEP_DEMO_COPY, type DemoShape, type DemoStatus, type DemoTask } from "./StepSortableList.fixtures";

/** Heads show their status glyph; follow-up steps their number in the chain. */
function Marker({ status, number }: { status: DemoStatus; number?: number }) {
  if (number !== undefined) return <Typo.Label tone="tertiary" numeric="tabular">{number}</Typo.Label>;
  if (status === "running") return <LoadingIndicator state="loading" size={ICON_SIZE.md} />;
  if (status === "done") return <LoadingIndicator state="done" size={ICON_SIZE.md} />;
  if (status === "review") return <Eye size="md" />;
  if (status === "failed") return <Typo.Text tone="danger"><CircleAlert size="md" /></Typo.Text>;
  return <Minus size="md" />;
}

type DemoCopy = (typeof STEP_DEMO_COPY)[keyof typeof STEP_DEMO_COPY];

/** One line about the row's own state (the meta already says the status word): progress, result, why it waits or pauses. */
function stateCaption(copy: DemoCopy, task: DemoTask, before: DemoTask | null): string {
  if (task.progress) return task.progress;
  if (task.result) return task.result;
  if (task.status === "held") return before?.status === "held" ? copy.pausedBefore : copy.pausedByYou;
  return before ? copy.after(before.label) : copy.notStarted;
}

/** The work-tab row content: what a product container maps its tasks to. */
function rowSlots(context: ShowcaseRenderContext, chains: readonly StepSortableChain<DemoTask>[]) {
  const copy = STEP_DEMO_COPY[context.locale];
  return (task: DemoTask, place: StepSortableRowContext): StepSortableRowSlots => {
    const chain = chains.find((candidate) => candidate.id === place.chainId)!;
    const head = place.stepIndex === 0;
    const live = task.status === "running" || task.status === "review";
    const before = head ? null : chain.steps[place.stepIndex - 1]![0]! as DemoTask;
    const caption = place.lifted && place.outcome ? (place.outcome === "join" ? copy.join : copy.newStep) : stateCaption(copy, task, before);
    const front = place.count > 1 && !place.expanded;
    const [start, unstack, remove] = copy.menu;
    return {
      marker: <Marker status={task.status} number={head ? undefined : place.stepIndex} />,
      title: task.label,
      more: front ? copy.more(place.count - 1) : undefined,
      meta: live && task.time ? `${copy.status[task.status]} · ${task.time}` : copy.status[task.status],
      caption,
      trailing: task.running ? undefined : (
        <OverflowActionMenu label={copy.menuLabel(task.label)} items={[
          { icon: <Play size="sm" />, label: start, onSelect: () => undefined },
          ...(place.count > 1 ? [{ icon: <Blocks size="sm" />, label: unstack, onSelect: () => undefined }] : []),
          { icon: <Trash2 size="sm" />, label: remove, variant: "destructive" as const, onSelect: () => undefined },
        ]} />
      ),
    };
  };
}

/** A live list: drags and keyboard moves apply their edits at once (applyStepSortableEdit). */
export function StepListDemo({ context, shape, preview }: {
  context: ShowcaseRenderContext; shape: DemoShape; preview?: { itemIds: string[]; target: StepSortableTarget };
}) {
  const [chains, setChains] = useState(() => demoChains(context.locale, shape));
  const ko = context.locale === "ko-KR";
  return (
    <StepSortableList chains={chains} renderItem={rowSlots(context, chains)} dragPreview={preview}
      onEdit={(edit) => setChains((current) => applyStepSortableEdit(current, edit))}
      labels={ko ? KO_STEP_LABELS : undefined} deckLabels={ko ? KO_DECK_LABELS : undefined} />
  );
}
