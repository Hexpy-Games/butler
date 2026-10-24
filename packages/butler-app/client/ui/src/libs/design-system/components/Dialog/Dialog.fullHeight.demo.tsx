import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { dsStyle } from "../../lib/internal";
import { EmptyLine } from "../../blocks/EmptyLine";
import { ScrollArea } from "../../blocks/ScrollArea";
import { Box } from "../Box";
import { Button } from "../Button";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./Dialog";

const COPY = {
  "en-US": {
    page: "Project · Work", title: "Task graph", description: "Delegated work and how it connects.",
    empty: "No delegated work yet.", close: "Close", open: "Open in the window", show: "Show again",
  },
  "ko-KR": {
    page: "프로젝트 · 작업", title: "작업 그래프", description: "맡긴 작업과 그 연결.",
    empty: "아직 맡긴 작업이 없습니다.", close: "닫기", open: "창에서 열기", show: "다시 보기",
  },
} as const;

/** The dialog body: header, a nearly empty ScrollArea fill and the footer. */
function GraphDialogContent({ locale, container }: ShowcaseRenderContext & { container?: HTMLElement }) {
  const copy = COPY[locale];
  return (
    <DialogContent container={container} closeLabel={copy.close} size="full" layout="scroll-body" height="full">
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>
      <ScrollArea fill><EmptyLine message={copy.empty} /></ScrollArea>
      <DialogFooter>
        <DialogClose asChild><Button size="sm" variant="outline" text={copy.close} /></DialogClose>
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * `height="full"`: a scroll-body dialog whose body is nearly empty still fills its cap (here a page card;
 * from the button, the window) instead of collapsing to a strip around the empty line.
 */
export function FullHeightDialogDemo(context: ShowcaseRenderContext) {
  const copy = COPY[context.locale];
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(true);
  return (
    <Stack gap="sm">
      <div ref={setCard} style={{ position: "relative", height: 360, overflow: "hidden", borderRadius: "var(--radius-popover)",
        border: "var(--border-hairline) solid var(--line)" }}>
        <Box surface="raised" padding="md" style={dsStyle({ height: "100%" })}><Typo.Caption tone="secondary">{copy.page}</Typo.Caption></Box>
        {card ? <Dialog open={open} onOpenChange={setOpen} modal={false}><GraphDialogContent {...context} container={card} /></Dialog> : null}
      </div>
      <Stack align="row" gap="sm">
        {open ? null : <Button size="sm" variant="outline" text={copy.show} onClick={() => setOpen(true)} />}
        <Dialog>
          <DialogTrigger asChild><Button size="sm" variant="outline" text={copy.open} /></DialogTrigger>
          <GraphDialogContent {...context} />
        </Dialog>
      </Stack>
    </Stack>
  );
}
