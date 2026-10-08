import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { dsStyle } from "../../lib/internal";
import { Box } from "../Box";
import { Button } from "../Button";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";

const COPY = {
  "en-US": {
    page: "shop.example.com · checkout", title: "Page message", host: "shop.example.com",
    message: "Cancel this order? The coupon can't be returned.", cancel: "Cancel", ok: "OK", show: "Show again",
  },
  "ko-KR": {
    page: "shop.example.com · 결제", title: "페이지 메시지", host: "shop.example.com",
    message: "주문을 취소할까요? 취소하면 쿠폰은 돌려받을 수 없어요.", cancel: "취소", ok: "확인", show: "다시 보기",
  },
} as const;

/**
 * A page's own dialog (confirm, sign-in) anchored in the page card: the scrim covers only the card,
 * the rest of the window stays usable (`modal={false}`), and page text is quoted under a Butler title.
 */
export function ContainedDialogDemo({ locale }: ShowcaseRenderContext) {
  const copy = COPY[locale];
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(true);
  return (
    <Stack gap="sm">
      <div ref={setCard} style={{ position: "relative", height: 300, overflow: "hidden", borderRadius: "var(--radius-popover)",
        border: "var(--border-hairline) solid var(--line)" }}>
        <Box surface="raised" padding="md" style={dsStyle({ height: "100%" })}><Typo.Caption tone="secondary">{copy.page}</Typo.Caption></Box>
        {card ? (
          <Dialog open={open} onOpenChange={setOpen} modal={false}>
            <DialogContent container={card} showCloseButton={false} role="alertdialog">
              <DialogHeader>
                <DialogTitle>{copy.title}</DialogTitle>
                <DialogDescription>{copy.host}</DialogDescription>
              </DialogHeader>
              <Box surface="muted" radius="control" padding="md"><Typo.Body>{copy.message}</Typo.Body></Box>
              <DialogFooter>
                <Button size="sm" variant="outline" text={copy.cancel} onClick={() => setOpen(false)} />
                <Button size="sm" text={copy.ok} onClick={() => setOpen(false)} />
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>
      {open ? null : <Button size="sm" variant="outline" text={copy.show} onClick={() => setOpen(true)} />}
    </Stack>
  );
}
