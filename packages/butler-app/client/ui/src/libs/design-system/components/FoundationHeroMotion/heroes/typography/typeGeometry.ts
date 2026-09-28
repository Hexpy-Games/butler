import type { Box } from "../../heroTimeline";
import type { Flight, Panel } from "./typeChoreography";
import type { TypeLayout } from "./typeGrid";
import type { LineInfo } from "./typeLines";

/** A box the blueprint draws, with the corner radius of the real element (px). */
export type SketchBox = Box & { r: number };

/** Boxes of the poster layout in canvas px, as measured on the live components. */
export interface TypeGeometry {
  layout: TypeLayout;
  canvas: { w: number; h: number };
  specimen: Box;
  /** Poster scale of the specimen (laid out at Act I size, drawn small). */ specimenScale: number;
  ladder: Box;
  rungs: Record<Flight, Box>;
  fly: Record<Flight, Box>;
  /** Text lines each component builds, measured in their panels. */
  lines: LineInfo[];
  /** Boxes the blueprint sketches in each panel (the panel first), relative to the panel. */
  sketches: Record<Panel, SketchBox[]>;
  panels: Record<Panel, Box>;
  control: Box;
  tnum: Box;
  controlTrack: number;
  readoutLine: number;
  digitLine: number;
  digits: number[];
}
