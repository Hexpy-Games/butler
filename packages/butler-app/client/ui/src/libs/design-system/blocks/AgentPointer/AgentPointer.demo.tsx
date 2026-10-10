import { useLayoutEffect, useState, type ReactNode } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { shopCardRect, shopPage, testPage } from "../BrowserPane/fixtures/pages";
import { AgentPointer, type AgentPointerLabels, type AgentPointerMode, type AgentPointerPoint, type AgentPointerRect, type AgentPointerTone } from "./AgentPointer";

type Locale = ShowcaseRenderContext["locale"];

export const POINTER_LABELS: Record<Locale, AgentPointerLabels> = {
  "en-US": { butler: "Butler", looking: "Looking", typing: "Typing", waiting: "Waiting", awaitingApproval: "Awaiting approval", needInput: "Waiting for your input" },
  "ko-KR": { butler: "버틀러", looking: "보는 중", typing: "입력 중", waiting: "기다리는 중", awaitingApproval: "승인 기다리는 중", needInput: "직접 입력을 기다리는 중" },
};

const SEARCH = { x: 820, y: 20, width: 300, height: 32 };

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

/** Page geometry (1280 × 800 CSS pixels) in layer pixels for one stage. */
export interface StageScale {
  width: number;
  height: number;
  rect: (rect: AgentPointerRect) => AgentPointerRect;
  /** Where the pointer rests on a product card. */
  cardPoint: (card: number) => AgentPointerPoint;
}

/** A page at 16:10 with a pointer layer on top; `children` gets the layer size and page-to-layer mapping. */
export function PageStage({ locale, page = "shop", caption, children, ...data }: {
  locale: Locale; page?: "shop" | "white" | "black" | "photo"; caption?: string; children: (scale: StageScale) => ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const width = useWidth(node);
  const k = width / 1280;
  const rect = (r: AgentPointerRect) => ({ x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k });
  const cardPoint = (card: number) => { const r = rect(shopCardRect(card)); return { x: r.x + r.width * 0.55, y: r.y + r.height * 0.45 }; };
  const src = page === "shop" ? shopPage(locale) : testPage(page);
  return (
    <Stack gap="xs">
      <div ref={setNode} style={{ position: "relative", aspectRatio: "16 / 10", overflow: "hidden", borderRadius: "var(--radius-control)",
        border: "var(--border-hairline) solid var(--line)", backgroundImage: `url("${src}")`, backgroundSize: "cover" }} data-pointer-page={page} {...data}>
        {width ? children({ width, height: Math.round(800 * k), rect, cardPoint }) : null}
      </div>
      {caption ? <Typo.Caption tone="tertiary">{caption}</Typo.Caption> : null}
    </Stack>
  );
}

export interface PointerStageProps {
  locale: Locale;
  mode: AgentPointerMode;
  tone?: AgentPointerTone;
  page?: "shop" | "white" | "black" | "photo";
  /** Product card the pointer acts on (0–7). */
  card?: number;
  reducedMotion?: boolean;
  caption?: string;
}

/** A page at 16:10 with Butler's pointer in one mode; geometry is page pixels times the scale. */
export function PointerStage({ locale, mode, tone, page = "shop", card = 0, reducedMotion, caption }: PointerStageProps) {
  return (
    <PageStage locale={locale} page={page} caption={caption}>
      {({ width, height, rect, cardPoint }) => {
        const target = mode === "type" ? rect(SEARCH) : rect(shopCardRect(card));
        const at = mode === "scroll" ? { x: width - 40, y: height * 0.55 } : mode === "type"
          ? { x: target.x + target.width * 0.78, y: target.y + target.height * 0.62 } : cardPoint(card);
        const steps = [0, 1, 2].map((index) => { const r = rect(shopCardRect(index)); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        return (
          <AgentPointer mode={mode} tone={tone} at={mode === "batch" ? steps[2]! : at} target={mode === "batch" ? rect(shopCardRect(2)) : target} steps={steps}
            from={mode === "click" || mode === "observe" ? { x: 72 * width / 1280, y: 470 * width / 1280 } : undefined}
            value={mode === "type" ? (locale === "ko-KR" ? "사무용 의자" : "office chair") : undefined}
            width={width} height={height} labels={POINTER_LABELS[locale]} reducedMotion={reducedMotion} />
        );
      }}
    </PageStage>
  );
}

/** Diagonal hops across the product grid, so every glide shows its curve. */
const LAB_CARDS = [4, 3, 0, 7];

/**
 * Drives the pointer like the overlay renderer does: "Next target" clicks the next product (a curved glide
 * and a new ring), pressing it mid-glide retargets from where the arrow is, "Whole page" observes the full
 * page (no ring: the PageCard edge already shows it).
 */
export function MotionLab({ locale, reducedMotion }: { locale: Locale; reducedMotion?: boolean }) {
  const [hop, setHop] = useState({ index: 0, previous: 0, whole: false });
  const ko = locale === "ko-KR";
  return (
    <Stack gap="sm">
      <ButtonContainer size="sm">
        <Button size="sm" variant="outline" data-ds-motion="step" data-pointer-lab-next text={ko ? "다음 대상" : "Next target"}
          onClick={() => setHop({ index: hop.index + 1, previous: hop.index, whole: false })} />
        <Button size="sm" variant="outline" data-pointer-lab-page text={ko ? "페이지 전체" : "Whole page"}
          onClick={() => setHop({ ...hop, previous: hop.index, whole: true })} />
      </ButtonContainer>
      <PageStage locale={locale} data-pointer-lab={reducedMotion ? "reduced" : "motion"}>
        {({ width, height, rect, cardPoint }) => {
          const card = LAB_CARDS[hop.index % LAB_CARDS.length]!;
          return (
            <AgentPointer mode={hop.whole ? "observe" : "click"} at={cardPoint(card)}
              target={hop.whole ? { x: 0, y: 0, width, height } : rect(shopCardRect(card))}
              from={hop.index === hop.previous ? undefined : cardPoint(LAB_CARDS[hop.previous % LAB_CARDS.length]!)}
              width={width} height={height} labels={POINTER_LABELS[locale]} reducedMotion={reducedMotion} />
          );
        }}
      </PageStage>
    </Stack>
  );
}
