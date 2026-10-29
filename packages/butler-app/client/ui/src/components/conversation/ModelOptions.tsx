import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { FilteredSelectPopover, type FilteredSelectFooterOption } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { AppModelSummary } from "@/app/types.ts";
import { modelDisplayName, tokenWindowLabel } from "@/app/utils.ts";

/**
 * The composer's model choices with search and provider filters. `footer`
 * adds reasoning choices below the list. `filter` lets a caller
 * keep the search and provider filter across reopening; without it they reset.
 */
export function ModelOptions({
  models,
  value,
  onSelect,
  footer,
  filter,
}: {
  models: readonly AppModelSummary[];
  value: string;
  onSelect: (model: AppModelSummary) => void;
  footer?: { title: ReactNode; options: FilteredSelectFooterOption[] };
  filter?: ModelOptionsFilter;
}) {
  useAppLocale();
  const local = useModelOptionsFilter();
  const { searchValue, setSearchValue, providerFilter, setProviderFilter } = filter ?? local;

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
          ].some((field) => field.toLowerCase().includes(query));
        })
        .map((item) => ({
          id: item.model_ref,
          label: modelDisplayName(item),
          description: tokenWindowLabel(item.context_window_tokens),
          selected: item.model_ref === value,
          onSelect: () => onSelect(item),
        }));
      return {
        id: provider.id,
        title: provider.label,
        items,
      };
    });
  }, [onSelect, value, models, providerFilter, providers, searchValue]);

  return (
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
      footerTitle={footer?.title}
      footerOptions={footer?.options}
    />
  );
}

export interface ModelOptionsFilter {
  searchValue: string;
  setSearchValue: (value: string) => void;
  providerFilter: string;
  setProviderFilter: (id: string) => void;
}

/** The search text and provider filter of a model list. */
export function useModelOptionsFilter(): ModelOptionsFilter {
  const [searchValue, setSearchValue] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  return { searchValue, setSearchValue, providerFilter, setProviderFilter };
}
