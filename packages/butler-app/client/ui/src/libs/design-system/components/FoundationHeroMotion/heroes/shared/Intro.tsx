import type { Key, Track } from "../../heroTimeline";
import { Reveal as R, reveal, select } from "./Reveal";
import s from "./Intro.module.css";

/** Beat marks of an intro: the title reveals, the lead lines follow a beat apart, then everything pushes up and out. */
export const INTRO = { title: 0.4, lead: 1.4, out: 6.4 } as const;

export type IntroLead = Array<[key: string, text: string]>;

/**
 * Scene 1 of a chapter: its title large on the left and its intent line by
 * line on the right (below on the tall canvas), set above the poster
 * (`data-m="intro"` for the camera).
 */
export function Intro({ title, lead }: { title: string; lead: IntroLead }) {
  return (
    <div className={s.intro} data-m="intro">
      <div className={s.introTitle} data-t="i-title"><R name="i-t">{title}</R></div>
      <div className={s.introLead}>
        {lead.map(([key, text], n) => (
          <p className={s.leadLine} data-t={`i-p${n}`} key={key}>
            <span className={s.leadKey}><R name={`i-k${n}`}>{key}</R></span>
            <span className={s.leadText}><R name={`i-l${n}`}>{text}</R></span>
          </p>
        ))}
      </div>
    </div>
  );
}

/** The intro's motion: title, then each lead line (its key, then its text), left to right; then up and out from `out`. */
export function introTracks(title: string, lead: IntroLead, close: number, out: number = INTRO.out): Track[] {
  const leave = (name: string, delay: number): Track => ({
    select: select(name),
    keys: [
      { at: 0, y: 0, o: 1 }, { at: out + delay, y: 0, o: 1 }, { at: out + delay + 1, y: -56, o: 0, ease: "accelerate" },
      { at: close - 0.01, y: -56, o: 0 }, { at: close, y: 0, o: 1 },
    ] satisfies Key[],
  });
  return [
    ...reveal("i-t", INTRO.title, title, close),
    ...lead.flatMap(([key, text], n) => [...reveal(`i-k${n}`, INTRO.lead + n, key, close), ...reveal(`i-l${n}`, INTRO.lead + n + 0.3, text, close)]),
    leave("i-title", 0), ...lead.map((_, n) => leave(`i-p${n}`, 0.15 * (n + 1))),
  ];
}
