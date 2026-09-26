import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { DisclosureRow } from "../../blocks/DisclosureRow";
import { Button } from "../Button";
import { Terminal } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Collapsible } from "./Collapsible";
import { CollapsibleList } from "./CollapsibleList";

export const meta: ShowcaseMeta = {
  title: "Collapsible",
  category: "Layout",
  tags: ["motion", "disclosure", "reveal", "expand", "collapse"],
  status: "beta",
};

const labels = {
  "en-US": {
    toggle: "Toggle details",
    body: "Height reveals to auto with interpolate-size, then the text fades in.",
    tool: "Ran bun test",
    output: "42 pass, 0 fail",
    add: "Insert row",
    remove: "Remove row",
    rows: ["Desktop client polish", "Weekly review", "Travel plan", "Reading list", "Budget check"],
  },
  "ko-KR": {
    toggle: "세부 정보 전환",
    body: "높이가 auto까지 부드럽게 열리고 텍스트가 서서히 나타납니다.",
    tool: "bun test 실행",
    output: "통과 42, 실패 0",
    add: "행 추가",
    remove: "행 삭제",
    rows: ["데스크톱 앱 다듬기", "주간 회고", "여행 계획", "읽을거리", "예산 점검"],
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function Reveal({ context }: { context: ShowcaseRenderContext }) {
  const [open, setOpen] = useState(false);
  return (
    <Stack gap="sm">
      <Button variant="outline" text={text(context).toggle} onClick={() => setOpen((value) => !value)} />
      <Collapsible open={open}>
        <Typo.Body>{text(context).body}</Typo.Body>
      </Collapsible>
    </Stack>
  );
}

function ToolRow({ context }: { context: ShowcaseRenderContext }) {
  const [open, setOpen] = useState(false);
  return (
    <DisclosureRow
      icon={<Terminal size="md" />}
      title={text(context).tool}
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      <Typo.Caption>{text(context).output}</Typo.Caption>
    </DisclosureRow>
  );
}

function RowList({ context }: { context: ShowcaseRenderContext }) {
  const all = text(context).rows;
  const [count, setCount] = useState(3);
  const [first, setFirst] = useState(0);
  const shown = all.slice(first, first + count);
  return (
    <Stack gap="sm">
      <Stack align="row" gap="sm">
        <Button variant="outline" data-ds-motion="insert" text={text(context).add}
          onClick={() => (first > 0 ? setFirst(first - 1) : setCount(Math.min(all.length, count + 1)))} />
        <Button variant="outline" data-ds-motion="remove" text={text(context).remove}
          onClick={() => { setFirst(Math.min(first + 1, all.length - 1)); setCount(Math.max(1, count - 1)); }} />
      </Stack>
      <Stack gap="xs">
        <CollapsibleList scope="rows">
          {shown.map((label) => <Typo.Body key={label}>{label}</Typo.Body>)}
        </CollapsibleList>
      </Stack>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  {
    // CollapsibleList: inserted rows reveal, removed rows fold away in place.
    name: "List insert and remove",
    states: ["insert", "remove"],
    render: (context) => <RowList context={context} />,
  },
  { name: "Reveal", states: ["expand", "collapse"], render: (context) => <Reveal context={context} /> },
  { name: "Tool row", states: ["expand", "collapse"], render: (context) => <ToolRow context={context} /> },
];
