import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { ButtonContainer } from "../ButtonContainer";
import { Field, FieldDescription, FieldLabel } from "../Field";
import { Stack } from "../Stack";
import { Textarea } from "./Textarea";

export const meta: ShowcaseMeta = {
  title: "Textarea",
  category: "Input",
  tags: ["form", "long-text", "settings", "personalization"],
  status: "stable",
};

const labels = {
  "en-US": {
    persona: "Persona",
    personaValue: "Direct and calm. Explain trade-offs briefly, ask before destructive changes, and keep replies in the user's language.",
    personaHint: "How Butler presents itself and works with you",
    args: "Arguments", argsHint: "One per line", argsValue: "--stdio\n--read-only",
    description: "Project description", descriptionValue: "Butler desktop app: Electron shell, React UI and the Rust agent gateway.",
    cancel: "Cancel", save: "Save", prompt: "Migration prompt",
  },
  "ko-KR": {
    persona: "페르소나",
    personaValue: "차분하고 직설적으로 말합니다. 장단점은 짧게 설명하고, 되돌릴 수 없는 변경 전에는 먼저 묻고, 사용자의 언어로 답합니다.",
    personaHint: "버틀러가 자신을 표현하고 사용자와 협업하는 방식",
    args: "인자", argsHint: "한 줄에 하나씩 입력", argsValue: "--stdio\n--read-only",
    description: "프로젝트 설명", descriptionValue: "버틀러 데스크톱 앱: Electron 셸, React UI, Rust 에이전트 게이트웨이.",
    cancel: "취소", save: "저장", prompt: "마이그레이션 프롬프트",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Personalization field",
    render: (context) => (
      <Field>
        <FieldLabel htmlFor="ds-textarea-persona">{text(context).persona}</FieldLabel>
        <Textarea id="ds-textarea-persona" defaultValue={text(context).personaValue} />
        <FieldDescription>{text(context).personaHint}</FieldDescription>
      </Field>
    ),
  },
  {
    name: "Placeholder (MCP arguments)",
    render: (context) => (
      <Field>
        <FieldLabel htmlFor="ds-textarea-args">{text(context).args}</FieldLabel>
        <Textarea id="ds-textarea-args" placeholder={text(context).argsHint} />
      </Field>
    ),
  },
  {
    name: "Inline edit (project description)",
    widths: ["375", "app"],
    render: (context) => (
      <Stack gap="sm">
        <Textarea aria-label={text(context).description} defaultValue={text(context).descriptionValue} maxLength={2000} />
        <ButtonContainer size="sm">
          <Button size="sm" variant="borderless" text={text(context).cancel} />
          <Button size="sm" text={text(context).save} />
        </ButtonContainer>
      </Stack>
    ),
  },
  {
    name: "Read-only and disabled",
    states: ["read-only", "disabled"],
    render: (context) => (
      <Stack gap="sm">
        <Textarea aria-label={text(context).prompt} rows={4} readOnly value={text(context).argsValue} />
        <Textarea aria-label={text(context).persona} disabled value={text(context).personaValue} />
      </Stack>
    ),
  },
  {
    name: "Underline · wrapping in-place entry",
    widths: ["375", "app"],
    render: (context) => <Textarea variant="underline" textSize="label" aria-label={text(context).description} placeholder={text(context).description} />,
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "disabled", "invalid", "read-only"],
  variants: ["default", "underline"],
  render: (context) => (
    <Textarea
      variant={context.variant === "underline" ? "underline" : "default"}
      readOnly={context.state === "read-only"}
      aria-invalid={context.state === "invalid" ? "true" : undefined}
      aria-label={text(context).args}
      defaultValue={text(context).argsValue}
      disabled={context.state === "disabled"}
      rows={3}
    />
  ),
};
