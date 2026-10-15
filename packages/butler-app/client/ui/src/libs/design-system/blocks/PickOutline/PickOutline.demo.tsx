import { useLayoutEffect, useState } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { shopCardRect, shopPage, testPage } from "../BrowserPane/fixtures/pages";
import { PickOutline, type PickOutlineRect } from "./PickOutline";

type Locale = "en-US" | "ko-KR";

function useWidth(node: HTMLElement | null) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!node) return undefined;
    const measure = () => setWidth(node.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return width;
}

/** The page's header bar (1280×72): the top-edge case, where the hover tag has no room above. */
const HEADER = { x: 0, y: 0, width: 1280, height: 72 };

export interface PickStageProps {
  page?: "shop" | "white" | "black" | "photo";
  locale?: Locale;
  /** Product cards (0–7) picked, in order. */
  picked?: number[];
  /** Product card under the pointer, or `header` for the page's top bar. */
  hover?: number | "header";
  reducedMotion?: boolean;
  caption?: string;
}

/** A page at 16:10 with the user's pick marks; rects are page pixels times the scale. */
export function PickStage({ page = "shop", locale = "en-US", picked = [0, 1], hover = 2, reducedMotion, caption }: PickStageProps) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const width = useWidth(node);
  const scale = width / 1280;
  const s = (rect: PickOutlineRect) => ({ x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale });
  const hoverRect = hover === "header" ? HEADER : shopCardRect(hover);
  const label = `${hover === "header" ? "header" : "div.card"} · ${hoverRect.width} × ${hoverRect.height}`;
  return (
    <Stack gap="xs">
      <div ref={setNode} style={{ position: "relative", aspectRatio: "16 / 10", overflow: "hidden", borderRadius: "var(--radius-control)",
        border: "var(--border-hairline) solid var(--line)", backgroundImage: `url("${page === "shop" ? shopPage(locale) : testPage(page)}")`,
        backgroundSize: "cover" }} data-pick-page={page}>
        {width ? (
          <PickOutline width={width} height={Math.round(800 * scale)} hover={s(hoverRect)} hoverLabel={label} reducedMotion={reducedMotion}
            picks={picked.map((index) => ({ id: `card-${index}`, rect: s(shopCardRect(index)) }))} />
        ) : null}
      </div>
      {caption ? <Typo.Caption tone="tertiary">{caption}</Typo.Caption> : null}
    </Stack>
  );
}
