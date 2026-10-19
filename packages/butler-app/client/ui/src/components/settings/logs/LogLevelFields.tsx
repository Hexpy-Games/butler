import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { Button, Inline, SegmentedControl, SettingsField } from "@/butler-ds";
import { LogCategoryLevels } from "./LogCategoryLevels";
import { LOG_PRESETS, type LogPreset } from "./logsApi";
import type { LogConfigState } from "./useLogConfig";

/** 기록's fields: the preset, the full-logging lease and per-category overrides. */
export function LogLevelFields({ state, categories }: { state: LogConfigState; categories: readonly string[] }) {
  const copy = appCopy.settings.logs;
  const { config } = state;
  const level = config?.effective.level ?? "standard";
  const full = level === "full" && state.minutesLeft !== null;
  const previous = useButlerStore((store) => store.settings.log_full?.previous);
  return (
    <>
      <SettingsField
        settingId="log-level"
        label={copy.levelLabel}
        controlWidth="full"
        control={
          <Inline gap="sm" cross="center">
            <SegmentedControl
              ariaLabel={copy.levelLabel}
              options={LOG_PRESETS.map((value) => ({ value, label: copy.levels[value], disabled: state.saving }))}
              value={level}
              onValueChange={(value) => void state.setLevel(value as LogPreset)}
            />
            {full ? (
              <Button type="button" size="sm" variant="outline" disabled={state.saving}
                onClick={() => void state.setLevel(previousPreset(previous))}>
                {copy.turnOff}
              </Button>
            ) : null}
          </Inline>
        }
        meta={full ? copy.fullActive(state.minutesLeft ?? 0) : copy.levelMeta[level]}
      />
      <LogCategoryLevels
        overrides={config?.effective.category_levels ?? {}}
        categories={categories}
        disabled={state.saving}
        onChange={(category, value) => void state.setCategoryLevel(category, value)}
      />
    </>
  );
}

/** Turning full logging off returns to the preset it replaced. */
function previousPreset(previous: string | undefined): LogPreset {
  const preset = LOG_PRESETS.find((value) => value === previous && value !== "full");
  return preset ?? "standard";
}
