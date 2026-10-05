import {
  Grid, NativeSelect, NativeSelectOption, SegmentedControl, SettingsField, SettingsSection, Stack, Switch, Typo,
  wallpaperLabelText,
} from "@/butler-ds";
import type { ProposalCopy } from "./copy";
import { DECORATION_REGISTRY, PAGE_WALLPAPERS, type DecorationTheme, type PageWallpaper } from "./decorationScenes";
import type { ProposalState } from "./proposalState";

/** What ships: two fields in Settings → Appearance, right under Wallpaper / Motion / Pause on battery. */
export function SettingsPreview({ copy, state, onChange }: {
  copy: ProposalCopy;
  state: ProposalState;
  onChange: (patch: Partial<ProposalState>) => void;
}) {
  return (
    <SettingsSection id="composer-decoration" kind="form">
      <SettingsField id="composer-decoration-theme" label={copy.label} description={copy.description}
        control={(
          <SegmentedControl ariaLabel={copy.label} value={state.decor} onValueChange={(decor) => onChange({ decor: decor as DecorationTheme })}
            options={[
              { value: "none", label: copy.none },
              { value: "shoreline", label: copy.shoreline },
              { value: "cherry-blossom", label: copy.cherryBlossom },
            ]} />
        )} />
      <SettingsField id="composer-decoration-character" label={copy.character} description={copy.characterDescription}
        control={<Switch id="composer-decoration-character" checked={state.character} onCheckedChange={(character) => onChange({ character })} />} />
    </SettingsSection>
  );
}

function Knob({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack gap="xs">
      <Typo.Label tone="secondary">{label}</Typo.Label>
      {children}
    </Stack>
  );
}

/** Review-only knobs (not product UI). */
export function PreviewKnobs({ state, onChange }: { state: ProposalState; onChange: (patch: Partial<ProposalState>) => void }) {
  const lang = state.locale === "ko" ? "ko-KR" : "en-US";
  return (
    <Grid columns="auto-fit" gap="lg">
      <Knob label="Theme">
        <SegmentedControl ariaLabel="Theme" size="sm" value={state.theme} onValueChange={(theme) => onChange({ theme: theme as ProposalState["theme"] })}
          options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "both", label: "Both" }]} />
      </Knob>
      <Knob label="Width">
        <SegmentedControl ariaLabel="Width" size="sm" value={state.width} onValueChange={(width) => onChange({ width: width as ProposalState["width"] })}
          options={[{ value: "desktop", label: "Desktop" }, { value: "375", label: "375" }]} />
      </Knob>
      <Knob label="Motion">
        <SegmentedControl ariaLabel="Motion" size="sm" value={state.motion} onValueChange={(motion) => onChange({ motion: motion as ProposalState["motion"] })}
          options={[{ value: "full", label: "Full" }, { value: "reduced", label: "Reduced" }]} />
      </Knob>
      <Knob label="Language">
        <SegmentedControl ariaLabel="Language" size="sm" value={state.locale} onValueChange={(locale) => onChange({ locale: locale as ProposalState["locale"] })}
          options={[{ value: "en", label: "EN" }, { value: "ko", label: "KO" }]} />
      </Knob>
      <Knob label="Page wallpaper">
        <NativeSelect aria-label="Page wallpaper" size="sm" stretch value={state.wallpaper}
          onChange={(event) => onChange({ wallpaper: event.currentTarget.value as PageWallpaper })}>
          {PAGE_WALLPAPERS.map((id) => {
            const module = id === "none" ? null : DECORATION_REGISTRY.get(id);
            return <NativeSelectOption key={id} value={id}>{module ? wallpaperLabelText(module.manifest.name, lang) : "None"}</NativeSelectOption>;
          })}
        </NativeSelect>
      </Knob>
    </Grid>
  );
}
