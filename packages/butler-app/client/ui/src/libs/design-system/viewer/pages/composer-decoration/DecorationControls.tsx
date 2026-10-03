import { Field, FieldLabel, Grid, NativeSelect, NativeSelectOption, SegmentedControl, Slider, Switch } from "@/butler-ds";
import type { DecorationTheme } from "../../../decorations/composer/types";
import type { ViewerState } from "../../viewerState";
import type { ExampleOptions } from "./ComposerExample";

export function DecorationControls({ options, onOptions, state, onChange }: {
  options: ExampleOptions;
  onOptions: (patch: Partial<ExampleOptions>) => void;
  state: ViewerState;
  onChange: (patch: Partial<ViewerState>) => void;
}) {
  return (
    <Grid columns="auto-fit" gap="lg">
      <Field>
        <FieldLabel htmlFor="decoration-theme">Decoration</FieldLabel>
        <NativeSelect id="decoration-theme" value={options.theme}
          onChange={(event) => onOptions({ theme: event.currentTarget.value as DecorationTheme })}>
          <NativeSelectOption value="none">None</NativeSelectOption>
          <NativeSelectOption value="coastal">Coastal</NativeSelectOption>
          <NativeSelectOption value="cherry-blossom">Cherry blossom</NativeSelectOption>
          <NativeSelectOption value="flower-field">Flower field</NativeSelectOption>
          <NativeSelectOption value="characters">Characters</NativeSelectOption>
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel>Playback</FieldLabel>
        <SegmentedControl ariaLabel="Playback" value={options.mode}
          onValueChange={(mode) => onOptions({ mode: mode as ExampleOptions["mode"] })}
          options={[{ value: "static", label: "Static" }, { value: "interactive", label: "Interactive" }]} />
      </Field>
      <Field>
        <FieldLabel htmlFor="decoration-intensity">Intensity</FieldLabel>
        <Slider id="decoration-intensity" min={0} max={100} value={options.intensity * 100}
          onValueChange={(value) => onOptions({ intensity: value / 100 })} />
      </Field>
      <Field>
        <FieldLabel>Appearance</FieldLabel>
        <SegmentedControl ariaLabel="Appearance" value={options.tone} onValueChange={(theme) => onChange({ theme: theme as "light" | "dark" })}
          options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
      </Field>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="decoration-wallpaper">App wallpaper</FieldLabel>
        <Switch id="decoration-wallpaper" checked={options.wallpaper} onCheckedChange={(wallpaper) => onOptions({ wallpaper })} />
      </Field>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="decoration-width">375 frame</FieldLabel>
        <Switch id="decoration-width" checked={state.width === "375"} onCheckedChange={(checked) => onChange({ width: checked ? "375" : "app" })} />
      </Field>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="decoration-motion">Reduce motion</FieldLabel>
        <Switch id="decoration-motion" checked={state.motion === "reduced"}
          onCheckedChange={(checked) => onChange({ motion: checked ? "reduced" : "full" })} />
      </Field>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="decoration-inside">Keep inside</FieldLabel>
        <Switch id="decoration-inside" checked={options.inside} disabled={options.theme !== "characters"}
          onCheckedChange={(inside) => onOptions({ inside })} />
      </Field>
    </Grid>
  );
}
