import type { ReactNode } from "react";
import type { Box, Key, Pose, Track } from "../../heroTimeline";
import type { HeroLayout } from "./grid";
import type { SketchBox } from "./Sketch";

/**
 * The chapter hero contract. Each chapter tells its own story in a prelude
 * (its own scenes, camera and tokens), then builds real DS components one at
 * a time, and ends on a finale that zooms out to the poster (the reduced-
 * motion still) where the chapter's token field and the components gather
 * onto the grid. The shared engine (ChapterHero.tsx) measures the poster and
 * compiles one cycle; the craft primitives (sketch, reveal, badges with
 * leaders, one transition length, the holds) are shared.
 */

/** What the engine reads from a marked element: its box, radius, padding and shadow, colors. */
export interface Measured {
  box: Box;
  r: number;
  /** Padding top, right, bottom, left (px). */
  pad: [number, number, number, number];
  shadow: { y: number; blur: number } | null;
  /** Text color and the flattened background behind it (rgb strings). */
  color: string;
  bg: string;
  /** The value an annotation measures (a gap, a padding, a size, a radius, a blur), set for its label. */
  value?: number;
}

export type Marks = Record<string, Measured>;

/** A note's text: its steps (each cuts to the next as the value applies), or a function of the measured marks. */
export type Label = string[] | ((mark: Measured, marks: Marks, layout: HeroLayout) => string[]);

/**
 * A guide and its note. In a build the note is a badge far out in the
 * gutter, joined to the guide by a leader. Zero or default values draw
 * nothing (their label returns no steps).
 */
export type Annot =
  | { kind: "pad"; target: string; label?: Label }
  | { kind: "gap"; from: string; to: string; label?: Label }
  | { kind: "size"; target: string; axis: "h" | "w"; label?: Label }
  | { kind: "radius"; target: string; label?: Label }
  /** A dashed box around the target, grown by `inflate` px or up to the height of the mark `inflateTo` (a hit area). */
  | { kind: "box"; target: string; inflate?: number; inflateTo?: string; label?: Label }
  | { kind: "ring"; target: string; label?: Label }
  | { kind: "center"; target: string; axis: "h" | "v"; label?: Label }
  | { kind: "shadow"; target: string; label?: Label }
  | { kind: "tag"; target: string; label: Label }
  | { kind: "contrast"; fg: string; bg: string; label?: Label };

export interface BuildStep {
  /** Reveal names (text) revealed left to right. */
  text?: string[];
  /** Mark names (parts) that appear with the text. */
  parts?: string[];
  annots?: Annot[];
  /** A shorter step: no pause of its own. */
  secondary?: boolean;
  /** Extra beats before this step (room for a component's own motion). */
  after?: number;
}

export interface BuildSpec {
  id: string;
  render: ReactNode;
  steps: BuildStep[];
  /** DS-internal elements to measure as marks: name → selector inside the panel. */
  marks?: Record<string, string>;
  /** Gutter the badges stand in (default left); "b" stacks them below the component (always so on the tall canvas), for wide components that should fill the frame. */
  side?: "l" | "r" | "b";
  /** The blueprint stays until the build is done (its outlines are the uncolored render the colors fill). */
  holdSketch?: boolean;
}

/** Beat marks of one compiled cycle, and where the prelude's scenes sit. */
export interface TimelineContext {
  /** The geometry, with every box of a scene moved to its scene cell. */
  g: Geometry;
  /** Centre of each prelude scene cell (world, canvas px). */
  cells: Record<string, { x: number; y: number }>;
  /** The camera on a prelude scene cell, centred on it (moves stay on one axis), zoomed to fit `content`. */
  view: (cell: string, content: Box, fill?: number, cap?: number) => Pose;
  beats: number;
  close: number;
  /** The first build starts here (the prelude's camera leaves one transition before). */
  first: number;
  builds: Record<string, { at: number; starts: number[]; done: number; leave: number }>;
  finale: number;
  loop: number;
}

/**
 * A chapter's own opening scenes. Each scene has a cell on the camera's path
 * (`cells`, in order; "field" is the poster's token field, shown in its own
 * cell before the builds); every other scene is a region, laid out
 * canvas-sized and centred (`data-m` names measured boxes).
 */
export interface Prelude {
  cells: string[];
  /** The scene regions by cell name; given the geometry once measured, for guides. */
  regions: Record<string, ReactNode | ((g: Geometry | null) => ReactNode)>;
  /** The beat the prelude's last scene ends and the camera leaves for the first build. */
  end: (g: Geometry) => number;
  /** Tracks of the prelude's elements (and of the field's contents), and camera keys from 0 to `end` (its first key is where the loop cuts back to). */
  tracks: (ctx: TimelineContext) => { tracks: Track[]; camera: Key[] };
}

export interface ChapterSpec {
  /** Short code for the hero's scope. */
  code: string;
  prelude: Prelude;
  /** The chapter's token field in the poster (a swatch grid, a scale…), beside the product; given the geometry once measured, for guides. */
  field: ReactNode | ((g: Geometry | null) => ReactNode);
  /** The field sits right of the product (wide canvas). */
  fieldRight?: boolean;
  /** Columns of the field on the wide canvas (default 4). */
  fieldColumns?: number;
  builds: BuildSpec[];
  /** Class of the product grid (grid areas named after the build ids), wide and tall. */
  product: string;
  /** The poster is laid out this much larger on the wide canvas (CSS zoom), so it fills the frame. */
  posterZoom?: number;
  /** The poster's zoom on the tall canvas (default 1.35); lower for components wider than the portrait column. */
  tallPosterZoom?: number;
  /** Chapter-specific motion on top of the shared cycle. */
  extra?: (ctx: TimelineContext) => Track[];
}

/** Everything measured on the poster, in canvas px. */
export interface Geometry {
  layout: HeroLayout;
  canvas: { w: number; h: number };
  /** Boxes of every `data-m` element, relative to the world (as laid out), and the scene cell each belongs to. */
  boxes: Record<string, Box>;
  boxCell: Record<string, string>;
  /** Marks inside each `data-mark-scope` element (prelude scenes, the field), relative to it. */
  scopes: Record<string, Marks>;
  /** Line height of every `data-roller` readout. */
  lines: Record<string, number>;
  field: Box;
  panels: Record<string, Box>;
  /** Blueprint boxes and marks of each panel, relative to it, in poster px (canvas px / posterZoom). */
  sketches: Record<string, SketchBox[]>;
  marks: Record<string, Marks>;
  /** Reveal and part names of each panel, in reading order. */
  panelOrder: Record<string, Array<{ name: string; part: boolean }>>;
  chars: Record<string, number>;
  /** Parts that appear left to right through a window, and parts whose color fades in. */
  sweeps: string[];
  fills: string[];
}
