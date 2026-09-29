import { type ReactNode } from "react";
import { Button } from "../../../Button";
import { SegmentedControl } from "../../../SegmentedControl";
import { SelectButton } from "../../../Select";
import { Tag } from "../../../Tag";
import { Reveal as R } from "../shared/Reveal";
import { RAILS, type SizingCopy } from "./sizingCopy";
import s from "./SizingHero.module.css";

const noop = () => undefined;

/** The controls on the staff, one per rail (xs to lg), each exactly its rail's height. */
function railControls(copy: SizingCopy): ReactNode[] {
  return [
    <Tag key="xs" size="md">{copy.tag}</Tag>,
    <SegmentedControl ariaLabel={copy.period} key="sm" onValueChange={noop} options={[{ value: "d", label: copy.day }, { value: "w", label: copy.week }]} size="sm" value="w" />,
    <SelectButton aria-label={copy.model} data-size="sm" key="md">{copy.auto}</SelectButton>,
    <Button key="lg" size="lg" text={copy.find} />,
  ];
}

/**
 * The staff: four lanes, each exactly one control height tall (the live
 * token) between two rail lines, labelled at the left; a real control sits
 * in each. `name` prefixes the timeline's parts.
 */
export function Staff({ copy, name }: { copy: SizingCopy; name?: string }) {
  const controls = railControls(copy);
  const t = (part: string) => (name ? `${name}-${part}` : undefined);
  return (
    <div className={s.staff}>
      {RAILS.map((rail, k) => (
        <div className={s.lane} data-rail={rail.name} key={rail.name}>
          <span className={s.laneLabel} data-t={t(`l${k}`)}>{name ? <R name={`${name}-lt${k}`}>{`${rail.name} ${rail.px}`}</R> : `${rail.name} ${rail.px}`}</span>
          <span className={s.laneBody}>
            <span className={s.laneFill} data-t={t(`f${k}`)} />
            <span className={s.note} data-k={k} data-t={t(`c${k}`)}>{controls[k]}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
