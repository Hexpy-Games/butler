import { useState } from "react";
import { Button, Input, SettingsField, Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import {
  SIMULTANEOUS_WORKERS_MAX,
  SIMULTANEOUS_WORKERS_MIN,
  normalizeSimultaneousWorkers,
} from "./workerProfileUpdates";

interface WorkerProfileControlsProps {
  canAdd: boolean;
  maxSimultaneousWorkers: number;
  onAdd: () => void;
  onMaxChange: (value: number) => void;
}

export function WorkerProfileControls({
  canAdd,
  maxSimultaneousWorkers,
  onAdd,
  onMaxChange,
}: WorkerProfileControlsProps) {
  const saving = useSettingsUIStore((state) => state.saving);
  const [maxTextDraft, setMaxTextDraft] = useState<string | null>(null);
  const panelCopy = appCopy.settings.workerProfilesPanel;
  const maxText = maxTextDraft ?? String(maxSimultaneousWorkers);

  function commitMax() {
    const committed = normalizeSimultaneousWorkers(
      maxTextDraft ?? "",
      maxSimultaneousWorkers,
    );
    setMaxTextDraft(null);
    if (committed !== null) onMaxChange(committed);
  }

  return (
    <>
      <Stack align="row" cross="center" gap="md" justify="between">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving || !canAdd}
          data-test-class="worker-profile-add"
          onClick={onAdd}
        >
          {panelCopy.add}
        </Button>
        {!canAdd && <Typo.Caption>{panelCopy.addLimitReached}</Typo.Caption>}
      </Stack>
      <SettingsField
        data-test-class="settings-field"
        label={panelCopy.maxSimultaneousWorkers}
        control={
          <Input
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
    </>
  );
}
