import { useState } from "react";
import { DisclosureRow, ScrollArea, Stack, Tabs, TabsContent, TabsList, TabsTrigger, Tag, Typo, WorkActivityBlock } from "@/butler-ds";
import { mockupCopy, mockupSteps, type MockupLocale, type MockupOption, type MockupStep } from "./StewardStepCardMockupData.showcase";

type DetailsProps = { locale: MockupLocale; finished: boolean; option: MockupOption };

function Result({ step, locale }: { step: MockupStep; locale: MockupLocale }) {
  return step.result ? <Typo.Caption tone="secondary" wrap="anywhere">{mockupCopy[locale].result}: {step.result}</Typo.Caption> : null;
}

function Activity({ step }: { step: MockupStep }) {
  return (
    <Stack gap="xs">
      {step.tools.map((tool, index) => (
        <WorkActivityBlock key={tool.id} title={<Typo.Text wrap="anywhere">{tool.title}</Typo.Text>} density="compact"
          connected={index < step.tools.length - 1} live={step.running && index === step.tools.length - 1} running={step.running} />
      ))}
    </Stack>
  );
}

function StepRow({ step, locale, initiallyOpen }: { step: MockupStep; locale: MockupLocale; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const t = mockupCopy[locale];
  return (
    <DisclosureRow title={step.name} description={step.purpose} open={open} onToggle={() => setOpen(value => !value)}
      meta={<Stack as="span" gap="xs" cross="end"><Tag tone={step.running ? "accent" : "neutral"}>{step.running ? t.running : t.done}</Tag><Typo.Caption as="span">{step.time}</Typo.Caption></Stack>}>
      <Stack gap="sm"><Result step={step} locale={locale} /><Activity step={step} /></Stack>
    </DisclosureRow>
  );
}

function StepTabs({ locale, finished }: Omit<DetailsProps, "option">) {
  const [selected, setSelected] = useState(finished ? "0" : "2");
  const t = mockupCopy[locale];
  const steps = mockupSteps(locale, finished);
  return (
    <Tabs value={selected} onValueChange={setSelected} gap="sm">
      <TabsList aria-label={t.details} stretch>
        {steps.map((step, index) => <TabsTrigger key={step.name} value={String(index)}>{t.segments[index]}</TabsTrigger>)}
      </TabsList>
      {steps.map((step, index) => (
        <TabsContent key={step.name} value={String(index)}>
          <Stack gap="sm">
            <Stack align="row" cross="center" gap="sm" wrap><Typo.Label>{step.name}</Typo.Label><Tag tone={step.running ? "accent" : "neutral"}>{step.running ? t.running : t.done}</Tag></Stack>
            <Typo.Caption tone="secondary">{step.purpose}</Typo.Caption>
            <Result step={step} locale={locale} />
            <Activity step={step} />
          </Stack>
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function StewardStepCardMockupDetails({ locale, finished, option }: DetailsProps) {
  const steps = mockupSteps(locale, finished);
  return (
    <Stack gap="sm">
      <Typo.Caption tone="secondary">{mockupCopy[locale].revision}</Typo.Caption>
      {option === "a" ? steps.map((step, index) => <StepRow key={step.name} step={step} locale={locale} initiallyOpen={finished ? index === 0 : step.running} />) : null}
      {option === "b" ? (
        <ScrollArea maxHeight="sm">
          <Stack gap="sm">
            {steps.map((step, index) => (
              <Stack key={step.name} gap="xs">
                <WorkActivityBlock title={`${index + 1}. ${step.name}`} description={step.purpose} tools={step.tools}
                  density="compact" connected={index < steps.length - 1 || Boolean(step.result)} running={step.running} live={step.running} />
                {step.result ? <WorkActivityBlock title={<Result step={step} locale={locale} />} density="compact" connected={index < steps.length - 1} /> : null}
              </Stack>
            ))}
          </Stack>
        </ScrollArea>
      ) : null}
      {option === "c" ? <StepTabs locale={locale} finished={finished} /> : null}
    </Stack>
  );
}
