import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SettingsView as SettingsData } from "@/app/types.ts";
import { ColorSwatchInput, SettingsField, Stack } from "@/butler-ds";
import { PROMPT_FLUID_PALETTES, fluidPaletteToHexColors } from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsSelect } from "./SettingsFormComponents";

const DEFAULT_CUSTOM_COLORS = fluidPaletteToHexColors(
  PROMPT_FLUID_PALETTES.monochrome,
) as SettingsData["main_screen_theme_custom_colors"];

function customColorsFrom(
  draft: SettingsData,
): SettingsData["main_screen_theme_custom_colors"] {
  return draft.main_screen_theme_custom_colors ?? DEFAULT_CUSTOM_COLORS;
}

export function MainScreenThemeSettings() {
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const copy = appCopy.settings;

  if (!draft) return null;

  const colors = customColorsFrom(draft);
  const updateColor = (index: number, value: string) => {
    const next = [...colors] as SettingsData["main_screen_theme_custom_colors"];
    next[index] = value.toLocaleLowerCase("en-US");
    void update({ main_screen_theme_custom_colors: next }, setSettings);
  };

  return (
    <>
      <SettingsSelect
        label={copy.fields.mainScreenTheme}
        description={copy.descriptions.mainScreenTheme}
        triggerTestClass="settings-main-screen-theme-select"
        value={draft.main_screen_theme}
        onChange={(value) =>
          update(
            { main_screen_theme: value as SettingsData["main_screen_theme"] },
            setSettings,
          )
        }
        options={[
          { value: "none", label: copy.options.mainScreenThemeNone },
          { value: "bloom", label: copy.options.mainScreenThemeBloom },
          { value: "silk", label: copy.options.mainScreenThemeSilk },
        ]}
      />
      {draft.main_screen_theme === "bloom" ? (
        <>
          <SettingsSelect
            label={copy.fields.mainScreenThemePreset}
            description={copy.descriptions.mainScreenThemePreset}
            triggerTestClass="settings-main-screen-theme-preset-select"
            value={draft.main_screen_theme_preset}
            onChange={(value) =>
              update(
                {
                  main_screen_theme_preset:
                    value as SettingsData["main_screen_theme_preset"],
                },
                setSettings,
              )
            }
            options={[
              { value: "monochrome", label: copy.options.paletteMonochrome },
              { value: "aurora", label: copy.options.paletteAurora },
              { value: "bloom", label: copy.options.paletteBloom },
              { value: "lavender", label: copy.options.paletteLavender },
              { value: "morning", label: copy.options.paletteMorning },
              { value: "custom", label: copy.options.paletteCustom },
            ]}
          />
          {draft.main_screen_theme_preset === "custom" ? (
            <SettingsField
              data-test-class="settings-field settings-main-screen-theme-colors"
              label={copy.fields.mainScreenThemeColors}
              description={copy.descriptions.mainScreenThemeColors}
              control={
                <Stack align="row" gap="sm" wrap>
                  {colors.map((color, index) => (
                    <ColorSwatchInput
                      key={index}
                      aria-label={copy.fields.mainScreenThemeColor(index + 1)}
                      dataTestClass="settings-main-screen-theme-color"
                      value={color}
                      onChange={(event) =>
                        updateColor(index, event.currentTarget.value)
                      }
                    />
                  ))}
                </Stack>
              }
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}
