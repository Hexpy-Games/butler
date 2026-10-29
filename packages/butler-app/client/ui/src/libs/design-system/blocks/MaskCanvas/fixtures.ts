// Showcase mask: a lake picture with the sun painted, so generating and reveal states show a region.
import { fixturePicture } from "../../components/MediaFrame/fixtures";
import type { MaskStroke } from "./maskStrokes";

export const MASK_PICTURE = { src: fixturePicture("place"), width: 400, height: 320 } as const;

/** The edited picture: the same lake with a moon in place of the sun. */
export const MASK_RESULT = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='320' viewBox='0 0 400 320'><rect width='400' height='320' fill='#29405a'/>"
  + "<circle cx='300' cy='96' r='30' fill='#eef1f5'/><circle cx='314' cy='86' r='26' fill='#29405a'/></svg>",
)}`;

/** A loose circle over the sun, as a user would paint it. */
export const SUN_STROKES: MaskStroke[] = [
  { tool: "brush", size: 40, points: Array.from({ length: 25 }, (_, step): [number, number] => {
    const angle = (step / 24) * Math.PI * 2;
    return [300 + Math.cos(angle) * 30, 96 + Math.sin(angle) * 30];
  }) },
  { tool: "brush", size: 44, points: [[300, 96]] },
];

export const MASK_LABELS = {
  "en-US": { picture: "Lake under hills", brush: "Brush", eraser: "Eraser", undo: "Undo", size: "Brush size", compare: "Hold to compare", send: "Edit" },
  "ko-KR": { picture: "언덕 아래 호수", brush: "브러시", eraser: "지우개", undo: "실행 취소", size: "브러시 크기", compare: "길게 눌러 비교", send: "편집" },
} as const;
