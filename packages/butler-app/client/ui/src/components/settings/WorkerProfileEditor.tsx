import { useId, useState } from "react";
import {
  Button,
  Input,
  SettingsField,
  Stack,
  SurfacePanel,
  Switch,
  Typo,
} from "@/butler-ds";
import { EMPTY_MODEL_CATALOG } from "@/app/constants.ts";
import {
  modelDisplayName,
  reasoningOptionLabel,
  tokenWindowLabel,
} from "@/app/utils.ts";
import { appCopy } from "@/app/copy.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsSelect } from "./SettingsFormComponents";
import { WorkerProfileTaskFields } from "./WorkerProfileTaskFields";
import { selectWorkerProfileModel } from "./workerProfileUpdates";
import type {
  AppModelSummary,
  ReasoningEffort,
  WorkerProfile,
} from "@/app/types.ts";

interface WorkerProfileEditorProps {
  profile: WorkerProfile;
  models: AppModelSummary[];
  onUpdate: (partial: Partial<WorkerProfile>) => void;
  onDelete: () => void;
}

export function WorkerProfileEditor({
  profile,
  models,
  onUpdate,
  onDelete,
}: WorkerProfileEditorProps) {
  const nameId = useId();
  const enabledId = useId();
  const saving = useSettingsUIStore((state) => state.saving);
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  const settingsFields = appCopy.settings.fields;
  const isDefault = profile.id === "default";
  const selectedModel =
    models.find((model) => model.model_ref === profile.model) ?? models[0];

  function commitLabel() {
    const trimmed = (labelDraft ?? profile.label).trim();
    setLabelDraft(null);
    if (trimmed && trimmed !== profile.label) onUpdate({ label: trimmed });
  }

  function changeModel(value: string) {
    onUpdate(selectWorkerProfileModel(models, value, profile.reasoning_effort));
  }

  return (
    <SurfacePanel data-test-class="worker-profile" elevation="none">
      <Stack gap="md">
        <Typo.PanelSectionTitle as="h3">{profile.label}</Typo.PanelSectionTitle>
        <SettingsField
          id={nameId}
          data-test-class="settings-field"
          label={settingsFields.name}
          control={
            <Input
              id={nameId}
              value={labelDraft ?? profile.label}
              disabled={saving}
              onChange={(event) => setLabelDraft(event.target.value)}
              onBlur={() => commitLabel()}
            />
          }
        />
        <SettingsField
          id={enabledId}
          data-test-class="settings-field"
          label={settingsFields.enabled}
          control={
            <Switch
              id={enabledId}
              checked={profile.enabled}
              disabled={saving || isDefault}
              onCheckedChange={(value) => {
                if (!isDefault) onUpdate({ enabled: value });
              }}
            />
          }
        />
        <WorkerProfileTaskFields profile={profile} onCommit={onUpdate} />
        <SettingsSelect
          label={settingsFields.model}
          disabled={saving}
          value={
            selectedModel?.model_ref ?? EMPTY_MODEL_CATALOG.default_model_ref
          }
          onChange={changeModel}
          options={models.map((model) => ({
            value: model.model_ref,
            label: `${model.provider_label} / ${modelDisplayName(model)} (${tokenWindowLabel(model.context_window_tokens)})`,
          }))}
        />
        <SettingsSelect
          label={settingsFields.reasoning}
          disabled={saving}
          value={profile.reasoning_effort}
          onChange={(value) =>
            onUpdate({ reasoning_effort: value as ReasoningEffort })
          }
          options={(selectedModel?.reasoning_efforts ?? ["none"]).map(
            (value) => ({
              value,
              label: reasoningOptionLabel(selectedModel, value),
            }),
          )}
        />
        {!isDefault && (
          <Stack align="row" justify="end">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={saving}
              data-test-class="worker-profile-delete"
              onClick={onDelete}
            >
              {appCopy.common.delete}
            </Button>
          </Stack>
        )}
      </Stack>
    </SurfacePanel>
  );
}
