import { cloneElement, type ReactElement, type SVGProps } from "react";
import type { Key, Track } from "../../heroTimeline";
import { select } from "./Reveal";
import s from "./StrokeReveal.module.css";

/** A static vector revealed through counter-moving windows, without repainting its stroke. */
export function StrokeReveal({ name, children }: { name: string; children: ReactElement<SVGProps<SVGElement>> }) {
  return (
    <span className={s.window} data-t={name}>
      <span className={s.content} data-t={`${name}-in`}>
        <svg className={s.svg}>
          {cloneElement(children, { className: `${children.props.className ?? ""} ${s.shape}` })}
        </svg>
      </span>
    </span>
  );
}

/** Preserve the stroke's reveal and fade beats; only the clipping windows move. */
export function strokeTracks(name: string, keys: Key[]): Track[] {
  const length = Math.max(...keys.map((key) => key.dash ?? 0), 1);
  const window = (sign: number) => keys.map(({ dash, ...key }) => ({
    ...key,
    ...(dash === undefined ? {} : { xp: sign * 100 * dash / length }),
  }));
  return [
    { select: select(name), keys: window(-1) },
    { select: select(`${name}-in`), keys: window(1).map(({ o: _opacity, ...key }) => key) },
  ];
}
