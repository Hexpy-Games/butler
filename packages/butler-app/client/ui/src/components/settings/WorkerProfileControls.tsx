import { useAppLocale } from "@/app/copy.ts";
import { useId, useState } from "react";
import { Button, Input, Plus, SettingsField } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import {
  SIMULTANEOUS_WORKERS_MAX,
  SIMULTANEOUS_WORKERS_MIN,
  normalizeSimultaneousWorkers,
} from "./workerProfileUpdates";

/** Worker profiles header action: Add Worker profile. */
export function WorkerProfileAddButton({ canAdd, onAdd }: { canAdd: boolean; onAdd: () => void }) {
  useAppLocale();
  const saving = useSettingsUIStore((state) => state.saving);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={saving || !canAdd}
      data-test-class="worker-profile-add"
      onClick={onAdd}
    >
      <Plus size="md" /> {appCopy.settings.workerProfilesPanel.add}
    </Button>
  );
}

/** The first row of the Worker profiles card: max simultaneous Workers, committed on blur or Enter. */
export function WorkerMaxSimultaneousField({
  maxSimultaneousWorkers,
  onMaxChange,
}: {
  maxSimultaneousWorkers: number;
  onMaxChange: (value: number) => void;
}) {
  useAppLocale();
  const saving = useSettingsUIStore((state) => state.saving);
  const [maxTextDraft, setMaxTextDraft] = useState<string | null>(null);
  const maxId = useId();
  const maxText = maxTextDraft ?? String(maxSimultaneousWorkers);

  function commitMax() {
    const committed = normalizeSimultaneousWorkers(maxTextDraft ?? "", maxSimultaneousWorkers);
    setMaxTextDraft(null);
    if (committed !== null) onMaxChange(committed);
  }

  return (
    <SettingsField
      id={maxId}
      settingId="worker-max-simultaneous"
      data-test-class="worker-max-simultaneous"
      label={appCopy.settings.workerProfilesPanel.maxSimultaneousWorkers}
      control={
        <Input
          id={maxId}
          compact
          type="number"
          inputMode="numeric"
          min={SIMULTANEOUS_WORKERS_MIN}
          max={SIMULTANEOUS_WORKERS_MAX}
          step={1}
          value={maxText}
          disabled={saving}
          onChange={(event) => setMaxTextDraft(event.target.value)}
          onBlur={() => commitMax()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      }
    />
  );
}
