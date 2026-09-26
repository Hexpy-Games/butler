import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { CollapsibleList } from "../../components/Collapsible";
import { Stack } from "../../components/Stack";
import { Briefcase, MessageSquare } from "../../components/Icons";
import { NavRow } from "../NavRow";
import { SidebarNav } from "../SidebarShell";
import { NavDropTarget, NavRootDropZone, type NavDropPosition } from "./NavDropTarget";

export const meta: ShowcaseMeta = {
  title: "NavDropTarget",
  category: "Navigation",
  tags: ["navigation", "sidebar", "drag", "drop", "reorder"],
  status: "stable",
};

const copy = {
  "en-US": { rows: ["Desktop client polish", "Weekly review", "Travel plan"], group: "Group together", root: "Move to space root" },
  "ko-KR": { rows: ["데스크톱 앱 다듬기", "주간 회고", "여행 계획"], group: "함께 묶기", root: "스페이스 최상위로 이동" },
} as const;

/** Header box of a 30px comfortable row, as the product measures it. */
const HEADER = { top: 0, height: 30 };

function Rows({ locale, drop, target = 1, dragging }: ShowcaseRenderContext & { drop?: NavDropPosition; target?: number; dragging?: number }) {
  const text = copy[locale];
  return (
    <SidebarNav ariaLabel="Rows">
      <CollapsibleList scope="rows">
      {text.rows.map((label, index) => (
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
    </SidebarNav>
  );
}

const SEQUENCE: Array<{ drop?: NavDropPosition; target: number }> = [
  { drop: "before", target: 1 },
  { drop: "inside", target: 0 },
  { drop: "after", target: 1 },
  { drop: undefined, target: 1 },
];

/** Steps through the drag states: rows slide apart, the folder lifts. */
function Sequence(context: ShowcaseRenderContext) {
  const [step, setStep] = useState(0);
  const { drop, target } = SEQUENCE[step % SEQUENCE.length]!;
  return (
    <Stack gap="sm">
      <Button variant="outline" data-ds-motion="step" text={drop ?? "rest"} onClick={() => setStep(step + 1)} />
      <Rows {...context} drop={drop} target={target} dragging={2} />
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Drag sequence (slide aside, lift)", states: ["drag"], render: (context) => <Sequence {...context} /> },
  { name: "Insert before", render: (context) => <Rows {...context} drop="before" dragging={2} /> },
  { name: "Insert after", render: (context) => <Rows {...context} drop="after" dragging={2} /> },
  { name: "Drop inside a folder", render: (context) => <Rows {...context} target={0} drop="inside" dragging={2} /> },
  { name: "Group two conversations", render: (context) => <Rows {...context} drop="group" dragging={2} /> },
  {
    name: "Root drop zone",
    states: ["active"],
    render: ({ locale }) => <NavRootDropZone active>{copy[locale].root}</NavRootDropZone>,
  },
];
