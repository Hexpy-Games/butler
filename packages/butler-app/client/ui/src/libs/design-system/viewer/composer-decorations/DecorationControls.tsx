import type { ReactNode } from "react";
import { NativeSelect, NativeSelectOption } from "../../components/NativeSelect";
import { Slider } from "../../components/Slider";
import { Switch } from "../../components/Switch";
import { Typo } from "../../components/Typo";
import type { ViewerState } from "../viewerState";
import type { DecorationSettings } from "./types";
import styles from "./decorations.module.css";

function Choice({ label, value, options, onChange }: {
  label: string; value: string; options: [string, string][]; onChange: (value: string) => void;
}) {
  return <label className={styles.field}><Typo.Caption>{label}</Typo.Caption>
    <NativeSelect aria-label={label} value={value} stretch onChange={event => onChange(event.target.value)}>
      {options.map(([id, text]) => <NativeSelectOption key={id} value={id}>{text}</NativeSelectOption>)}
    </NativeSelect></label>;
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className={styles.toggle}><Typo.Caption>{label}</Typo.Caption>
    <Switch aria-label={label} checked={checked} onCheckedChange={onChange} /></label>;
}
export function DecorationControls({ settings: s, update, state, onChange }: {
  settings: DecorationSettings; update: (patch: Partial<DecorationSettings>) => void;
  state: ViewerState; onChange: (patch: Partial<ViewerState>) => void;
}) {
  const choice = <K extends keyof DecorationSettings>(key: K, label: string, options: [string, string][]): ReactNode =>
    <Choice label={label} value={String(s[key])} options={options} onChange={value => update({ [key]: value })} />;
  return <div className={styles.controls}>
    {choice("theme", "Decoration", [["none", "None"], ["flowers", "Flower field"], ["cherry", "Cherry blossom"], ["characters", "Characters"], ["coastal", "Coastal scene · 해안가"]])}
    {choice("mode", "Mode", [["static", "Static"], ["interactive", "Interactive"]])}
    <label className={styles.field}><Typo.Caption>Intensity · {s.intensity}%</Typo.Caption>
      <Slider aria-label="Intensity" value={s.intensity} min={0} max={100} onValueChange={intensity => update({ intensity })} /></label>
    {s.theme === "coastal" ? choice("framing", "Coastal framing", [["full", "Full card"], ["band", "Top band"]])
      : choice("placement", "Placement", [["inside", "Inside top band"], ["edge", "Above card edge"]])}
    {s.theme === "characters" ? <Toggle label="Character overflow" checked={s.overflow} onChange={overflow => update({ overflow })} /> : null}
    {s.theme !== "coastal" ? choice("palette", "Palette", [["garden", "Garden"], ["dusk", "Dusk"]]) : null}
    <Choice label="Appearance" value={state.theme === "dark" ? "dark" : "light"} options={[["light", "Light"], ["dark", "Dark"]]}
      onChange={theme => onChange({ theme: theme as "light" | "dark" })} />
    <Toggle label="Photo wallpaper" checked={s.wallpaper} onChange={wallpaper => update({ wallpaper })} />
    <Toggle label="375 frame" checked={s.phone} onChange={phone => update({ phone })} />
    <Toggle label="Reduce motion" checked={state.motion === "reduced"} onChange={reduced => onChange({ motion: reduced ? "reduced" : "full" })} />
  </div>;
}
