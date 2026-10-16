import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { ComposerControl } from "../../blocks/ComposerControl";
import { SettingsField, SettingsFieldScopeProvider } from "../../blocks/SettingsField";
import { Box } from "../Box";
import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { AiChip, PanelRight } from "../Icons";
import { SegmentedControl } from "../SegmentedControl";
import { Space } from "../Space";
import { Stack } from "../Stack";
import { Switch } from "../Switch";
import { Typo } from "../Typo";
import { Tooltip, type TooltipAlign, type TooltipSide } from "./Tooltip";

export const meta: ShowcaseMeta = {
  title: "Tooltip",
  category: "Overlay",
  tags: ["help", "accessibility", "glass", "motion", "placement"],
  status: "stable",
};

const labels = {
  "en-US": {
    hint: "Hover for 650ms or focus with the keyboard. Tooltips name controls; they never hold actions.",
    model: "Model", modelHint: "Switch models after this response finishes", panel: "Show right panel",
    shortcut: "Copy link", long: "Opens the project dashboard in the right panel and keeps the conversation in place",
    side: "Side", align: "Align", trigger: "Trigger", placed: "Opens here",
    sides: { top: "Top", right: "Right", bottom: "Bottom", left: "Left" },
    aligns: { start: "Start", center: "Center", end: "End" },
    placementHint: "Shown open here. Without room it flips to the other side and shifts to stay on screen.",
    sandbox: "Command sandbox", sandboxHint: "Runs commands that change files in an isolated environment.",
    unavailable: "Not available on this device",
    fieldHint: "A disabled reason opens to the right, clear of the label and description above the control.",
  },
  "ko-KR": {
    hint: "650ms 동안 올려 두거나 키보드로 포커스하세요. 툴팁은 컨트롤 이름만 보여 주며 동작을 담지 않습니다.",
    model: "모델", modelHint: "이 응답이 끝난 뒤 모델을 바꿀 수 있습니다", panel: "오른쪽 패널 보기",
    shortcut: "링크 복사", long: "대화를 그대로 둔 채 오른쪽 패널에서 프로젝트 대시보드를 엽니다",
    side: "방향", align: "정렬", trigger: "기준", placed: "여기에 열림",
    sides: { top: "위", right: "오른쪽", bottom: "아래", left: "왼쪽" },
    aligns: { start: "시작", center: "가운데", end: "끝" },
    placementHint: "여기서는 열린 채로 보입니다. 자리가 없으면 반대쪽으로 넘어가고 화면 안으로 밀려 들어옵니다.",
    sandbox: "명령 격리", sandboxHint: "파일을 바꾸는 명령을 격리된 환경에서 실행합니다.",
    unavailable: "이 기기에서는 사용할 수 없습니다",
    fieldHint: "사용할 수 없는 이유는 컨트롤 오른쪽에 열려 위의 이름과 설명을 가리지 않습니다.",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

const SIDES: TooltipSide[] = ["top", "right", "bottom", "left"];
const ALIGNS: TooltipAlign[] = ["start", "center", "end"];

/** Every side × align, open, around one trigger. */
function Placement({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  const [side, setSide] = useState<TooltipSide>("top");
  const [align, setAlign] = useState<TooltipAlign>("start");
  return (
    <Stack gap="2xl">
      <Stack align="row" wrap gap="md">
        <SegmentedControl ariaLabel={copy.side} size="sm" value={side} onValueChange={(value) => setSide(value as TooltipSide)}
          options={SIDES.map((value) => ({ value, label: copy.sides[value] }))} />
        <SegmentedControl ariaLabel={copy.align} size="sm" value={align} onValueChange={(value) => setAlign(value as TooltipAlign)}
          options={ALIGNS.map((value) => ({ value, label: copy.aligns[value] }))} />
      </Stack>
      <Box paddingX="md" radius="panel" border="hairline">
        <Space size="2xl" />
        <Space size="2xl" />
        <Stack align="row" justify="center">
          <Tooltip label={`${copy.placed}: ${copy.sides[side]} · ${copy.aligns[align]}`} side={side} align={align} open>
            <Button variant="outline" size="sm" text={copy.trigger} />
          </Tooltip>
        </Stack>
        <Space size="2xl" />
        <Space size="2xl" />
      </Box>
      <Typo.Caption tone="secondary">{copy.placementHint}</Typo.Caption>
    </Stack>
  );
}

/** What Switch disabledReason does in a stacked SettingsField, shown open. */
function ReasonBesideField({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  return (
    <Stack gap="md">
      <SettingsFieldScopeProvider>
        <SettingsField id={`tooltip-sandbox-${context.locale}`} label={copy.sandbox} description={copy.sandboxHint}
          control={(
            <Tooltip label={copy.unavailable} side="right" open>
              <Switch id={`tooltip-sandbox-${context.locale}`} checked={false} disabled />
            </Tooltip>
          )} />
      </SettingsFieldScopeProvider>
      <Typo.Caption tone="secondary">{copy.fieldHint}</Typo.Caption>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Icon button label",
    states: ["hover", "focus-visible"],
    render: (context) => (
      <Stack gap="sm">
        {/* IconButton wraps itself in Tooltip with its label. */}
        <IconButton label={text(context).panel}><PanelRight size="md" /></IconButton>
        <Typo.Caption tone="secondary">{text(context).hint}</Typo.Caption>
      </Stack>
    ),
  },
  { name: "Placement: side and align", render: (context) => <Placement context={context} /> },
  { name: "Disabled reason beside a settings control", render: (context) => <ReasonBesideField context={context} /> },
  {
    // ComposerModelStatusButton: a disabled control explains itself on hover.
    name: "Why a control is unavailable",
    render: (context) => (
      <Tooltip label={text(context).modelHint}>
        <ComposerControl aria-disabled="true" aria-label={`${text(context).model}. ${text(context).modelHint}`}
          icon={<AiChip size="sm" />} label={text(context).model} />
      </Tooltip>
    ),
  },
  {
    name: "Long label wraps inside the viewport",
    render: (context) => (
      <Tooltip label={text(context).long}>
        <Button variant="outline" size="sm" text={text(context).shortcut} />
      </Tooltip>
    ),
  },
];
