import { useState, type PointerEvent } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cropImage, stripCrop } from "../BrowserPane/fixtures/pages";
import { ICONS } from "../TabStrip/TabStrip.demo";
import { DragPreview, type DragPreviewPoint } from "./DragPreview";

type Locale = "en-US" | "ko-KR";

const COPY = {
  "en-US": { hint: "Move the pointer over the area", blocked: "Can't drop here", tab: "Search results — Shop" },
  "ko-KR": { hint: "영역 위로 포인터를 움직여 보세요", blocked: "여기에는 놓을 수 없어요", tab: "검색 결과 — 쇼핑" },
} as const;

export interface FloatingStageProps {
  locale: Locale;
  kind: "elements" | "tab";
  /** Where the preview starts (before the pointer moves), in stage pixels. */
  start?: DragPreviewPoint;
}

/**
 * A drag area whose right third refuses the drop: the floating preview follows the pointer in stage pixels
 * (`strategy="absolute"`) and flips to the no-entry badge over the refusing part.
 */
export function FloatingStage({ locale, kind, start = { x: 56, y: 40 } }: FloatingStageProps) {
  const [at, setAt] = useState(start);
  const [width, setWidth] = useState(0);
  const copy = COPY[locale];
  const invalid = width > 0 && at.x > width * (2 / 3);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setWidth(box.width);
    setAt({ x: event.clientX - box.left, y: event.clientY - box.top });
  };
  return (
    <Stack gap="xs">
      <div onPointerMove={move} data-drag-stage={kind} style={{ position: "relative", height: 180, overflow: "hidden", borderRadius: "var(--radius-control)",
        border: "var(--border-hairline) dashed var(--line-strong)", backgroundImage: "linear-gradient(90deg, transparent 66.6%, var(--muted) 66.6%)" }}>
        <DragPreview kind={kind} strategy="absolute" at={at} invalid={invalid} title={copy.tab} icon={<img src={ICONS.shop} alt="" />}
          images={[{ src: cropImage(0) }, { src: stripCrop("heading", locale) }]} count={3} />
      </div>
      <Typo.Caption tone="tertiary">{invalid ? copy.blocked : copy.hint}</Typo.Caption>
    </Stack>
  );
}
