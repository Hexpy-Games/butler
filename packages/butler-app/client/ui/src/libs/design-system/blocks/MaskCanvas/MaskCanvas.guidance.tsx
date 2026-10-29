import { useRef } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { IconButton } from "../../components/IconButton";
import { Undo } from "../../components/Icons";
import { MediaFrame } from "../../components/MediaFrame";
import { Stack } from "../../components/Stack";
import { MASK_PICTURE, SUN_STROKES } from "./fixtures";
import { MaskCanvas, type MaskCanvasHandle } from "./MaskCanvas";

// #region recipe: Mark the region to edit
function MarkRegion() {
  const canvas = useRef<MaskCanvasHandle>(null);
  return (
    <Stack gap="sm">
      <IconButton label="Undo" onClick={() => canvas.current?.undo()}><Undo size="sm" /></IconButton>
      <Stack UNSAFE_style={{ height: 240 }}>
        <MaskCanvas ref={canvas} {...MASK_PICTURE} alt="Lake under hills" tool="brush" brushSize={32} defaultStrokes={SUN_STROKES} />
      </Stack>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A picture with a paint layer for marking the region an image edit may change, with the generating shimmer and the masked reveal of the result.",
  whenToUse: ["Marking the part of a picture an edit should change", "Showing an edit in progress and its result inside the marked region"],
  whenNotToUse: [
    { when: "Viewing a picture large", use: "ImageViewer" },
    { when: "A picture in a card or a message", use: "MediaFrame" },
  ],
  recipes: [{ name: "Mark the region to edit", description: "The product owns the toolbar (brush, eraser, size, undo) and sends toMask() with the instruction.", render: () => <MarkRegion /> }],
  doDont: [
    {
      do: { caption: "Keep the picture's own width and height; the mask is exported at exactly that size.", render: () => <MarkRegion /> },
      dont: { caption: "Do not paint on a scaled preview; the mask would not line up with the picture.", render: () => <MediaFrame aspect="1:1" src={MASK_PICTURE.src} alt="" /> },
    },
  ],
  content: [
    "alt names the picture; the paint layer itself is decorative.",
    "Toolbar copy is one word per tool (Brush / 브러시, Eraser / 지우개, Undo / 실행 취소).",
  ],
  accessibility: [
    "The frame is an image named by alt. Painting needs a pointer; an edit without a mask stays possible, so keyboard users can still edit the whole picture.",
    "The brush outline follows the pointer and is sized in screen pixels.",
    "Reduced motion stops the shimmer band (the wash stays); the result still fades in.",
  ],
  tokens: ["--accent", "--neutral-white", "--shadow-control", "--radius-control", "--shimmer-duration", "--motion-loop-count", "--motion-deliberate", "--motion-fast", "--motion-ease-linear", "--motion-ease-standard"],
};
