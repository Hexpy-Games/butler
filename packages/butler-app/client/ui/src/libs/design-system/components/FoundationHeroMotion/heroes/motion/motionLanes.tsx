import { type HeroLayout } from "../shared/grid";

/** Each lane's run (canvas px): the distance every puck covers in the same time. */
export const TRACK: Record<HeroLayout, number> = { wide: 460, tall: 190 };

/** Ticks on the metronome: four bars of four. */
export const TICKS = 16;
