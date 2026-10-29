import { useRef, useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { Brush, Eraser, Undo } from "../../components/Icons";
import { Slider } from "../../components/Slider";
import { Stack } from "../../components/Stack";
import { MASK_LABELS, MASK_PICTURE, MASK_RESULT, SUN_STROKES } from "./fixtures";
import { MaskCanvas, type MaskCanvasHandle, type MaskTool } from "./MaskCanvas";

export const meta: ShowcaseMeta = {
  title: "MaskCanvas",
  category: "Documents & Artifacts",
  tags: ["image", "mask", "edit", "canvas", "brush", "motion"],
  status: "beta",
};

type Locale = ShowcaseRenderContext["locale"];

/** Paint with the brush, erase, undo; the toolbar is the product's (shown here for the flow). */
function Painting({ locale }: { locale: Locale }) {
  const copy = MASK_LABELS[locale];
  const canvas = useRef<MaskCanvasHandle>(null);
  const [tool, setTool] = useState<MaskTool>("brush");
  const [size, setSize] = useState(32);
  const [strokes, setStrokes] = useState(0);
  return (
    <Stack gap="sm">
      <ButtonContainer size="icon-sm">
        <IconButton label={copy.brush} aria-pressed={tool === "brush"} onClick={() => setTool("brush")}><Brush size="sm" /></IconButton>
        <IconButton label={copy.eraser} aria-pressed={tool === "eraser"} onClick={() => setTool("eraser")}><Eraser size="sm" /></IconButton>
        <IconButton label={copy.undo} disabled={strokes === 0} onClick={() => canvas.current?.undo()}><Undo size="sm" /></IconButton>
      </ButtonContainer>
      <Slider aria-label={copy.size} min={8} max={96} value={size} onValueChange={setSize} />
      <Stack UNSAFE_style={{ height: 280 }}>
        <MaskCanvas ref={canvas} {...MASK_PICTURE} alt={copy.picture} tool={tool} brushSize={size} onChange={(state) => setStrokes(state.strokes)} />
      </Stack>
    </Stack>
  );
}

function Frame({ locale, generating = false, result, compare = false }: { locale: Locale; generating?: boolean; result?: string; compare?: boolean }) {
  const copy = MASK_LABELS[locale];
  return (
    <Stack UNSAFE_style={{ height: 280 }}>
      <MaskCanvas {...MASK_PICTURE} alt={copy.picture} tool="brush" brushSize={32} defaultStrokes={SUN_STROKES}
        generating={generating} resultSrc={result} compareSrc={compare ? MASK_RESULT : undefined} />
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Paint, erase, undo", widths: ["375", "app"], render: ({ locale }) => <Painting locale={locale} /> },
  { name: "Painted region", widths: ["375", "app"], render: ({ locale }) => <Frame locale={locale} /> },
  { name: "Generating: the region shimmers", states: ["loading"], widths: ["375", "app"], render: ({ locale }) => <Frame locale={locale} generating /> },
  { name: "Result fades in inside the region", widths: ["375", "app"], render: ({ locale }) => <Frame locale={locale} result={MASK_RESULT} /> },
  { name: "Compare: another picture, mask hidden", widths: ["375"], render: ({ locale }) => <Frame locale={locale} compare /> },
];
