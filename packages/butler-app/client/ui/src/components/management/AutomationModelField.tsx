import { useAppLocale } from "@/app/copy.ts";
import { useId, useMemo, useState } from "react";
import {
  Field,
  FieldError,
  FieldLabel,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SelectButton,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { appShellTheme, modelDisplayName, runtimeModels } from "@/app/utils.ts";
import { resolveComposerModelTruth } from "@/components/conversation/composerModelResolution.ts";
import { useSessionControlSnapshot } from "@/components/conversation/hooks/useSessionControlSnapshot.ts";
import { ModelOptions } from "@/components/conversation/ModelOptions";
import { useAutomationStore } from "@/stores/automationStore";

/**
 * The model a schedule's runs use. Without a choice of its own, or when that
 * model is gone, it shows the model the target chat resolves to.
 */
export function AutomationModelField() {
  useAppLocale();
  const [open, setOpen] = useState(false);
  const controlId = useId();
  const errorId = useId();
  const model = useAutomationStore((state) => state.model);
  const setModel = useAutomationStore((state) => state.setModel);
  const targetSessionId = useAutomationStore((state) => state.targetSessionId);
  const error = useAutomationStore((state) =>
    state.saveError?.field === "model" ? state.saveError.message : undefined,
  );
  const settings = useButlerStore((state) => state.settings);
  const catalog = useButlerStore((state) => state.modelCatalog);
  const catalogState = useButlerStore((state) => state.modelCatalogState);
  const session = useSessionControlSnapshot(targetSessionId);
  const models = useMemo(() => runtimeModels(catalog), [catalog]);
  const shown =
    models.find((item) => item.model_ref === model) ??
    resolveComposerModelTruth({
      catalog,
      catalogState,
      controls: session.snapshot,
      controlsState: session.loadState,
      settings,
      planModeAvailable: false,
    }).metadata;

  return (
    <Field data-test-class="automation-model-field">
      <FieldLabel htmlFor={controlId}>{appCopy.composer.model}</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <SelectButton
            id={controlId}
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? true : undefined}
            data-test-class="automation-model-trigger"
          >
            {modelDisplayName(shown)}
          </SelectButton>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          theme={appShellTheme(settings)}
          data-menu-size="fit"
          sideOffset={6}
        >
          <ModelOptions
            models={models}
            value={shown?.model_ref ?? ""}
            onSelect={(item) => {
              setModel(item.model_ref);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}
