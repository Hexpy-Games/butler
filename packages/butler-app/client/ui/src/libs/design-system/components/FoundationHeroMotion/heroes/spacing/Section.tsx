import { SettingsField } from "../../../../blocks/SettingsField";
import { SettingsSection } from "../../../../blocks/SettingsSection";
import { Switch } from "../../../Switch";
import { COMPACT_PAD, GAPS, type GapId, type SpacingCopy } from "./spacingCopy";
import { Gap } from "./Gap";
import { GapLabel } from "./GapLabel";
import { count } from "./spacingCount";
import s from "./SpacingHero.module.css";

function field(label: string, hint: string, on: boolean) {
  return <SettingsField control={<Switch aria-label={label} checked={on} onCheckedChange={() => undefined} />} description={hint} label={label} />;
}

/**
 * A real settings section (two fields) with its spaces measured: the header
 * gap and top inset above the first field, the field gap and the bottom inset
 * around the second. `name` prefixes the timeline's parts; `density` pins the
 * card inset (compact tightens only the inset); `labels` names each space
 * (`short`: the count only); `only` limits the columns to some spaces.
 */
export function Section({ copy, name, density = "comfortable", labels, only }: {
  copy: SpacingCopy; name?: string; density?: "comfortable" | "compact"; labels?: "full" | "short"; only?: GapId[];
}) {
  const px = (id: GapId) => (density === "compact" && (id === "pt" || id === "pb") ? COMPACT_PAD : GAPS[id].px);
  const gap = (id: GapId) => {
    const part = name ? `${name}-${id}` : undefined;
    const counted = !only || only.includes(id);
    const label = labels && part && counted ? <GapLabel note={labels === "full" ? GAPS[id].token : undefined} px={px(id)} reveal={`${part}-l`} /> : undefined;
    return <Gap id={id} label={label} n={counted ? count(px(id)) : 0} name={part} />;
  };
  return (
    <div className={s.section} data-density={density}>
      <SettingsSection id={`space-hero-${name ?? "tile"}`} kind="form" title={copy.general}>
        <div className={s.field}>{gap("hg")}{gap("pt")}{field(copy.sync, copy.syncHint, true)}</div>
        <div className={s.field}>{gap("fg")}{field(copy.sounds, copy.soundsHint, false)}{gap("pb")}</div>
      </SettingsSection>
    </div>
  );
}
