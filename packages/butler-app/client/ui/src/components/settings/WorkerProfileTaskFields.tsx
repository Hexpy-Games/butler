import { workerProfileTextPatch } from "./workerProfileTextPatch";
import { useAppLocale } from "@/app/copy.ts";
import { useId, useState } from "react";
import { Input, SettingsField } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsSelect } from "./SettingsFormComponents";
import {
  WORKER_PROFILE_BUILTIN_JOBS,
  WORKER_PROFILE_CUSTOM_JOB_MAX_LENGTH,
  selectWorkerProfileJob,
} from "./workerProfileUpdates";
import type { WorkerProfile } from "@/app/types.ts";

interface DeferredTextFieldProps {
  settingId: string;
  label: string;
  value: string;
  maxLength?: number;
  disabled?: boolean;
  onCommit: (trimmed: string) => void;
  onUnchanged?: () => void;
}

function DeferredTextField({
  settingId,
  label,
  value,
  maxLength,
  disabled,
  onCommit,
  onUnchanged,
}: DeferredTextFieldProps) {
  useAppLocale();
  const controlId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <SettingsField
      id={controlId}
      settingId={settingId}
      data-test-class="settings-field"
      label={label}
      control={
        <Input
          id={controlId}
          value={draft ?? value}
          maxLength={maxLength}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            const trimmed = (draft ?? value).trim();
            setDraft(null);
            if (trimmed === value.trim()) {
              onUnchanged?.();
              return;
            }
            onCommit(trimmed);
          }}
        />
      }
    />
  );
}

interface WorkerProfileTaskFieldsProps {
  profile: WorkerProfile;
  onCommit: (partial: Partial<WorkerProfile>) => void;
}

export function WorkerProfileTaskFields({
  profile,
  onCommit,
}: WorkerProfileTaskFieldsProps) {
  useAppLocale();
  const saving = useSettingsUIStore((state) => state.saving);
  const [customSelection, setCustomSelection] = useState<boolean>(false);
  const jobCopy = appCopy.settings.workerJobs;
  const settingsFields = appCopy.settings.fields;
  const customSelected = customSelection || profile.job.kind === "custom";
  const selectedBuiltin =
    !customSelected && profile.job.kind === "builtin"
      ? profile.job.job
      : undefined;

  function changeJob(value: string) {
    const selection = selectWorkerProfileJob(value);
    if (!selection || selectedBuiltin === value) return;
    if (selection.persistent && selection.job) {
      setCustomSelection(false);
      onCommit({ job: selection.job });
      return;
    }
    setCustomSelection(true);
  }

  function commitText(field: "domain" | "prompt", value: string) {
    const patch = workerProfileTextPatch(profile, field, value);
    if (patch) onCommit(patch);
  }

  function commitCustomJob(trimmed: string) {
    const committed = workerProfileTextPatch(profile, "job", trimmed);
    if (!committed) {
      setCustomSelection(false);
      return;
    }
    onCommit(committed);
  }

  return (
    <>
      <SettingsSelect
        settingId="worker-job"
        label={settingsFields.job}
        disabled={saving}
        value={selectedBuiltin ?? "custom"}
        onChange={changeJob}
        options={[
          ...WORKER_PROFILE_BUILTIN_JOBS.map((job) => ({
            value: job,
            label: jobCopy[job],
          })),
          { value: "custom", label: jobCopy.custom },
        ]}
      />
      {customSelected && (
        <DeferredTextField
          settingId="worker-custom-job"
          label={settingsFields.customJob}
          value={profile.job.kind === "custom" ? profile.job.text : ""}
          maxLength={WORKER_PROFILE_CUSTOM_JOB_MAX_LENGTH}
          disabled={saving}
          onCommit={commitCustomJob}
          onUnchanged={() => setCustomSelection(false)}
        />
      )}
      <DeferredTextField
        settingId="worker-domain"
        label={settingsFields.domain}
        value={profile.domain ?? ""}
        disabled={saving}
        onCommit={(trimmed) =>
          commitText("domain", trimmed)
        }
      />
      <DeferredTextField
        settingId="worker-prompt"
        label={settingsFields.workerPrompt}
        value={profile.prompt ?? ""}
        disabled={saving}
        onCommit={(trimmed) =>
          commitText("prompt", trimmed)
        }
      />
    </>
  );
}
