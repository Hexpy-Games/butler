import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { DisclosureRow } from "../../blocks/DisclosureRow";
import { Button } from "../Button";
import { Terminal } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Collapsible } from "./Collapsible";

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
  },
  "ko-KR": {
    toggle: "세부 정보 전환",
    body: "높이가 auto까지 부드럽게 열리고 텍스트가 서서히 나타납니다.",
    tool: "bun test 실행",
    output: "통과 42, 실패 0",
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

export const stories: ShowcaseStory[] = [
  { name: "Reveal", states: ["expand", "collapse"], render: (context) => <Reveal context={context} /> },
  { name: "Tool row", states: ["expand", "collapse"], render: (context) => <ToolRow context={context} /> },
];
