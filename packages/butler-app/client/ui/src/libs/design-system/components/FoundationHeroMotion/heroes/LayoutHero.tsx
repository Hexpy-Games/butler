import { type CSSProperties } from "react";
import { HeroReadout } from "./HeroReadout";
import v from "../heroVariants.module.css";

/** Reflow geometry in rem: tile, gap, frame padding, and the visible rows of every frame. */
const TILE = 2.25;
const GAP = 0.5;
const PAD = 0.75;
const ROWS = 2;
const COLUMNS = [3, 2, 1];
const PITCH = TILE + GAP;
const frameWidth = (columns: number) => columns * PITCH - GAP + 2 * PAD;
const FRAME_HEIGHT = ROWS * PITCH - GAP + 2 * PAD;

function tileVars(index: number): Record<string, number> {
  return Object.fromEntries(COLUMNS.flatMap((columns, breakpoint) => {
    const row = Math.floor(index / columns);
    const b = breakpoint + 1;
    return [
      [`--x${b}`, -frameWidth(columns) / 2 + PAD + (index % columns) * PITCH],
      [`--y${b}`, -FRAME_HEIGHT / 2 + PAD + row * PITCH],
      [`--o${b}`, row < ROWS ? 1 : 0],
    ];
  }));
}

/** 10 Layout and platform: six tiles reflow as the frame narrows from three columns to one and back. */
export function LayoutHero() {
  const frame = Object.fromEntries(COLUMNS.map((columns, index) => [`--hero-w${index + 1}`, frameWidth(columns)]));
  return (
    <>
    <span className={v.reflow} style={{ ...frame, "--hero-frame-h": `${FRAME_HEIGHT}rem`, "--hero-tile": `${TILE}rem` } as CSSProperties}>
      <span className={v.doorLeft} />
      <span className={v.doorMiddle} />
      <span className={v.doorRight} />
      {Array.from({ length: 6 }, (_, index) => (
        <span className={v.tile} data-lead={index === 0 ? "" : undefined} key={index} style={tileVars(index) as CSSProperties} />
      ))}
    </span>
    {/* Steps walk desktop, tablet, phone, tablet; each step moves to the next. */}
    <HeroReadout slots={4} poster={3} items={[2, 1, 2, 3].map((columns) => `repeat(${columns}, 1fr)`)} />
    </>
  );
}
