import type { CSSProperties } from "react";
import { Annotations } from "../shared/Annotations";
import { openingItems } from "../shared/guides";
import { spaceToken, valueLabel } from "../shared/labels";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import type { Annot, Geometry } from "../shared/types";
import { STEPS, type SpacingCopy } from "./spacingCopy";
import s from "./SpacingHero.module.css";

/**
 * The token field: the 4px baseline grid (drawn in with a sweep) and the
 * named steps as a staircase of measure blocks, each block the token's own
 * height and three times as wide. `data-m="cell"` is the grid cell the
 * camera pushes into.
 */
export function SpacingField() {
  return (
    <div className={s.field} data-m="field">
      <span className={s.gridWin} data-t="grid"><span className={s.gridIn} data-t="grid-in" /></span>
      <span className={s.cell} data-m="cell" />
      <div className={s.stairs}>
        {STEPS.map(([name, px], k) => (
          <div className={s.step} key={name}>
            <span className={s.stepName}><R name={`sp-n${k}`}>{`--space-${name}`}</R></span>
            <span className={s.block} data-t={`sp-b${k}`} style={{ "--w": `var(--space-${name})` } as CSSProperties} />
            <span className={s.stepValue}><R name={`sp-v${k}`}>{String(px)}</R></span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Guides of the wireframe: every gap and inset it is built from, with its value. */
export const WIRE_ANNOTS: Annot[] = [
  { kind: "gap", from: "w-head", to: "w-card", label: valueLabel(spaceToken, true) },
  { kind: "pad", target: "w-card", label: valueLabel("--settings-section-padding", true) },
  { kind: "gap", from: "w-l1", to: "w-i1", label: valueLabel(spaceToken, true) },
  { kind: "gap", from: "w-f1", to: "w-f2", label: valueLabel("--settings-field-gap", true) },
  { kind: "gap", from: "w-card", to: "w-btns", label: valueLabel(spaceToken, true) },
  { kind: "gap", from: "w-b1", to: "w-b2", label: valueLabel(spaceToken, true) },
];

/** Fields shown on the tall canvas only. */
export const EXTRA = [3, 4, 5, 6] as const;

/** A blueprint box of the wireframe, drawn in through a window (`wb-<n>`). */
function Box({ n, kind }: { n: string; kind: "line" | "short" | "input" | "button" }) {
  return (
    <Mark block n={n}>
      <span className={s.win} data-t={`wb-${n}`}><span className={s.box} data-kind={kind} data-t={`wb-${n}-in`} /></span>
    </Mark>
  );
}

function field(k: number) {
  return (
    <Mark block n={`w-f${k}`}>
      <div className={s.wField}><Box kind="short" n={`w-l${k}`} /><Box kind="input" n={`w-i${k}`} /></div>
    </Mark>
  );
}

/** One copy of the settings wireframe; its gaps and insets are the real tokens. */
function Screen({ compact = false, scope }: { compact?: boolean; scope?: string }) {
  return (
    <div className={s.screen} data-compact={compact ? "" : undefined} data-mark-scope={scope} data-t={compact ? "wire-b" : "wire-a"}>
      <Box kind="line" n="w-head" />
      <Mark block n="w-card">
        <div className={s.wCard}>
          {field(1)}{field(2)}
          {/* More fields on the tall canvas, so the screen fills the portrait frame. */}
          {EXTRA.map((k) => <div className={s.extra} key={k}>{field(k)}</div>)}
        </div>
      </Mark>
      <Mark block n="w-btns"><div className={s.wButtons}><Box kind="button" n="w-b1" /><Box kind="button" n="w-b2" /></div></Mark>
    </div>
  );
}

/**
 * Scene 3: a settings screen as blueprint outlines, left of the poster. Its
 * gaps fill as hatched bands, each measured by a bracket with its token;
 * then it breathes to the compact rhythm and back (a second copy).
 */
export function SpacingWire({ g, copy }: { g: Geometry | null; copy: SpacingCopy }) {
  return (
    <div className={s.wire} data-t="wire">
      <div className={s.wireStage} data-m="wire">
        <span className={s.mode}>
          <span className={s.modeLayer} data-t="mode-a"><R name="mode-a-t">{copy.comfortable}</R></span>
          <span className={s.modeLayer} data-t="mode-b">{copy.compact}</span>
        </span>
        <div className={s.screens}>
          <div className={s.screenA}>
            <Screen scope="wire" />
            {g ? <Annotations items={openingItems(WIRE_ANNOTS, g.scopes.wire ?? {}, "w", g.layout)} shown /> : null}
          </div>
          <Screen compact />
        </div>
      </div>
    </div>
  );
}
