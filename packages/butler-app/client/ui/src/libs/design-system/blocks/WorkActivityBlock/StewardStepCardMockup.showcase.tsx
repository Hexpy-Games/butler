import { useId, useState } from "react";
import { ButtonContainer, Eye, IconButton, ProgressMeter, Stack, SurfacePanel, Typo, WorkActivityDisclosure } from "@/butler-ds";
import type { ShowcaseStory } from "../../showcase";
import { mockupCopy, mockupSteps, type MockupLocale, type MockupOption } from "./StewardStepCardMockupData.showcase";
import { StewardStepCardMockupDetails } from "./StewardStepCardMockupDetails.showcase";

type CardProps = { locale: MockupLocale; option: MockupOption; state: "collapsed" | "expanded" | "finished" };

function StepCard({ locale, option, state }: CardProps) {
  const finished = state === "finished";
  const [expanded, setExpanded] = useState(state !== "collapsed");
  const detailsId = useId();
  const t = mockupCopy[locale];
  const steps = mockupSteps(locale, finished);
  const activities = steps.flatMap(step => step.tools);
  const status = finished ? t.finished : t.status;
  return (
    <SurfacePanel elevation="none" radius="lg" role="region" aria-label={t.title} data-step-mockup={`${option}-${state}`}>
      <Stack gap="sm">
        <Stack align="row" cross="center" gap="sm" justify="between">
          <Typo.Label as="span" minWidth="0" title={t.title} truncate>{t.title}</Typo.Label>
          <ButtonContainer size="icon-sm">
            <IconButton label={t.details} aria-controls={detailsId} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><Eye size="md" /></IconButton>
          </ButtonContainer>
        </Stack>
        <WorkActivityDisclosure detailsId={detailsId} detailsLabel={t.details} expanded={expanded} hiddenCount={activities.length - 1}
          label={status} latest={finished ? t.results[3] : activities.at(-1)!.title} previous={activities.at(-2)!.title}
          live={!finished} onToggle={() => setExpanded(value => !value)} status={option === "c" ? (
            <Stack as="span" gap="xs" minWidth="0">
              <Typo.Caption as="span" truncate>{status}</Typo.Caption>
              <ProgressMeter bare value={finished ? 100 : 50} ariaLabel={`${t.progress} ${finished ? "4/4" : "2/4"}`} />
            </Stack>
          ) : status}>
          <StewardStepCardMockupDetails locale={locale} finished={finished} option={option} />
        </WorkActivityDisclosure>
      </Stack>
    </SurfacePanel>
  );
}

function Mockup({ locale, option }: { locale: MockupLocale; option: MockupOption }) {
  return (
    <Stack gap="lg">
      {(["collapsed", "expanded", "finished"] as const).map((state, index) => (
        <Stack key={state} gap="sm">
          <Typo.Caption tone="secondary">{mockupCopy[locale].labels[index]}</Typo.Caption>
          <StepCard locale={locale} option={option} state={state} />
        </Stack>
      ))}
    </Stack>
  );
}

export const stewardStepCardMockupStories: ShowcaseStory[] = ([
  ["a", "Step card · A 단계 목록"], ["b", "Step card · B 단계 타임라인"], ["c", "Step card · C 단계 탭"],
] as const).map(([option, name]) => ({
  name, states: ["running", "expanded", "done"],
  render: ({ locale }) => <Mockup locale={locale} option={option} />,
}));
