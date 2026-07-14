import type { ComposerModelState } from "@/app/types.ts";
import { ComposerControlButton } from "./ComposerControlButton";
import { composerModelStateLabel } from "./composerModelTruth.ts";

export function ComposerModelStatusButton(props: {
  state: ComposerModelState;
}) {
  return (
    <ComposerControlButton disabled data-test-class="model-button">
      <span data-test-class="composer-model-name">
        {composerModelStateLabel(props.state)}
      </span>
    </ComposerControlButton>
  );
}
