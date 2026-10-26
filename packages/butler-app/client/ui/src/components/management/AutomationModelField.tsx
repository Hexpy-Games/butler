import { useAppLocale } from "@/app/copy.ts";
import { useId, useMemo } from "react";
import {
  Field,
  FieldError,
  FieldLabel,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { runtimeModels } from "@/app/utils.ts";
import { resolveComposerModelTruth } from "@/components/conversation/composerModelResolution.ts";
import { useSessionControlSnapshot } from "@/components/conversation/hooks/useSessionControlSnapshot.ts";
import { consolidationModelOptionsFrom } from "@/components/settings/PersonalizationSettingsOptions";
import { useAutomationStore } from "@/stores/automationStore";

/** The schedule's own model, or the target chat's model when it is unavailable. */
function useShownModel(model: string) {
  const targetSessionId = useAutomationStore((state) => state.targetSessionId);
  const settings = useButlerStore((state) => state.settings);
  const catalog = useButlerStore((state) => state.modelCatalog);
  const catalogState = useButlerStore((state) => state.modelCatalogState);
  const session = useSessionControlSnapshot(targetSessionId);
  const models = useMemo(() => runtimeModels(catalog), [catalog]);
  const shown = models.find((item) => item.model_ref === model) ??
    resolveComposerModelTruth({
      catalog, catalogState, controls: session.snapshot,
      controlsState: session.loadState, settings, planModeAvailable: false,
    }).metadata;
  return { models, shown };
}

/** An empty selection follows the target chat and is shown as model default. */
export function AutomationModelField() {
  useAppLocale();
  const controlId = useId();
  const errorId = useId();
  const model = useAutomationStore((state) => state.model);
  const setModel = useAutomationStore((state) => state.setModel);
  const error = useAutomationStore((state) =>
    state.saveError?.field === "model" ? state.saveError.message : undefined,
  );
  const { models, shown } = useShownModel(model);
  const options = consolidationModelOptionsFrom(
    models,
    appCopy.settings.options.consolidationModelDefault,
    appCopy.automations.modelDefaultDescription,
  );
  // Preserve the unavailable override, while showing the target chat's fallback.
  const selected = options.find((option) => option.value === (model ? shown?.model_ref : "default")) ?? options[0]!;

  return (
    <Field data-test-class="automation-model-field">
      <FieldLabel htmlFor={controlId}>{appCopy.composer.model}</FieldLabel>
      <Select value={selected.value} onValueChange={(value) => setModel(value === "default" ? "" : value)}>
        <SelectTrigger
          id={controlId}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          data-test-class="automation-model-trigger"
          data-multiline={selected?.description ? "true" : undefined}
        >
          <SelectValue icon={selected?.icon}>
            {selected && (
              <span data-slot="select-value-stack">
                <span data-slot="select-value-label">{selected.label}</span>
                {selected.description && (
                  <span data-slot="select-value-description">{selected.description}</span>
                )}
              </span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                icon={option.icon}
                textValue={option.description ? `${option.label} - ${option.description}` : option.label}
              >
                <span data-slot="select-item-stack">
                  <span data-slot="select-item-label">{option.label}</span>
                  {option.description && (
                    <span data-slot="select-item-description">{option.description}</span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}
