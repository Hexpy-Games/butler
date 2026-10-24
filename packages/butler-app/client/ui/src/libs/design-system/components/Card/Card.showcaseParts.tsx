import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../Button";
import { ButtonContainer } from "../ButtonContainer";
import { Flag, ICON_SIZE } from "../Icons";
import { IconSlot } from "../IconSlot";
import { LoadingIndicator } from "../LoadingIndicator";
import { Tag } from "../Tag";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Card } from "./Card";

const labels = {
  "en-US": {
    control: "radius control · 8px · an item in a grid",
    lg: "radius lg · 12px · as wide as the conversation column",
    draftLabel: "Epic draft · Butler",
    draftTitle: "Fix the shortcut clash in the composer",
    draftBody: "Cmd+K opens search while the composer has focus. Keep the composer shortcut and move search to Cmd+Shift+K.",
    cancel: "Cancel",
    add: "Add",
  },
  "ko-KR": {
    control: "radius control · 8px · 격자 속 항목",
    lg: "radius lg · 12px · 대화 열 너비",
    draftLabel: "과제 초안 · 버틀러",
    draftTitle: "입력창 단축키 충돌 고치기",
    draftBody: "입력창에 포커스가 있을 때 Cmd+K가 검색을 엽니다. 입력창 단축키를 유지하고 검색은 Cmd+Shift+K로 옮깁니다.",
    cancel: "취소",
    add: "등록",
  },
} as const;

/** Default and lg side by side, then a column-wide epic draft: icon + small label, title, body, actions. */
export function RadiusStory({ locale }: ShowcaseRenderContext) {
  const copy = labels[locale];
  return (
    <Stack gap="md">
      <Card><Typo.Caption>{copy.control}</Typo.Caption></Card>
      <Card radius="lg"><Typo.Caption>{copy.lg}</Typo.Caption></Card>
      <Card radius="lg">
        <Stack gap="md">
          <Stack align="row" cross="center" gap="xs"><Flag size="sm" aria-hidden="true" /><Typo.Caption tone="secondary">{copy.draftLabel}</Typo.Caption></Stack>
          <Stack gap="sm">
            <Typo.PanelTitle as="h3" wrap="anywhere">{copy.draftTitle}</Typo.PanelTitle>
            <Typo.Body>{copy.draftBody}</Typo.Body>
          </Stack>
          <ButtonContainer size="sm" justify="end">
            <Button size="sm" variant="ghost" text={copy.cancel} />
            <Button size="sm" text={copy.add} />
          </ButtonContainer>
        </Stack>
      </Card>
    </Stack>
  );
}

/** Task graph card: a running task carries activity="running"; a finished one does not. */
export function TaskCard({ item, running, selected }: { item: { title: string; meta: string; status: string; time: string }; running?: boolean; selected?: boolean }) {
  return (
    <Card interactive padding="sm" selected={selected} activity={running ? "running" : undefined} aria-label={item.title} onClick={() => undefined}>
      <Stack gap="xs">
        <Stack align="row" gap="sm" cross="start">
          <IconSlot size="md" minHeight="line" tone="tertiary">
            <LoadingIndicator state={running ? "loading" : "done"} size={ICON_SIZE.md} />
          </IconSlot>
          <Typo.Body lineClamp={2} grow minWidth="0">{item.title}</Typo.Body>
        </Stack>
        <Typo.Caption tone="tertiary" truncate>{item.meta}</Typo.Caption>
        <Stack align="row" justify="between" cross="center" gap="sm">
          <Tag size="sm" tone={running ? "accent" : "neutral"}>{item.status}</Tag>
          <Typo.Caption tone="tertiary" numeric="tabular">{item.time}</Typo.Caption>
        </Stack>
      </Stack>
    </Card>
  );
}
