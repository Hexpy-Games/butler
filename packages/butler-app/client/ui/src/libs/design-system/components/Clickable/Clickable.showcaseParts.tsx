import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { ProgressMeter } from "../../blocks/ProgressMeter";
import { SettingsSection } from "../../blocks/SettingsSection";
import { Box } from "../Box";
import { Pencil } from "../Icons";
import { Inline } from "../Inline";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Clickable } from "./Clickable";

const labels = {
  "en-US": {
    usage: "Usage",
    chats: "Top chats",
    editTitle: "Edit title",
    editDescription: "Edit description",
    task: "Tidy the release notes",
    description: "Collect the changes and review the release notes.",
    shares: [
      { title: "Release checklist", description: "Chat · 2h ago", value: "412K", share: 46 },
      { title: "Weekly dependency audit", description: "Schedule · yesterday", value: "268K", share: 30 },
      { title: "Design review notes", description: "Chat · Mon", value: "121K", share: 14 },
    ],
  },
  "ko-KR": {
    usage: "사용량",
    chats: "많이 쓴 대화",
    editTitle: "제목 수정",
    editDescription: "설명 편집",
    task: "릴리스 노트 정리",
    description: "변경 사항을 모아 릴리스 노트를 검토합니다.",
    shares: [
      { title: "릴리스 체크리스트", description: "대화 · 2시간 전", value: "412K", share: 46 },
      { title: "주간 의존성 점검", description: "예약 작업 · 어제", value: "268K", share: 30 },
      { title: "디자인 검토 메모", description: "대화 · 월", value: "121K", share: 14 },
    ],
  },
} as const;

type Share = (typeof labels)[keyof typeof labels]["shares"][number];

/** First share title, for the states matrix toggle row. */
export function toggleRowTitle({ locale }: ShowcaseRenderContext): string {
  return labels[locale].shares[0].title;
}

/** Usage breakdown row (settings UsageBreakdown): a toggle that bleeds into the card gutter. */
function ShareRow({ share, selected, onToggle }: { share: Share; selected: boolean; onToggle: () => void }) {
  return (
    <Clickable bleed="inline" stretch selected={selected} onClick={onToggle}>
      <Box paddingY="sm" grow minWidth="0">
        <Stack gap="xs">
          <Inline justify="between" cross="start" wrap={false}>
            <Stack gap="xs" grow minWidth="0">
              <Typo.Body tone="primary" truncate>{share.title}</Typo.Body>
              <Typo.Caption>{share.description}</Typo.Caption>
            </Stack>
            <Stack gap="xs" cross="end">
              <Typo.Body tone="primary" numeric="tabular">{share.value}</Typo.Body>
              <Typo.Caption numeric="tabular">{`${share.share}%`}</Typo.Caption>
            </Stack>
          </Inline>
          <ProgressMeter bare value={share.share} ariaLabel={`${share.title}: ${share.share}%`} />
        </Stack>
      </Box>
    </Clickable>
  );
}

/** Toggle rows in a settings card: row text lines up with the label above; fills reach into the gutter. */
export function ToggleRows({ context }: { context: ShowcaseRenderContext }) {
  const text = labels[context.locale];
  const [selected, setSelected] = useState<string | null>(text.shares[0].title);
  return (
    <SettingsSection id="clickable-usage" kind="status" title={text.usage}>
      <Stack gap="xs">
        <Typo.Label tone="secondary">{text.chats}</Typo.Label>
        {text.shares.map((share) => (
          <ShareRow key={share.title} share={share} selected={selected === share.title}
            onToggle={() => setSelected(selected === share.title ? null : share.title)} />
        ))}
      </Stack>
    </SettingsSection>
  );
}

/** Inline-editable title and description (canon 과제 detail): the fills get room above and below, the text stays put. */
export function EditableFields({ context }: { context: ShowcaseRenderContext }) {
  const text = labels[context.locale];
  return (
    <Box padding="md">
      <Stack gap="lg">
        <Clickable bleed="both" stretch aria-label={text.editTitle} onClick={() => undefined}>
          <Stack inline align="row" cross="center" gap="xs" minWidth="0">
            <Typo.PanelTitle as="h3" wrap="anywhere">{text.task}</Typo.PanelTitle>
            <Pencil size="sm" />
          </Stack>
        </Clickable>
        <Clickable bleed="both" stretch aria-label={text.editDescription} onClick={() => undefined}>
          <Typo.Body wrap="anywhere">{text.description}</Typo.Body>
        </Clickable>
      </Stack>
    </Box>
  );
}
