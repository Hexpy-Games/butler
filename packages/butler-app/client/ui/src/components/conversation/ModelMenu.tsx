import { useMemo, useState } from "react";
import {
  FilteredSelectPopover,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { ReasoningEffort } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { appThemeClasses } from "@/app/utils.ts";
import { useComposerStore } from "./composerStore";
import { ComposerControlButton } from "./ComposerControlButton";
import {
  modelDisplayName,
  reasoningBudgetSummary,
  reasoningOptionLabel,
  tokenWindowLabel,
} from "@/app/utils.ts";

export function ModelMenu() {
  const modelMenuOpen = useComposerStore((store) => store.modelMenuOpen);
  const setModelMenuOpen = useComposerStore((store) => store.setModelMenuOpen);
  const activeModel = useComposerStore((store) => store.activeModel);
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
  const [searchValue, setSearchValue] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");

  const providers = useMemo(() => {
    const seen = new Set<string>();
    return models
      .filter((item) => {
        if (seen.has(item.provider_id)) return false;
        seen.add(item.provider_id);
        return true;
      })
      .map((item) => ({
        id: item.provider_id,
        label: item.provider_label,
      }));
  }, [models]);

  const modelGroups = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    return providers.map((provider) => {
      const items = models
        .filter((item) => providerFilter === "all" || item.provider_id === providerFilter)
        .filter((item) => item.provider_id === provider.id)
        .filter((item) => {
          if (!query) return true;
          return [
            modelDisplayName(item),
            item.model_id,
            item.provider_label,
          ].some((value) => value.toLowerCase().includes(query));
        })
        .map((item) => ({
          id: item.model_ref,
          label: modelDisplayName(item),
          description: tokenWindowLabel(item.context_window_tokens),
          selected: item.model_ref === model,
          onSelect: () => handleModelChoice(item),
        }));
      return {
        id: provider.id,
        title: provider.label,
        items,
      };
    });
  }, [handleModelChoice, model, models, providerFilter, providers, searchValue]);

  if (!activeModel) return null;

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
        className={appThemeClasses(settings)}
        data-menu-size="fit"
        side="top"
        sideOffset={10}
      >
        <FilteredSelectPopover
          title={appCopy.composer.model}
          searchLabel={appCopy.composer.model}
          searchPlaceholder={appCopy.composer.modelSearch}
          searchClearLabel={appCopy.composer.modelSearchClear}
          searchValue={searchValue}
          filters={[
            { id: "all", label: appCopy.composer.allProviders },
            ...providers,
          ]}
          activeFilterId={providerFilter}
          onFilterChange={setProviderFilter}
          onSearchChange={setSearchValue}
          emptyLabel={appCopy.composer.noModels}
          groups={modelGroups}
          footerTitle={appCopy.composer.reasoning}
          footerOptions={(availableReasoning as ReasoningEffort[]).map((item) => ({
            id: item,
            label: reasoningOptionLabel(activeModel, item),
            selected: item === reasoning,
            onSelect: () => {
              handleReasoningChange(item);
              setModelMenuOpen(false);
            },
          }))}
        />
      </PopoverContent>
    </Popover>
  );
}
