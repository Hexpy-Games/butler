import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Plus, Sparkles } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { PillButton } from "./PillButton";

export const meta: ShowcaseMeta = {
  title: "PillButton",
  category: "Action",
  tags: ["action", "composer", "pill", "glass", "capsule"],
  status: "stable",
};

const labels = {
  "en-US": {
    report: "Preparing report: Q3 release retro",
    task: "Migrate settings pages", activity: "Editing SettingsSection", progress: "2/4",
    attach: "Add context", stretch: "Stretched capsule fills its row",
    chips: [["All", 14], ["Travel", 5], ["Recipes", 2], ["Gift ideas", 0]] as const, newGroup: "New group",
  },
  "ko-KR": {
    report: "보고서 준비 중: 3분기 릴리스 회고",
    task: "설정 페이지 이전", activity: "SettingsSection 편집 중", progress: "2/4",
    attach: "맥락 추가", stretch: "늘어난 캡슐은 행을 채웁니다",
    chips: [["전체", 14], ["여행", 5], ["레시피", 2], ["선물 아이디어", 0]] as const, newGroup: "새 그룹",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** Steward progress capsule above the composer: task · activity · progress. */
function ProgressCapsule({ context, disabled }: { context: ShowcaseRenderContext; disabled?: boolean }) {
  const copy = text(context);
  return (
    <PillButton surface="glass" icon={<Sparkles size="md" />} disabled={disabled} title={copy.task} onClick={() => undefined}>
      <Stack align="row" as="span" cross="center" gap="xs" minWidth="0">
        <Typo.Text truncate>{copy.task}</Typo.Text>
        <Typo.Text aria-hidden="true" tone="tertiary" wrap="nowrap">·</Typo.Text>
        <Typo.Text tone="secondary" truncate>{copy.activity}</Typo.Text>
        <Typo.Text aria-hidden="true" tone="tertiary" wrap="nowrap">·</Typo.Text>
        <Typo.Text tone="secondary" wrap="nowrap">{copy.progress}</Typo.Text>
      </Stack>
    </PillButton>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Plain",
    render: (context) => <PillButton icon={<Plus size="md" />} onClick={() => undefined}>{text(context).attach}</PillButton>,
  },
  {
    name: "Glass capsules (composer)",
    widths: ["375", "app"],
    render: (context) => (
      <Stack align="row" gap="sm" justify="center" wrap>
        <PillButton surface="glass" icon={<Sparkles size="md" />} title={text(context).report} onClick={() => undefined}>
          {text(context).report}
        </PillButton>
        <ProgressCapsule context={context} />
      </Stack>
    ),
  },
  {
    // A row of group chips: the chosen one is pressed, a drag over one shows the drop ring.
    name: "Chips: pressed, count, drop target",
    widths: ["375", "app"],
    render: (context) => (
      <Stack align="row" gap="xs" wrap>
        {text(context).chips.map(([name, count], index) => (
          <PillButton key={name} pressed={index === 1} drop={index === 2} count={count || undefined} onClick={() => undefined}>{name}</PillButton>
        ))}
        <PillButton icon={<Plus size="sm" />} onClick={() => undefined}>{text(context).newGroup}</PillButton>
      </Stack>
    ),
  },
  {
    name: "Stretch",
    render: (context) => <PillButton stretch icon={<Plus size="md" />}>{text(context).stretch}</PillButton>,
  },
  {
    name: "Disabled (report not ready)",
    states: ["disabled"],
    render: (context) => (
      <PillButton disabled surface="glass" icon={<Sparkles size="md" />}>{text(context).report}</PillButton>
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active", "disabled"],
  variants: ["plain", "glass", "pressed chip", "drop target"],
  render: (context) => context.variant === "glass"
    ? <ProgressCapsule context={context} disabled={context.state === "disabled"} />
    : context.variant === "plain"
      ? <PillButton disabled={context.state === "disabled"} icon={<Plus size="md" />}>{text(context).attach}</PillButton>
      : <PillButton disabled={context.state === "disabled"} pressed={context.variant === "pressed chip"} drop={context.variant === "drop target"} count={5}>{text(context).chips[1][0]}</PillButton>,
};
