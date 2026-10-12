import { appCopy } from "@/app/copy";
import type { SetupWizardStep } from "@/butler-ds";
import type { FirstRunFlow } from "./useFirstRunFlow";

export type FirstRunStep = "welcome" | "consent" | "memory" | "import" | "connect" | "ready";

export const FIRST_RUN_STEPS: FirstRunStep[] = ["welcome", "consent", "connect", "ready"];

/** The shared DS progress indicator owns numbering and aria-current. */
export function firstRunStepIds(mode: FirstRunFlow["mode"]): FirstRunStep[] {
  return mode === "first-run" ? ["welcome", "consent", "memory", "connect", "import", "ready"] : FIRST_RUN_STEPS;
}
export function firstRunSteps(copy: FirstRunFlow["copy"], mode: FirstRunFlow["mode"]): SetupWizardStep[] {
  return firstRunStepIds(mode).map((id) => ({ id, label: id === "import" ? appCopy.settings.pageSections.import : copy.steps[id] }));
}
