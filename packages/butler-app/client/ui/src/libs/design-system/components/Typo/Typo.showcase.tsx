import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Stack } from "../Stack";
import { Typo, type TypoTone, type TypoWeight } from "./Typo";

export const meta: ShowcaseMeta = {
  title: "Typo",
  category: "Data display",
  tags: ["typography", "text", "tone", "truncate", "tabular"],
  status: "stable",
};

const labels = {
  "en-US": {
    body: "Body text uses the Butler type scale.",
    caption: "Caption for metadata",
    label: "Field label",
    code: "bun run lint:ds",
    panelTitle: "Panel title",
    sectionTitle: "Section title",
    metric: "1,284",
    tone: {
      primary: "Primary text",
      secondary: "Secondary metadata",
      tertiary: "Tertiary hint",
      disabled: "Disabled option",
      danger: "The request failed",
      success: "Saved",
      warning: "Needs attention",
      inherit: "Inherits the container color",
    },
    weight: { regular: "Regular weight", medium: "Medium weight", semibold: "Semibold weight" },
    long: "Desktop client polish for the project dashboard, settings screens and the conversation footer",
    token: "https://example.com/projects/butler/specs/butler-dedicated-client-design-system/roadmap-step-4",
    inherited: "Typo.Text keeps the surrounding size",
    times: ["9:05 AM", "10:11 AM", "1:25 PM", "11:48 PM"],
    counts: ["1", "12", "128", "1,024"],
  },
  "ko-KR": {
    body: "본문은 Butler 타입 스케일을 사용합니다.",
    caption: "메타데이터 캡션",
    label: "필드 레이블",
    code: "bun run lint:ds",
    panelTitle: "패널 제목",
    sectionTitle: "섹션 제목",
    metric: "1,284",
    tone: {
      primary: "기본 텍스트",
      secondary: "보조 메타데이터",
      tertiary: "3차 힌트",
      disabled: "비활성 옵션",
      danger: "요청에 실패했습니다",
      success: "저장됨",
      warning: "확인이 필요합니다",
      inherit: "컨테이너 색을 이어받습니다",
    },
    weight: { regular: "보통 굵기", medium: "중간 굵기", semibold: "세미볼드 굵기" },
    long: "프로젝트 대시보드, 설정 화면과 대화 하단 정보를 다듬는 데스크톱 클라이언트 작업",
    token: "https://example.com/projects/butler/specs/butler-dedicated-client-design-system/roadmap-step-4",
    inherited: "Typo.Text는 주변 크기를 그대로 씁니다",
    times: ["오전 9:05", "오전 10:11", "오후 1:25", "오후 11:48"],
    counts: ["1", "12", "128", "1,024"],
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

const tones: TypoTone[] = ["primary", "secondary", "tertiary", "disabled", "danger", "success", "warning", "inherit"];
const weights: TypoWeight[] = ["regular", "medium", "semibold"];

export const stories: ShowcaseStory[] = [
  {
    name: "Variants",
    render: (context) => (
      <Stack gap="sm">
        <Typo.PanelTitle>{text(context).panelTitle}</Typo.PanelTitle>
        <Typo.SectionTitle>{text(context).sectionTitle}</Typo.SectionTitle>
        <Typo.Body>{text(context).body}</Typo.Body>
        <Typo.Label>{text(context).label}</Typo.Label>
        <Typo.Caption>{text(context).caption}</Typo.Caption>
        <Typo.Code>{text(context).code}</Typo.Code>
        <Typo.MetricValue numeric="tabular">{text(context).metric}</Typo.MetricValue>
      </Stack>
    ),
  },
  {
    name: "Tones",
    render: (context) => (
      <Stack gap="xs">
        {tones.map((tone) => (
          <Typo.Body key={tone} tone={tone}>{text(context).tone[tone]}</Typo.Body>
        ))}
      </Stack>
    ),
  },
  {
    name: "Weights",
    render: (context) => (
      <Stack gap="xs">
        {weights.map((weight) => (
          <Typo.Body key={weight} weight={weight}>{text(context).weight[weight]}</Typo.Body>
        ))}
      </Stack>
    ),
  },
  {
    name: "Truncate and clamp",
    widths: ["320", "375", "430"],
    render: (context) => (
      <Stack gap="md">
        <Typo.Body truncate title={text(context).long}>{text(context).long}</Typo.Body>
        <Typo.Body lineClamp={2}>{`${text(context).long}. ${text(context).long}`}</Typo.Body>
        <Typo.Caption lineClamp={3} tone="secondary">
          {`${text(context).long}. ${text(context).long}. ${text(context).long}`}
        </Typo.Caption>
      </Stack>
    ),
  },
  {
    name: "Wrapping",
    widths: ["320", "375"],
    render: (context) => (
      <Stack gap="md">
        <Typo.Caption wrap="nowrap" tone="secondary">{text(context).caption}</Typo.Caption>
        <Typo.Body wrap="anywhere">{text(context).token}</Typo.Body>
      </Stack>
    ),
  },
  {
    name: "Tabular numbers, end aligned",
    render: (context) => (
      <Stack gap="xs">
        {text(context).times.map((time, index) => (
          <Typo.Caption key={time} as="div" align="end" numeric="tabular" tone="secondary">
            {`${time} · ${text(context).counts[index]}`}
          </Typo.Caption>
        ))}
      </Stack>
    ),
  },
  {
    name: "Inherited text",
    render: (context) => (
      <Typo.Label>
        {text(context).label}{" · "}
        <Typo.Text tone="secondary" weight="regular">{text(context).inherited}</Typo.Text>
      </Typo.Label>
    ),
  },
  { // ProjectDescription (alignWith) and DeveloperLogRawBlock (as pre, wrap pre).
    name: "Beside a control and preformatted",
    render: () => (<Stack gap="md">
      <Typo.Body tone="secondary" wrap="anywhere" alignWith="control">alignWith=&quot;control&quot; centers the first line on a control.</Typo.Body>
      <Typo.Code as="pre" tone="primary" wrap="pre">{'{\n  "event": "turn.completed"\n}'}</Typo.Code>
    </Stack>),
  },
];
