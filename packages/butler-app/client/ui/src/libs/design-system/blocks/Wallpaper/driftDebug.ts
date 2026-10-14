// The live state of a drifting print for a debugger (read-only, computed only when asked).
import type { DriftCore } from "./driftCore";

export interface DriftDebugState {
  mode: string;
  host: string;
  hidden: boolean;
  dirty: boolean;
  flow: number;
  segmentAlpha: number | null;
  keyframes: number;
  lastKeyframeAgoMs: number | null;
  layerOpacity: readonly [number, number];
}

export function driftDebugState(core: DriftCore, layerOpacity: readonly [number, number], now: number): DriftDebugState {
  return {
    mode: core.mode, host: core.host, hidden: core.hidden, dirty: core.dirty, flow: core.displayFlow(now),
    segmentAlpha: core.seg ? core.segAlpha(now) : null, keyframes: core.keyframes,
    lastKeyframeAgoMs: core.keyframeAt ? Math.round(now - core.keyframeAt) : null, layerOpacity,
  };
}
