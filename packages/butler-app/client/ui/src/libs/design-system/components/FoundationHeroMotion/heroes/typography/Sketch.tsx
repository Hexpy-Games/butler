import type { Track } from "../../heroTimeline";
import { Sketch as SharedSketch, sketchTracks as sharedSketchTracks, type SketchBox } from "../shared/Sketch";
import { BEATS, type Panel } from "./typeChoreography";

/** The shared blueprint (see ../shared/Sketch.tsx), one per product panel. */
export function Sketch({ panel, boxes }: { panel: Panel; boxes: SketchBox[] }) {
  return <SharedSketch boxes={boxes} id={panel} />;
}

export function sketchTracks(panel: Panel, boxes: SketchBox[], start: number, retract: number): Track[] {
  return sharedSketchTracks(panel, boxes, start, retract, BEATS - 0.05);
}
