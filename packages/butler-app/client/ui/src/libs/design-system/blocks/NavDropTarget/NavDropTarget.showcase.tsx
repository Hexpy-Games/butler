import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { CollapsibleList } from "../../components/Collapsible";
import { Stack } from "../../components/Stack";
import { Briefcase, MessageSquare } from "../../components/Icons";
import { NavRow } from "../NavRow";
import { NavDropScope, NavDropTarget, NavRootDropZone, type NavDropPosition } from "./NavDropTarget";
import { InteractiveDropDemo } from "./NavDropTarget.demo";

export const meta: ShowcaseMeta = {
  title: "NavDropTarget",
  category: "Navigation",
  tags: ["navigation", "sidebar", "drag", "drop", "reorder", "group"],
  status: "stable",
};

const copy = {
  "en-US": {
    rows: ["Desktop client polish", "Weekly review", "Travel plan", "Reading list", "Release notes"],
    group: "Group together", root: "Move to space root", step: "Next state", grouped: "Grouped with",
  },
  "ko-KR": {
    rows: ["데스크톱 앱 다듬기", "주간 회고", "여행 계획", "읽을거리", "릴리스 노트"],
    group: "함께 묶기", root: "스페이스 최상위로 이동", step: "다음 상태", grouped: "함께 묶음:",
  },
} as const;

/** Header box of a 30px comfortable row, as the product measures it. */
const HEADER = { top: 0, height: 30 };

function Rows({ locale, drop, target = 1, dragging }: ShowcaseRenderContext & { drop?: NavDropPosition; target?: number; dragging?: number }) {
  const text = copy[locale];
  return (
    <NavDropScope active aria-label="Rows">
      <CollapsibleList scope="rows">
        {text.rows.slice(0, 4).map((label, index) => (
          <NavDropTarget
            key={label}
            drop={index === target ? drop : undefined}
            dragging={index === dragging}
            indicator={HEADER}
            hint={text.group}
          >
            <NavRow icon={index === 0 ? <Briefcase /> : <MessageSquare />} label={label} onClick={() => undefined} />
          </NavDropTarget>
        ))}
      </CollapsibleList>
    </NavDropScope>
  );
}

const SEQUENCE: Array<{ drop?: NavDropPosition; target: number }> = [
  { drop: "before", target: 1 },
  { drop: "group", target: 1 },
  { drop: "after", target: 1 },
  { drop: "inside", target: 0 },
  { drop: undefined, target: 1 },
];

/** Steps through the drag states: a slot opens, the group ring replaces it, the slot moves. */
function Sequence(context: ShowcaseRenderContext) {
  const [step, setStep] = useState(0);
  const { drop, target } = SEQUENCE[step % SEQUENCE.length]!;
  return (
    <Stack gap="sm">
      <Button variant="outline" data-ds-motion="step" text={`${copy[context.locale].step}: ${drop ?? "rest"}`} onClick={() => setStep(step + 1)} />
      <Rows {...context} drop={drop} target={target} dragging={3} />
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Drag and drop (interactive)", states: ["drag", "insert", "group"], render: ({ locale }) => <InteractiveDropDemo labels={copy[locale].rows} groupHint={copy[locale].group} groupedWith={copy[locale].grouped} /> },
  { name: "Drag sequence (slot, ring)", states: ["drag"], render: (context) => <Sequence {...context} /> },
  { name: "Insert before", render: (context) => <Rows {...context} drop="before" dragging={3} /> },
  { name: "Insert after", render: (context) => <Rows {...context} drop="after" dragging={3} /> },
  { name: "Drop inside a folder", render: (context) => <Rows {...context} target={0} drop="inside" dragging={3} /> },
  { name: "Group two conversations", render: (context) => <Rows {...context} drop="group" dragging={3} /> },
  {
    name: "Root drop zone",
    states: ["active"],
    render: ({ locale }) => <NavRootDropZone active>{copy[locale].root}</NavRootDropZone>,
  },
];
