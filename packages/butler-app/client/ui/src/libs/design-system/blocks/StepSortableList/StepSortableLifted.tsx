import { DragOverlay, type Modifier } from "@dnd-kit/core";
import { Box } from "../../components/Box";
import { Card } from "../../components/Card";
import { StackDeck } from "../StackDeck";
import { useStepSortableScope, type StepSortableRowContext } from "./stepSortableContext";
import { locateItem, type StepSortableChain } from "./stepSortableModel";
import { StepSortableRow } from "./StepSortableRow";
import styles from "./StepSortableList.module.css";

function pointerY(event: Event): number {
  if ("touches" in event) return ((event as TouchEvent).touches[0] ?? (event as TouchEvent).changedTouches[0])?.clientY ?? 0;
  return (event as MouseEvent).clientY ?? 0;
}

/** The lifted copy hangs --space-3xl below the pointer, so the target, its ring and the gap line stay in view. */
const belowPointer: Modifier = ({ transform, activatorEvent, activeNodeRect }) => {
  if (!activatorEvent || !activeNodeRect || activatorEvent instanceof KeyboardEvent) return transform;
  const gap = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-3xl")) || 0;
  return { ...transform, y: transform.y + (pointerY(activatorEvent) - activeNodeRect.top) + gap };
};

/**
 * The lifted copy: the dragged row itself at its size, on the opaque raised surface, with the
 * drag shadow; its caption can say what a drop does now (`outcome`). Portaled to <body> with the
 * list's theme class, so panels never clip it.
 */
export function StepSortableLifted({ chains, root }: { chains: readonly StepSortableChain[]; root: HTMLElement | null }) {
  const scope = useStepSortableScope();
  const { view } = scope;
  const at = view.mode === "pointer" && view.itemIds[0] ? locateItem(chains, view.itemIds[0]) : null;
  const chain = at ? chains[at.chainIndex] : undefined;
  const step = at && chain ? chain.steps[at.stepIndex]! : null;
  const theme = root?.closest(".theme-dark, .theme-light");
  const context: Omit<StepSortableRowContext, "expanded"> | null = at && chain && step ? {
    chainId: chain.id, stepIndex: at.stepIndex, stepNumber: at.stepIndex + 1, count: step.length, lifted: true,
    outcome: view.target ? (view.target.kind === "join" ? "join" : "new_step") : null,
  } : null;
  const whole = step !== null && view.itemIds.length === step.length && step.length > 1;
  const fanned = step !== null && step.length > 1 && !whole;
  const item = step?.find((candidate) => candidate.id === view.itemIds[0]);
  return (
    <div className={theme?.classList.contains("theme-dark") ? "theme-dark" : theme ? "theme-light" : undefined}>
      <DragOverlay dropAnimation={null} modifiers={[belowPointer]}>
        {context && step && item ? (
          <div className={styles.lifted}>
            <Box surface="raised-opaque" radius="control">
              {whole ? (
                <StackDeck items={step} interactive={false} renderCard={(entry) => (
                  <StepSortableRow item={entry} context={{ ...context, expanded: false }} grip={{ dragId: "", label: "", movable: true }} />
                )} />
              ) : (
                <Card padding="md" activity={item.running ? "running" : undefined}>
                  <StepSortableRow item={item} context={{ ...context, expanded: fanned }} grip={{ dragId: "", label: "", movable: true }} />
                </Card>
              )}
            </Box>
          </div>
        ) : null}
      </DragOverlay>
    </div>
  );
}
