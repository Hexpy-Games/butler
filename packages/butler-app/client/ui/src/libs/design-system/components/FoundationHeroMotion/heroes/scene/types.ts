import type { ReactNode } from "react";
import type { Box, Key, Pose, Track } from "../../heroTimeline";
import type { HeroLayout } from "../shared/grid";
import type { Marks } from "../shared/types";

/**
 * The scene hero contract (v3 chapters). A chapter is its own sequence of
 * scenes, each a region in a canvas-sized cell on the camera's path (one axis
 * per move), then a finale: the poster's tiles, packed edge to edge by the
 * chapter's grid, fly in from the frame's nearest edges while the camera
 * moves on to the poster, which holds (it is also the reduced-motion still).
 * Scenes and tiles are real DS components; motion only moves, fades, draws,
 * rounds and resizes what the static layout shows.
 */
export interface SceneGeometry {
  layout: HeroLayout;
  canvas: { w: number; h: number };
  /** Boxes of every `data-m` element, relative to the world, and the scene cell each belongs to. */
  boxes: Record<string, Box>;
  boxCell: Record<string, string>;
  /** Marks inside each `data-mark-scope` element, relative to it (canvas px). */
  scopes: Record<string, Marks>;
  /** Line height of every `data-roller` readout. */
  lines: Record<string, number>;
  /** Grapheme count of every reveal (`data-rv`). */
  chars: Record<string, number>;
  /** Each poster tile, in canvas px. */
  tiles: Record<string, Box>;
}

export interface SceneContext {
  /** The geometry, with every box of a scene moved to its scene cell. */
  g: SceneGeometry;
  cells: Record<string, { x: number; y: number }>;
  /** The camera on a scene: centred on the cell (one-axis moves), zoomed to fit `content`. */
  view: (cell: string, content: Box, fill?: number, cap?: number) => Pose;
  /** Where a scene region is moved to (canvas px), for a scene's own overlays. */
  offset: (cell: string) => { x: number; y: number };
  close: number;
  /** The finale: the camera leaves the last scene and the tiles gather. */
  finale: number;
  loop: number;
  beats: number;
}

/** The poster's grid on one canvas: columns and rows (CSS track lists) and the areas, one string per row, named after the tiles. */
export interface PosterLayout {
  columns: string;
  rows: string;
  areas: string[];
}

export interface SceneSpec {
  /** Short code for the hero's scope. */
  code: string;
  /** The scene cells, in order (the intro first). */
  scenes: string[];
  regions: Record<string, ReactNode | ((g: SceneGeometry | null) => ReactNode)>;
  /** The poster's tiles by grid-area name. */
  tiles: Record<string, ReactNode>;
  poster: Record<HeroLayout, PosterLayout>;
  /** The poster is laid out this much larger (CSS zoom), per canvas (default 1 wide, 1.2 tall). */
  posterZoom?: Partial<Record<HeroLayout, number>>;
  /**
   * When a scene region shows, in beats (default: the whole prelude): a scene
   * next to a wide zoom-out stays hidden until the camera heads for it.
   */
  spans?: Partial<Record<string, [from: number, to?: number]>>;
  /** A layer fixed to the frame over the camera (a metronome along the bottom edge), kept through the finale. */
  hud?: ReactNode;
  /** Beat the last scene ends (the finale begins). */
  end: (g: SceneGeometry) => number;
  /** The scenes' motion and the camera through them (it must end on the last scene). */
  tracks: (ctx: SceneContext) => { tracks: Track[]; camera: Key[] };
}
