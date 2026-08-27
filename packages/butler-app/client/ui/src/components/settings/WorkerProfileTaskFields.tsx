import { useState } from "react";
import { Input, SettingsField } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsSelect } from "./SettingsFormComponents";
import {
  WORKER_PROFILE_BUILTIN_JOBS,
  WORKER_PROFILE_CUSTOM_JOB_MAX_LENGTH,
  commitWorkerProfileCustomJob,
  selectWorkerProfileJob,
} from "./workerProfileUpdates";
import type { WorkerProfile } from "@/app/types.ts";

interface DeferredTextFieldProps {
  label: string;
  value: string;
  maxLength?: number;
  disabled?: boolean;
  onCommit: (trimmed: string) => void;
  onUnchanged?: () => void;
}

function DeferredTextField({
  label,
  value,
  maxLength,
  disabled,
  onCommit,
  onUnchanged,
}: DeferredTextFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <SettingsField
      data-test-class="settings-field"
      label={label}
      control={
        <Input
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

  function commitCustomJob(trimmed: string) {
    const committed = commitWorkerProfileCustomJob(trimmed);
    if (!committed) {
      setCustomSelection(false);
      return;
    }
    onCommit({ job: committed });
  }

  return (
    <>
      <SettingsSelect
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
          label={settingsFields.customJob}
          value={profile.job.kind === "custom" ? profile.job.text : ""}
          maxLength={WORKER_PROFILE_CUSTOM_JOB_MAX_LENGTH}
          disabled={saving}
          onCommit={commitCustomJob}
          onUnchanged={() => setCustomSelection(false)}
        />
      )}
      <DeferredTextField
        label={settingsFields.domain}
        value={profile.domain ?? ""}
        disabled={saving}
        onCommit={(trimmed) =>
          onCommit(trimmed ? { domain: trimmed } : { domain: undefined })
        }
      />
      <DeferredTextField
        label={settingsFields.workerPrompt}
        value={profile.prompt ?? ""}
        disabled={saving}
        onCommit={(trimmed) =>
          onCommit(trimmed ? { prompt: trimmed } : { prompt: undefined })
        }
      />
    </>
  );
}
