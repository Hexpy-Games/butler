import type { Ref } from "react";
import type { MaskStroke } from "./maskStrokes";

export type { MaskStroke };

export type MaskTool = "brush" | "eraser";

export interface MaskCanvasHandle {
  /** Removes the last stroke. */
  undo(): void;
  clear(): void;
  /** PNG at the picture's size: transparent where painted (the edit region), opaque elsewhere; null when nothing is painted. */
  toMask(): Promise<Blob | null>;
}

export interface MaskCanvasState {
  /** Strokes that undo can remove. */
  strokes: number;
  /** Nothing is painted (eraser can empty a painted mask). */
  empty: boolean;
}

export interface MaskCanvasProps {
  ref?: Ref<MaskCanvasHandle>;
  src: string;
  /** Names the picture for assistive tech. */
  alt: string;
  /** The picture's own size: the mask has exactly these pixels. */
  width: number;
  height: number;
  tool: MaskTool;
  /** Brush diameter in screen pixels, whatever the picture's zoom. */
  brushSize: number;
  onChange?: (state: MaskCanvasState) => void;
  /** Strokes a new picture starts with (a mask kept for a retry); undo can remove them. */
  defaultStrokes?: readonly MaskStroke[];
  /** Painting is off (sending, comparing). */
  disabled?: boolean;
  /** Shows this picture in place of `src` and hides the mask while set (press-and-hold compare). */
  compareSrc?: string;
  /** The painted region shimmers while the edit runs. Reduced motion keeps it still. */
  generating?: boolean;
  /** A new picture that fades in inside the painted region only; `onResultShown` follows the fade. */
  resultSrc?: string;
  onResultShown?: () => void;
}
