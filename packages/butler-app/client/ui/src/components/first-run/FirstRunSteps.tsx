import type { SetupWizardStep } from "@/butler-ds";
import type { FirstRunFlow } from "./useFirstRunFlow";

export type FirstRunStep = "welcome" | "consent" | "connect" | "ready";

export const FIRST_RUN_STEPS: FirstRunStep[] = ["welcome", "consent", "connect", "ready"];

/** The shared DS progress indicator owns numbering and aria-current. */
export function firstRunSteps(copy: FirstRunFlow["copy"]): SetupWizardStep[] {
  return FIRST_RUN_STEPS.map((id) => ({ id, label: copy.steps[id] }));
}
