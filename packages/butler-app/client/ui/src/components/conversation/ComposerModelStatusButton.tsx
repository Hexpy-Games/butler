import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { ComposerModelState } from "@/app/types.ts";
import { AlertCircle, Tooltip } from "@/butler-ds";
import { ComposerControlButton } from "./ComposerControlButton";
import { composerModelStateLabel } from "./composerModelTruth.ts";

export function ComposerModelStatusButton(props: {
  state: ComposerModelState;
}) {
  useAppLocale();
  const label = composerModelStateLabel(props.state);
  if (props.state === "error") {
    const hint = appCopy.composer.modelErrorHint;
    return (
      <Tooltip label={hint}>
        <ComposerControlButton
          aria-disabled="true"
          aria-label={`${label}. ${hint}`}
          data-test-class="model-button"
          icon={<AlertCircle size={14} />}
          tone="danger"
        >
          <span data-test-class="composer-model-name">{label}</span>
        </ComposerControlButton>
      </Tooltip>
    );
  }
  return (
    <ComposerControlButton disabled data-test-class="model-button">
      <span data-test-class="composer-model-name">{label}</span>
    </ComposerControlButton>
  );
}
