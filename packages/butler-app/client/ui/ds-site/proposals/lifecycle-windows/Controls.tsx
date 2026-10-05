import type { ReactNode } from "react";
import {
  BUILTIN_WALLPAPERS, Box, Button, ButtonContainer, NativeSelect, NativeSelectOption, SegmentedControl, Stack, Typo,
  wallpaperLabelText,
} from "@/butler-ds";
import { PAGE_COPY } from "./copy";
import {
  QUIT_STATES, STARTUP_STATES, WALLPAPER_IDS, type LifecycleState, type PageWidth, type WallpaperId,
} from "./state";

export function Control({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap="xs">
      <Typo.Label>{label}</Typo.Label>
      {children}
    </Stack>
  );
}

const options = <T extends string>(values: Record<T, string>) =>
  (Object.keys(values) as T[]).map((value) => ({ value, label: values[value] }));

/** One button per state; the selected state is the filled button (a review-page switch, not product UI). */
export function StateSwitch<T extends string>({ label, states, labels, value, onChange, onPlay, playLabel }: {
  label: string; states: readonly T[]; labels: Record<T, string>; value: T;
  onChange: (value: T) => void; onPlay: () => void; playLabel: string;
}) {
  return (
    <Control label={label}>
      <ButtonContainer size="xs" role="group" aria-label={label}>
        {states.map((state) => (
          <Button key={state} size="xs" variant={state === value ? "default" : "secondary"} aria-pressed={state === value}
            onClick={() => onChange(state)}>{labels[state]}</Button>
        ))}
        <Button size="xs" variant="ghost" onClick={onPlay}>{playLabel}</Button>
      </ButtonContainer>
    </Control>
  );
}

export function Controls({ state, width, update, setWidth }: {
  state: LifecycleState; width: PageWidth;
  update: (patch: Partial<LifecycleState>) => void; setWidth: (width: PageWidth) => void;
}) {
  const copy = PAGE_COPY[state.locale];
  const wallpaperName = (id: WallpaperId) => {
    if (id === "none") return copy.none;
    const module = BUILTIN_WALLPAPERS.get(id);
    return module ? wallpaperLabelText(module.manifest.name, state.locale) : id;
  };
  return (
    <Box surface="raised" border="hairline" radius="panel" padding="lg">
      <Stack align="row" wrap gap="lg" rowGap="md">
        <Control label={copy.variant}>
          <SegmentedControl ariaLabel={copy.variant} size="sm" value={state.variant} options={options(copy.variants)}
            onValueChange={(value) => update({ variant: value as LifecycleState["variant"] })} />
        </Control>
        <Control label={copy.theme}>
          <SegmentedControl ariaLabel={copy.theme} size="sm" value={state.theme} options={options(copy.themes)}
            onValueChange={(value) => update({ theme: value as LifecycleState["theme"] })} />
        </Control>
        <Control label={copy.wallpaper}>
          <NativeSelect aria-label={copy.wallpaper} size="sm" value={state.wallpaper}
            onChange={(event) => update({ wallpaper: event.target.value as WallpaperId })}>
            {WALLPAPER_IDS.map((id) => <NativeSelectOption key={id} value={id}>{wallpaperName(id)}</NativeSelectOption>)}
          </NativeSelect>
        </Control>
        <Control label={copy.backdrop}>
          <SegmentedControl ariaLabel={copy.backdrop} size="sm" value={state.backdrop} options={options(copy.backdrops)}
            onValueChange={(value) => update({ backdrop: value as LifecycleState["backdrop"] })} />
        </Control>
        <Control label={copy.motion}>
          <SegmentedControl ariaLabel={copy.motion} size="sm" value={state.motion} options={options(copy.motions)}
            onValueChange={(value) => update({ motion: value as LifecycleState["motion"] })} />
        </Control>
        <Control label={copy.language}>
          <SegmentedControl ariaLabel={copy.language} size="sm" value={state.locale}
            options={[{ value: "ko-KR", label: "한국어" }, { value: "en-US", label: "English" }]}
            onValueChange={(value) => update({ locale: value as LifecycleState["locale"] })} />
        </Control>
        <Control label={copy.width}>
          <SegmentedControl ariaLabel={copy.width} size="sm" value={width} options={options(copy.widths)}
            onValueChange={(value) => setWidth(value as PageWidth)} />
        </Control>
      </Stack>
    </Box>
  );
}

export { QUIT_STATES, STARTUP_STATES };
