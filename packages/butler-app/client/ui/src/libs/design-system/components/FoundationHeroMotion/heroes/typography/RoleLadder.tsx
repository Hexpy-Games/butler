import type { CSSProperties, ReactNode } from "react";
import { Label } from "../../../Label";
import { Typo } from "../../../Typo";
import type { TypeCopy } from "./typeCopy";
import { FLIGHTS, METRIC_ROLL, type Flight } from "./typeChoreography";
import { Reveal } from "./Reveal";
import t from "./TypographyHero.module.css";

/** Role tag of each rung: the Typo role (or component) the sample is set in. */
const ROLE: Record<Flight, string> = {
  title: "H2", dash: "Dashboard", field: "Label", ask: "Body", command: "Code", meta: "Caption", metric: "Metric",
};

/** 1,284 with every digit on a tabular roller strip, so it can count up in place. */
function Roller({ value }: { value: string }) {
  let digit = 0;
  return (
    <>
      {[...value].map((char, index) => {
        if (!/\d/u.test(char)) return <span key={index}>{char}</span>;
        const k = digit++;
        return (
          <span className={t.digit} key={index}>
            <span className={t.digitStrip} data-t={`digit-${k}`} style={{ "--d": Number(char) } as CSSProperties}>
              {Array.from({ length: 10 }, (_, n) => <span key={n}>{n}</span>)}
            </span>
            <span className={t.digitSpace}>{char}</span>
          </span>
        );
      })}
    </>
  );
}

/** The sample of one rung, set in the same role (and component) as the text it flies into. */
function sample(flight: Flight, copy: TypeCopy): ReactNode {
  switch (flight) {
    case "title": return <Typo.H2 as="div"><Reveal name="rf-title">{copy.title}</Reveal></Typo.H2>;
    case "dash": return <Typo.DashboardTitle as="div"><Reveal name="rf-dash">{copy.dash}</Reveal></Typo.DashboardTitle>;
    case "field": return <Label><Reveal name="rf-field">{copy.field}</Reveal></Label>;
    case "ask": return <Typo.Body><Reveal name="rf-ask">{copy.ask}</Reveal></Typo.Body>;
    case "command": return <Typo.Code as="div"><Reveal name="rf-command">{copy.command}</Reveal></Typo.Code>;
    case "meta": return <Typo.Caption as="div" tone="tertiary" numeric="tabular"><Reveal name="rf-meta">{copy.meta}</Reveal></Typo.Caption>;
    case "metric": return <Typo.MetricValue as="div" numeric="tabular"><Reveal name="rf-metric"><Roller value={METRIC_ROLL} /></Reveal></Typo.MetricValue>;
  }
}

/**
 * The role scale as a ladder of rungs: role tag, a live sample and its spec
 * (size/leading · weight read from the rendered sample). Each sample is later
 * the text that flies into a real component; the band behind it is its line
 * box, so leading reads as rhythm.
 */
export function RoleLadder({ copy, specs }: { copy: TypeCopy; specs: Partial<Record<Flight, string>> }) {
  return (
    <div className={t.ladder} data-t="ladder">
      {FLIGHTS.map((flight) => (
        <div className={t.rung} data-t={`rung-${flight}`} key={flight}>
          <span className={t.chrome} data-t={`chrome-${flight}`}>
            <span className={t.tag}><Reveal name={`rt-${flight}`}>{ROLE[flight]}</Reveal></span>
            <span className={t.spec}><Reveal name={`rs-${flight}`}>{specs[flight] ?? ""}</Reveal></span>
          </span>
          <span className={t.sampleCell}>
            <span className={t.band} data-t={`band-${flight}`} />
            <span className={t.fly} data-fly={flight} data-t={`fly-${flight}`}>{sample(flight, copy)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
