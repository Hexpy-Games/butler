import { useLayoutEffect, useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../../components/Button";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { shopCardRect, shopPage, testPage } from "../BrowserPane/fixtures/pages";
import { AgentPointer, type AgentPointerLabels, type AgentPointerMode, type AgentPointerTone } from "./AgentPointer";

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
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const width = useWidth(node);
  const scale = width / 1280;
  const height = Math.round(800 * scale);
  const s = (rect: { x: number; y: number; width: number; height: number }) => ({ x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale });
  const target = mode === "type" ? s(SEARCH) : s(shopCardRect(card));
  const at = mode === "scroll" ? { x: width - 40, y: height * 0.55 } : mode === "type"
    ? { x: target.x + target.width * 0.78, y: target.y + target.height * 0.62 } : { x: target.x + target.width * 0.55, y: target.y + target.height * 0.45 };
  const steps = [0, 1, 2].map((index) => { const rect = s(shopCardRect(index)); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
  const src = page === "shop" ? shopPage(locale) : testPage(page);
  return (
    <Stack gap="xs">
      <div ref={setNode} style={{ position: "relative", aspectRatio: "16 / 10", overflow: "hidden", borderRadius: "var(--radius-control)",
        border: "var(--border-hairline) solid var(--line)", backgroundImage: `url("${src}")`, backgroundSize: "cover" }} data-pointer-page={page}>
        {width ? (
          <AgentPointer mode={mode} tone={tone} at={mode === "batch" ? steps[2]! : at} target={mode === "batch" ? s(shopCardRect(2)) : target} steps={steps}
            from={mode === "click" || mode === "observe" ? { x: 72 * scale, y: 470 * scale } : undefined}
            value={mode === "type" ? (locale === "ko-KR" ? "사무용 의자" : "office chair") : undefined}
            width={width} height={height} labels={POINTER_LABELS[locale]} reducedMotion={reducedMotion} />
        ) : null}
      </div>
      {caption ? <Typo.Caption tone="tertiary">{caption}</Typo.Caption> : null}
    </Stack>
  );
}

/** Steps the pointer across three products: it glides on --motion-pointer-glide (jumps when reduced). */
export function GlideDemo({ locale }: { locale: Locale }) {
  const [card, setCard] = useState(0);
  return (
    <Stack gap="sm">
      <Button size="sm" variant="outline" data-ds-motion="step" text={locale === "ko-KR" ? "다음 대상" : "Next target"} onClick={() => setCard((card + 1) % 3)} />
      <PointerStage locale={locale} mode="click" card={card} />
    </Stack>
  );
}
