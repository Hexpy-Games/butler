import { useMemo, useState } from "react";
import {
  Button,
  FilteredSelectPopover,
  Plus,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { modelDisplayName, tokenWindowLabel } from "@/app/utils.ts";
import type { AppModelSummary, SettingsView } from "@/app/types.ts";
import type { SettingsUpdate } from "./settingsTypes";
import { addBackupModel, MAX_BACKUP_MODELS } from "./backupModelsUtils";

export function BackupModelPicker({
  models,
  fallback,
  saving,
  onUpdate,
}: {
  models: AppModelSummary[];
  fallback: SettingsView["model_fallback"];
  saving: boolean;
  onUpdate: SettingsUpdate;
}) {
  const copy = appCopy.settings.backupModels;
  const [open, setOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const providers = useMemo(() => {
    const seen = new Set<string>();
    return models.flatMap((model) => {
      if (seen.has(model.provider_id)) return [];
      seen.add(model.provider_id);
      return [{ id: model.provider_id, label: model.provider_label }];
    });
  }, [models]);
  const groups = useMemo(() => {
    const query = searchValue.trim().toLocaleLowerCase("en-US");
    return providers.map((provider) => ({
      id: provider.id,
      title: provider.label,
      items: models
        .filter(
          (model) =>
            providerFilter === "all" || model.provider_id === providerFilter,
        )
        .filter((model) => model.provider_id === provider.id)
        .filter((model) =>
          query
            ? [modelDisplayName(model), model.model_id, model.provider_label].some(
                (value) => value.toLocaleLowerCase("en-US").includes(query),
              )
            : true,
        )
        .map((model) => ({
          id: model.model_ref,
          label: modelDisplayName(model),
          description: `${model.provider_label} · ${tokenWindowLabel(model.context_window_tokens)}`,
          onSelect: () => {
            const nextFallback = addBackupModel(fallback, model.model_ref);
            if (nextFallback === fallback) return;
            void onUpdate({ model_fallback: nextFallback });
            setOpen(false);
          },
        })),
    }));
  }, [fallback, models, onUpdate, providerFilter, providers, searchValue]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearchValue("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving || fallback.models.length >= MAX_BACKUP_MODELS}
          data-test-class="settings-backup-model-add"
        >
          <Plus size={15} /> {copy.add}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8}>
        <FilteredSelectPopover
          title={copy.addTitle}
          searchLabel={copy.addTitle}
          searchPlaceholder={copy.searchPlaceholder}
          searchClearLabel={copy.searchClearLabel}
          searchValue={searchValue}
          filters={[{ id: "all", label: copy.allProviders }, ...providers]}
          activeFilterId={providerFilter}
          onSearchChange={setSearchValue}
          onFilterChange={setProviderFilter}
          groups={groups}
          emptyLabel={
            fallback.models.length >= MAX_BACKUP_MODELS
              ? copy.limitReached
              : copy.noCandidates
          }
        />
      </PopoverContent>
    </Popover>
  );
}
