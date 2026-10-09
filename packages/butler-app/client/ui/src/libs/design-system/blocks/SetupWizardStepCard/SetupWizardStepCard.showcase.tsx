import { useState, type ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButlerThinkingMark } from "../../components/ButlerThinkingMark";
import { CheckIcon, Copy, Globe2, ShieldCheck, Sparkles } from "../../components/Icons";
import { IconSlot } from "../../components/IconSlot";
import { IconTile } from "../../components/IconTile";
import { Inline } from "../../components/Inline";
import { ProviderLogo } from "../../components/ProviderLogo";
import { Spinner } from "../../components/Spinner";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { Notice } from "../Notice";
import { SetupWizardContent, SetupWizardShell } from "../SetupWizardShell";
import { SetupWizardStepAction, SetupWizardStepCard } from "./SetupWizardStepCard";

export const meta: ShowcaseMeta = {
  title: "SetupWizardStepCard",
  category: "Shell",
  tags: ["setup", "first-run", "wizard", "step", "onboarding"],
  status: "beta",
};

const labels = {
  "en-US": {
    steps: ["Welcome", "Consent", "Connect AI", "Finish"], back: "Back", progress: "Setup steps",
    consentTitle: "Before you start", consentBody: "Butler can create, change and delete files and run commands on this computer.",
    ready: "Ready", decline: "Decline", agree: "Agree and continue",
    pickTitle: "Which AI should Butler work with?", pickBody: "Pick one to get started. You can change it later in Settings.",
    signInTitle: "Sign in to ChatGPT", signInBody: "Butler picks up automatically when you're done.",
    waiting: "Waiting for your browser", reopen: "Open browser again", copy: "Copy link", cancel: "Cancel",
    timedOut: "Sign-in timed out", timedOutBody: "No answer from the browser. Try again.", retry: "Try again",
    welcome: "Welcome to Butler", welcomeBody: "Butler works for you on this computer.", start: "Get started", next: "Next step",
  },
  "ko-KR": {
    steps: ["환영", "동의", "AI 연결", "마무리"], back: "이전", progress: "설정 단계",
    consentTitle: "시작하기 전에 확인해 주세요", consentBody: "버틀러는 이 컴퓨터에서 파일을 만들고, 수정하고, 삭제하고, 명령어를 실행할 수 있습니다.",
    ready: "준비됨", decline: "동의하지 않음", agree: "동의하고 계속",
    pickTitle: "어떤 AI와 일할까요?", pickBody: "하나만 고르면 바로 시작합니다. 나중에 설정에서 바꿀 수 있습니다.",
    signInTitle: "ChatGPT에 로그인하세요", signInBody: "로그인을 마치면 버틀러가 자동으로 이어갑니다.",
    waiting: "브라우저에서 기다리는 중", reopen: "브라우저 다시 열기", copy: "링크 복사", cancel: "취소",
    timedOut: "로그인 시간이 지났습니다", timedOutBody: "브라우저에서 응답이 없었습니다. 다시 시도하세요.", retry: "다시 시도",
    welcome: "반갑습니다", welcomeBody: "버틀러는 이 컴퓨터에서 일을 대신합니다.", start: "시작하기", next: "다음 단계",
  },
} as const;

type Copy = (typeof labels)[keyof typeof labels];
type Tone = "light" | "dark";

function steps(copy: Copy) {
  return copy.steps.map((label) => ({ id: label, label }));
}

function Prep({ copy }: { copy: Copy }) {
  return (
    <Inline cross="center" gap="xs" wrap={false}>
      <IconSlot size="sm"><CheckIcon size="sm" /></IconSlot>
      <Typo.Caption tone="success">{copy.ready}</Typo.Caption>
    </Inline>
  );
}

function Frame({ tone, children, stepKey }: { tone: Tone; children: ReactNode; stepKey?: string }) {
  return <SetupWizardShell anchor="top" embedded stepKey={stepKey} title="Butler" tone={tone} variant="focus">{children}</SetupWizardShell>;
}

function Consent({ copy }: { copy: Copy }) {
  return (
    <SetupWizardStepCard activeIndex={1} backLabel={copy.back} icon={<ShieldCheck size="lg" />} onBack={() => undefined}
      progressLabel={copy.progress} steps={steps(copy)} title={copy.consentTitle} footerStart={<Prep copy={copy} />}
      actions={<><SetupWizardStepAction text={copy.decline} /><SetupWizardStepAction forward text={copy.agree} /></>}>
      <Typo.Body>{copy.consentBody}</Typo.Body>
    </SetupWizardStepCard>
  );
}

function SignIn({ copy }: { copy: Copy }) {
  return (
    <SetupWizardStepCard activeIndex={2} backLabel={copy.back} description={copy.signInBody} icon={<ProviderLogo name="openai" size="lg" />}
      onBack={() => undefined} progressLabel={copy.progress} steps={steps(copy)} title={copy.signInTitle}
      actions={<SetupWizardStepAction text={copy.cancel} />}>
      <Notice tone="neutral" icon={<Spinner size={14} />} message={copy.waiting} action={(
        <Inline gap="md" wrap={false}>
          <Button iconStart={<Globe2 size="sm" />} size="sm" text={copy.reopen} variant="inline" />
          <Button iconStart={<Copy size="sm" />} size="sm" text={copy.copy} variant="inline" />
        </Inline>
      )} />
    </SetupWizardStepCard>
  );
}

function TimedOut({ copy }: { copy: Copy }) {
  return (
    <SetupWizardStepCard activeIndex={2} backLabel={copy.back} description={copy.timedOutBody} icon={<ProviderLogo name="openai" size="lg" />}
      onBack={() => undefined} progressLabel={copy.progress} steps={steps(copy)} title={copy.timedOut}
      actions={<SetupWizardStepAction forward text={copy.retry} />} />
  );
}

/** Intro (420) → steps (520): stepKey swaps the card; contentKey fades the body between steps. */
function FlowDemo({ copy, tone }: { copy: Copy; tone: Tone }) {
  const [index, setIndex] = useState(0);
  const next = () => setIndex((value) => (value + 1) % 4);
  const intro = (
    <SetupWizardContent surface="solid">
      <Stack cross="center" gap="md">
        <IconTile size="xl" tone="plain"><ButlerThinkingMark state="idle" /></IconTile>
        <Typo.H3 align="center" as="h1">{copy.welcome}</Typo.H3>
        <Typo.Body align="center" tone="secondary">{copy.welcomeBody}</Typo.Body>
      </Stack>
      <Button size="lg" stretch text={copy.start} onClick={next} />
    </SetupWizardContent>
  );
  const titles = [copy.consentTitle, copy.pickTitle, copy.signInTitle];
  const step = (
    <SetupWizardStepCard activeIndex={index} backLabel={copy.back} contentKey={String(index)} description={index === 2 ? copy.pickBody : undefined}
      icon={index === 1 ? <ShieldCheck size="lg" /> : <Sparkles size="lg" />} onBack={() => setIndex((value) => value - 1)}
      progressLabel={copy.progress} steps={steps(copy)} title={titles[index - 1] ?? copy.signInTitle}
      actions={<SetupWizardStepAction forward text={copy.next} onClick={next} />} />
  );
  return <Frame stepKey={index === 0 ? "intro" : "steps"} tone={tone}>{index === 0 ? intro : step}</Frame>;
}

function story(name: string, render: (copy: Copy, tone: Tone) => ReactNode): ShowcaseStory[] {
  return (["light", "dark"] as const).map((tone) => ({
    name: `${name} (${tone})`,
    widths: ["app", "wide"],
    render: (context: ShowcaseRenderContext) => <Frame tone={tone}>{render(labels[context.locale], tone)}</Frame>,
  }));
}

export const stories: ShowcaseStory[] = [
  ...story("Consent step", (copy) => <Consent copy={copy} />),
  ...story("Sign-in waiting (neutral notice)", (copy) => <SignIn copy={copy} />),
  ...story("Stopped step with retry", (copy) => <TimedOut copy={copy} />),
  { name: "Intro → steps transition (stepKey, contentKey)", widths: ["app", "wide"], render: (context) => <FlowDemo copy={labels[context.locale]} tone="light" /> },
];
