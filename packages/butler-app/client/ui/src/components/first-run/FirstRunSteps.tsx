import { appCopy } from "@/app/copy";
import { Typo, type SetupWizardStep } from "@/butler-ds";
import type { FirstRunFlow } from "./useFirstRunFlow";

export type FirstRunStep = "welcome" | "consent" | "memory" | "import" | "connect" | "ready";

export const FIRST_RUN_STEPS: FirstRunStep[] = ["welcome", "consent", "connect", "ready"];

/** The shared DS progress indicator owns numbering and aria-current. */
export function firstRunStepIds(mode: FirstRunFlow["mode"]): FirstRunStep[] {
  return mode === "first-run" ? ["welcome", "consent", "memory", "connect", "import", "ready"] : FIRST_RUN_STEPS;
}
/** The active step with substeps carries its count after the label ("AI 연결 2/3"). */
export function firstRunSteps(copy: FirstRunFlow["copy"], mode: FirstRunFlow["mode"], active?: FirstRunStep, substep?: { index: number; total: number }): SetupWizardStep[] {
  return firstRunStepIds(mode).map((id) => {
    const label = id === "import" ? appCopy.settings.pageSections.import : copy.steps[id];
    return { id, label: id === active && substep ? <>{label} <Typo.Caption as="span" tone="tertiary" numeric="tabular">{substep.index}/{substep.total}</Typo.Caption></> : label };
  });
}
