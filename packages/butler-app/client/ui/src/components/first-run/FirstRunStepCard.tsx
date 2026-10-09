import { useEffect, useLayoutEffect, useState, type ComponentProps } from "react";
import { AlertCircle, Button, Notice, SetupWizardStepCard, Stack } from "@/butler-ds";
import { firstRunSteps, FIRST_RUN_STEPS } from "./FirstRunSteps";
import { MemoryModelStatus } from "./MemoryModelStatus";
import type { FirstRunFlow } from "./useFirstRunFlow";

type FirstRunStepCardProps = Omit<ComponentProps<typeof SetupWizardStepCard>, "steps" | "activeIndex" | "backLabel"> & {
  flow: FirstRunFlow;
};

/** Product copy and state around the shared 520px DS card. */
export function FirstRunStepCard({ flow, children, contentKey = flow.step, titleId = "first-run-step-title", ...props }: FirstRunStepCardProps) {
  // Connection views mount independently. Prime the DS key before paint so
  // their bodies enter too; the common card frame and header never animate.
  const [bodyKey, setBodyKey] = useState<string>();
  useLayoutEffect(() => { setBodyKey(contentKey); }, [contentKey]);
  useEffect(() => {
    if (bodyKey === undefined) return;
    document.querySelector('[data-test-class="setup-wizard-scroll"]')?.scrollTo({ top: 0 });
    document.getElementById(titleId)?.focus({ preventScroll: true });
  }, [bodyKey, titleId]);
  return (
    <SetupWizardStepCard
      {...props}
      backLabel={flow.copy.back}
      contentKey={bodyKey}
      titleId={titleId}
      steps={flow.mode === "consent" ? undefined : firstRunSteps(flow.copy)}
      activeIndex={FIRST_RUN_STEPS.indexOf(flow.step)}
    >
      {children}
      {flow.step === "connect" ? (
        <MemoryModelStatus model={flow.readiness.memory_model} language={flow.language} retry={flow.retryPreparation} />
      ) : null}
      {flow.commit.failed && flow.view.kind !== "signin" ? (
        <Stack gap="none" role="alert">
          <Notice tone="error" icon={<AlertCircle size="md" />} message={flow.copy.finishFailed}
            action={<Button size="sm" variant="outline" onClick={flow.commit.retry}>{flow.copy.retry}</Button>} />
        </Stack>
      ) : null}
    </SetupWizardStepCard>
  );
}
