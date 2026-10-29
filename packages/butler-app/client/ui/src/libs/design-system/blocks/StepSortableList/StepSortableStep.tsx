import { useLayoutEffect, useRef, useState } from "react";
import { Card } from "../../components/Card";
import { Separator } from "../../components/Separator";
import { NavDropTarget } from "../NavDropTarget";
import { StackDeck } from "../StackDeck";
import { itemDragId, stepDragId, useStepSortableScope, type StepSortableRowContext } from "./stepSortableContext";
import { isDraggable, isPinnedStep, type StepSortableChain, type StepSortableItem } from "./stepSortableModel";
import { StepSortableRow } from "./StepSortableRow";
import { stepHeightKey } from "./useStepSortableDrag";
import styles from "./StepSortableList.module.css";

/** The accent line where a drop makes a new step ("새 단계"); follow-up steps indent it with them. */
export function StepSortableGap({ follow }: { follow: boolean }) {
  return (
    <li className={styles.gap} data-follow={follow || undefined} aria-hidden="true">
      <Separator tone="accent" space="none" decorative />
    </li>
  );
}

interface StepSortableStepProps {
  chain: StepSortableChain;
  step: readonly StepSortableItem[];
  stepIndex: number;
}

/**
 * One step: a single item's card, or a 묶음 as a StackDeck (collapsed: the whole step drags as
 * one; fanned: each card drags on its own, out of the 묶음). A pointer resting on the step for
 * the dwell rings it (NavDropTarget group) to join it. A lifted step stays in place at half
 * strength (`data-lifted`), all but its grip's focus ring.
 */
export function StepSortableStep({ chain, step, stepIndex }: StepSortableStepProps) {
  const scope = useStepSortableScope();
  const { view } = scope;
  const first = step[0]!;
  const joining = view.target?.kind === "join" && view.target.chainId === chain.id && view.target.stepIndex === stepIndex;
  const lifted = view.mode !== null && step.every((item) => view.itemIds.includes(item.id));
  const base: Omit<StepSortableRowContext, "expanded"> = {
    chainId: chain.id, stepIndex, stepNumber: stepIndex + 1, count: step.length, lifted: false, outcome: null,
  };
  const single = step.length === 1;
  // The ring keeps the height frozen at drag start; a static preview measures the step once.
  const frozen = scope.heights.get(stepHeightKey(chain.id, stepIndex));
  const element = useRef<HTMLLIElement | null>(null);
  const [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    if (joining && frozen === undefined && element.current) setMeasured(element.current.offsetHeight);
  }, [joining, frozen]);
  return (
    <li ref={element} className={styles.step} data-follow={stepIndex > 0 || undefined} data-step-chain={chain.id} data-step-index={stepIndex}
      data-step-items={step.map((item) => item.id).join(" ")} data-lifted={lifted || undefined}>
      <NavDropTarget drop={joining ? "group" : undefined} indicator={{ top: 0, height: frozen ?? measured }}>
        {single ? (
          <div data-step-card="">
            <Card padding="md" activity={first.running ? "running" : undefined} {...scope.cardListeners(itemDragId(first.id))}>
              <StepSortableRow item={first} context={{ ...base, expanded: false }}
                grip={{ dragId: itemDragId(first.id), label: first.label, movable: isDraggable(first) }} />
            </Card>
          </div>
        ) : (
          <StackDeck items={step} labels={scope.deckLabels} expanded={scope.fanned.has(first.id)}
            onExpandedChange={(open) => scope.setFanned(first.id, open)} interactive={view.mode === null}
            cardListeners={(item) => scope.cardListeners(item ? itemDragId(item.id) : stepDragId(first.id))}
            renderCard={(item, card) => card.expanded ? (
              <StepSortableRow item={item} context={{ ...base, expanded: true }} marker={card.index === 0}
                grip={{ dragId: itemDragId(item.id), label: item.label, movable: isDraggable(item) }} />
            ) : (
              <StepSortableRow item={item} context={{ ...base, expanded: false }}
                grip={{ dragId: stepDragId(first.id), label: scope.labels.stack(first.label, step.length), movable: !isPinnedStep(step) }} />
            )} />
        )}
      </NavDropTarget>
    </li>
  );
}
