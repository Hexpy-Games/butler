import { useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentPointer, MessageSquarePlus, PickOutline, Scrap, SelectionBar, Stack, setReducedMotionOverride, type PickOutlineProps, type AgentPointerProps } from "@/butler-ds";
import { getAppCopy, type AppLocale } from "../../../../../../butler-i18n/src/index";
import "@/butler-ds/tokens.css";
type Frame = AgentPointerProps & PickOutlineProps & { locale: AppLocale; pointerVisible: boolean; picking: boolean; selectionCount: number; tab: string };
declare global { interface Window { butlerBrowserOverlay?: {
  subscribe: (handler: (frame: Frame) => void) => () => void;
  chrome: (id: string, rect: { x: number; y: number; width: number; height: number } | null) => void;
  command: (op: string, id: string, point?: { x: number; y: number }) => void;
} } }
function BrowserPointerOverlay() {
  const [frame, setFrame] = useState<Frame>();
  useEffect(() => window.butlerBrowserOverlay?.subscribe(next => {
    setReducedMotionOverride(next.reducedMotion === true);
    document.documentElement.lang = next.locale; setFrame(next);
  }), []);
  useLayoutEffect(() => {
    if (!frame) return;
    const box = document.querySelector('[data-slot="selection-bar"]')?.getBoundingClientRect();
    window.butlerBrowserOverlay?.chrome(frame.tab, box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null);
  }, [frame]);
  if (!frame) return null;
  const copy = getAppCopy(frame.locale).browser;
  const command = (op: string) => window.butlerBrowserOverlay?.command(op, frame.tab);
  return <>
    {frame.pointerVisible && <AgentPointer {...frame} labels={{ butler: copy.pointerButler, looking: copy.pointerLooking, typing: copy.pointerTyping,
      waiting: copy.pointerWaiting, awaitingApproval: copy.pointerAwaitingApproval, needInput: copy.pointerNeedInput }} />}
    <PickOutline width={frame.width} height={frame.height} hover={frame.picking ? frame.hover : undefined} hoverLabel={frame.hoverLabel} picks={frame.picks} reducedMotion={frame.reducedMotion} />
    {(frame.picking || frame.selectionCount > 0) && <Stack onPointerDownCapture={event => {
      if (frame.selectionCount > 0 && !(event.target as Element).closest("button")) window.butlerBrowserOverlay?.command("drag", frame.tab, { x: event.clientX, y: event.clientY });
    }}><SelectionBar count={frame.selectionCount} label={copy.picked(frame.selectionCount)} compact={!frame.picking} hint={copy.pickHint} emptyReason={copy.pickFirst}
      clearLabel={copy.clearSelection} onClear={() => command("clear")}
      actions={[
        { id: "attach", label: copy.attachToChat, icon: <MessageSquarePlus size="sm" />, onSelect: () => command("attach") },
        { id: "scrap", label: copy.scrap, icon: <Scrap size="sm" />, onSelect: () => command("scrap") },
      ]} /></Stack>}
  </>;
}
createRoot(document.getElementById("root")!).render(<BrowserPointerOverlay />);
