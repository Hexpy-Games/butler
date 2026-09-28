import type { CSSProperties, ReactNode } from "react";
import { Label } from "../../../Label";
import { Typo } from "../../../Typo";
import type { TypeCopy } from "./typeCopy";
import { FLIGHTS, METRIC_ROLL, type Flight } from "./typeChoreography";
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
    case "title": return <Typo.H2 as="div">{copy.title}</Typo.H2>;
    case "dash": return <Typo.DashboardTitle as="div">{copy.dash}</Typo.DashboardTitle>;
    case "field": return <Label>{copy.field}</Label>;
    case "ask": return <Typo.Body>{copy.ask}</Typo.Body>;
    case "command": return <Typo.Code as="div">{copy.command}</Typo.Code>;
    case "meta": return <Typo.Caption as="div" tone="tertiary" numeric="tabular">{copy.meta}</Typo.Caption>;
    case "metric": return <Typo.MetricValue as="div" numeric="tabular"><Roller value={METRIC_ROLL} /></Typo.MetricValue>;
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
            <span className={t.tag}>{ROLE[flight]}</span>
            <span className={t.spec}>{specs[flight] ?? ""}</span>
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
