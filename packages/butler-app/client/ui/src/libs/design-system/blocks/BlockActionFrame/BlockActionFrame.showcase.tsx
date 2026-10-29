import { useRef } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Copy, Library, FileText } from "../../components/Icons";
import { Inline } from "../../components/Inline";
import { Stack } from "../../components/Stack";
import { flySaveToTarget } from "../../lib/saveFlight";
import { BlockColumns } from "../BlockColumns";
import { KeyValueRow } from "../KeyValueRow";
import { MetricCard } from "../MetricCard";
import { BlockActionFrame } from "./BlockActionFrame";

export const meta: ShowcaseMeta = {
  title: "BlockActionFrame",
  category: "Conversation & Activity",
  tags: ["answer block", "menu", "long-press", "scrap", "motion"],
  status: "stable",
};

const labels = {
  "en-US": { save: "Save to library", doc: "Make a document", copy: "Copy", menu: "Block actions", spend: "Spending", plan: "Plan", family: "Family", seats: "Seats", seatsValue: "4 of 6", overview: "This month", library: "Library", saveNow: "Save" },
  "ko-KR": { save: "서랍에 저장", doc: "문서로 만들기", copy: "복사", menu: "블록 메뉴", spend: "지출", plan: "요금제", family: "가족", seats: "좌석", seatsValue: "6개 중 4개", overview: "이번 달", library: "서랍", saveNow: "저장" },
} as const;

function actions(context: ShowcaseRenderContext, onSave: () => void = () => undefined) {
  const copy = labels[context.locale];
  return [
    { label: copy.save, icon: <Library size="sm" />, onSelect: onSave },
    { label: copy.doc, icon: <FileText size="sm" />, onSelect: () => undefined },
    { label: copy.copy, icon: <Copy size="sm" />, onSelect: () => undefined },
  ];
}

function Container({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  return (
    <BlockActionFrame actions={actions(context)} actionsLabel={copy.menu} title={copy.overview}>
      <BlockColumns>
        <BlockActionFrame actions={actions(context)} actionsLabel={copy.menu} level="child" title={copy.spend}>
          <MetricCard label={copy.spend} value="₩1,240,000" change="+8%" trend="down" />
        </BlockActionFrame>
        <BlockActionFrame actions={actions(context)} actionsLabel={copy.menu} level="child">
          <Stack gap="xs"><KeyValueRow label={copy.plan} value={copy.family} /><KeyValueRow label={copy.seats} value={copy.seatsValue} /></Stack>
        </BlockActionFrame>
      </BlockColumns>
    </BlockActionFrame>
  );
}

function SaveFlight({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  const block = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLButtonElement>(null);
  const save = () => { if (block.current) flySaveToTarget(block.current, target.current); };
  return (
    <Stack gap="lg">
      <Inline><Button ref={target} size="sm" variant="ghost" iconStart={<Library size="sm" />}>{copy.library}</Button></Inline>
      <BlockActionFrame ref={block} actions={actions(context, save)} actionsLabel={copy.menu} title={copy.spend}>
        <MetricCard label={copy.spend} value="₩1,240,000" change="+8%" trend="down" />
      </BlockActionFrame>
      <Inline><Button size="sm" variant="outline" data-ds-motion="replay" onClick={save}>{copy.saveNow}</Button></Inline>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Block with a menu", states: ["hover", "focus-visible"], widths: ["375", "app"], render: (context) => <BlockActionFrame actions={actions(context)} actionsLabel={labels[context.locale].menu} title={labels[context.locale].spend}><MetricCard label={labels[context.locale].spend} value="₩1,240,000" /></BlockActionFrame> },
  { name: "Container and children", states: ["hover"], widths: ["375", "app", "wide"], render: (context) => <Container context={context} /> },
  { name: "Save flight", states: ["changing"], widths: ["app"], render: (context) => <SaveFlight context={context} /> },
];
