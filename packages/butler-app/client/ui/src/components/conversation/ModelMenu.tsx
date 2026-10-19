import { useAppLocale } from "@/app/copy.ts";
import { memo } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { ReasoningEffort } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { appShellTheme } from "@/app/utils.ts";
import { useComposerStore } from "./composerStore";
import { ComposerControlButton } from "./ComposerControlButton";
import {
  modelDisplayName,
  reasoningBudgetSummary,
  reasoningOptionLabel,
} from "@/app/utils.ts";
import { ComposerModelStatusButton } from "./ComposerModelStatusButton.tsx";
import { ModelOptions, useModelOptionsFilter } from "./ModelOptions.tsx";

export const ModelMenu = memo(function ModelMenu() {
  useAppLocale();
  const modelMenuOpen = useComposerStore((store) => store.modelMenuOpen);
  const setModelMenuOpen = useComposerStore((store) => store.setModelMenuOpen);
  const activeModel = useComposerStore((store) => store.activeModel);
  const modelState = useComposerStore((store) => store.modelState);
  const reasoning = useComposerStore((store) => store.reasoning);
  const model = useComposerStore((store) => store.model);
  const models = useComposerStore((store) => store.models);
  const availableReasoning = useComposerStore(
    (store) => store.availableReasoning,
  );
  const handleModelChoice = useComposerStore(
    (store) => store.handleModelChoice,
  );
  const handleReasoningChange = useComposerStore(
    (store) => store.handleReasoningChange,
  );
  const settings = useButlerStore((store) => store.settings);
  // Owned here, outside the popover, so a reopened menu keeps its search and filter.
  const filter = useModelOptionsFilter();

  if (modelState !== "ready" || !activeModel) {
    return <ComposerModelStatusButton state={modelState} />;
  }

  return (
    <Popover open={modelMenuOpen} onOpenChange={setModelMenuOpen}>
      <PopoverTrigger asChild>
        <ComposerControlButton
          detail={
            <span data-test-class="composer-model-summary">
              {reasoningBudgetSummary(activeModel, reasoning)}
            </span>
          }
          data-test-class="model-button"
        >
          <span data-test-class="composer-model-name">
            {modelDisplayName(activeModel)}
          </span>
        </ComposerControlButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        theme={appShellTheme(settings)}
        data-menu-size="fit"
        side="top"
        sideOffset={10}
      >
        <ModelOptions
          models={models}
          value={model}
          onSelect={handleModelChoice}
          filter={filter}
          footer={{
            title: appCopy.composer.reasoning,
            options: (availableReasoning as ReasoningEffort[]).map((item) => ({
              id: item,
              label: reasoningOptionLabel(activeModel, item),
              selected: item === reasoning,
              onSelect: () => {
                handleReasoningChange(item);
                setModelMenuOpen(false);
              },
            })),
          }}
        />
      </PopoverContent>
    </Popover>
  );
});
