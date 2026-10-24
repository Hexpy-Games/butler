import { modelDisplayName } from "@/app/utils.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { AppModelSummary, ComposerModelState } from "@/app/types.ts";
import { Tooltip } from "@/butler-ds";
import { ComposerControlButton } from "./ComposerControlButton";

/** The model control while there is no model to pick: still loading, or none added. */
export function ComposerModelStatusButton(props: {
  state: ComposerModelState;
  model?: AppModelSummary;
}) {
  useAppLocale();
  if (props.model || props.state === "unavailable") {
    const label = props.model ? modelDisplayName(props.model) : appCopy.composer.modelNone;
    const hint = props.model ? props.model.availability === "not_in_plan" ? appCopy.chatgptPlan.notInPlanHint : appCopy.chatgptPlan.signInAgainHint : appCopy.composer.modelNoneHint;
    return (
      <Tooltip label={hint}>
        <ComposerControlButton
          aria-disabled="true"
          aria-label={`${label}. ${hint}`}
          data-test-class="model-button"
        >
          <span data-test-class="composer-model-name">{label}</span>
        </ComposerControlButton>
      </Tooltip>
    );
  }
  return (
    <ComposerControlButton disabled data-test-class="model-button">
      <span data-test-class="composer-model-name">{appCopy.composer.modelLoading}</span>
    </ComposerControlButton>
  );
}
