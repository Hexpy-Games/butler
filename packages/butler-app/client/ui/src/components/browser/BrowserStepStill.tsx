import { useEffect, useState } from "react";
import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { OperationOutputView } from "@/app/types";
import { absoluteGatewayUrl, messageFileSource } from "@/app/messageFileUrls";
import { Clickable, MediaFrame, Stack, Tooltip, Caption } from "@/butler-ds";
import { openImageViewer, type ViewerImage } from "../media/imageViewerState";
import { focusBrowserTab } from "./browserBridge";

interface Still { tab: string; step?: number; state?: string; reason?: string; still_file?: { url: string; signed_url?: string } }
interface Delivery { act_id: string; complete: boolean; steps: Still[] }
function findDelivery(value: unknown, depth = 0): { id: string; session: string } | undefined {
  if (depth > 8) return;
  if (typeof value === "string") { try { return findDelivery(JSON.parse(value), depth + 1); } catch { return; } }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const pending = record.still_pending as { id?: unknown; session?: unknown } | undefined;
  if (typeof pending?.id === "string" && typeof pending.session === "string") return { id: pending.id, session: pending.session };
  for (const item of Object.values(record)) { const found = findDelivery(item, depth + 1); if (found) return found; }
}
function allStills(value: unknown): Still[] {
  if (typeof value === "string") {try {return allStills(JSON.parse(value));} catch {return [];}}
  if (!value || typeof value !== "object") return [];
  const record=value as Record<string, unknown>;
  const children=Object.values(record).flatMap(allStills);
  const images = [...(typeof record.tab === "string" && record.still_file ? [record as unknown as Still] : []), ...children];
  return [...new Map(images.map(item => [item.still_file?.url, item])).values()];
}
/** Images are a desktop-only timeline projection, never a provider image attachment. */
export function BrowserStepStill({ turnId, callId, resultId, content }: { turnId: string; callId: string; resultId: string; content?: string }) {
  const [images, setImages] = useState<Still[]>([]);
  const sessionId = useButlerStore((state) => state.activeChatId);
  useEffect(() => {
    if (!window.butlerBrowser) return;
    let active = true, reading = false, complete = false, changed = false;
    let unsubscribe: (() => void) | undefined;
    let deliveryKey = findDelivery(content);
    setImages([]);
    const controller = new AbortController();
    const read = async () => {
      const apply = (rows: Still[]) => { if (active) setImages(rows); };
      const marker = findDelivery(content);
      if (content && !marker) { apply(allStills(content)); settled(); return; }
      const value = await api<OperationOutputView & { browser_stills?: Delivery }>(`/turns/${encodeURIComponent(turnId)}/operations/${encodeURIComponent(callId)}/output?result_id=${encodeURIComponent(resultId)}&offset=0`, { signal: controller.signal });
      let delivery = value.browser_stills;
      apply(delivery?.steps ?? allStills(value.content));
      const pending = marker ?? findDelivery(value.content);
      deliveryKey = pending;
      if (!delivery || !pending) { settled(); return; }
      // Bound observation of an unavailable host; a future mount reads its durable state again.
      const until = Date.now() + 60_000;
      while (active && delivery && !delivery.complete && pending && Date.now() < until) {
        delivery = await api<Delivery>(`/browser-stills/${encodeURIComponent(delivery.act_id)}?session_id=${encodeURIComponent(pending.session)}&wait=1`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, until - Date.now()))]),
        });
        apply(delivery.steps);
      }
      if (delivery.complete) settled();
    };
    const settled = () => {
      complete = true; unsubscribe?.(); window.removeEventListener("focus", refresh);
    };
    const refresh = () => {
      if (!active || complete) return;
      if (reading) { changed = true; return; }
      reading = true; changed = false;
      void read().catch(() => {}).finally(() => { reading = false; if (changed) refresh(); });
    };
    // Reconnect and foreground changes can deliver a durable image after the
    // bounded wait ended. Resume on a change, never with an idle polling timer.
    const stopStills = window.butlerBrowser.onStill?.(receipt => {
      if (deliveryKey && receipt.id === deliveryKey.id && receipt.session === deliveryKey.session) { complete = false; refresh(); }
    });
    unsubscribe = window.butlerBrowser.subscribe(refresh);
    window.addEventListener("focus", refresh);
    if (complete) settled(); else refresh();
    return () => { active = false; controller.abort(); unsubscribe?.(); stopStills?.(); window.removeEventListener("focus", refresh); };
  }, [turnId, callId, resultId, content]);
  if (!window.butlerBrowser || images.length === 0) return null;
  const valid = (item: Still) => Boolean(item.still_file && /^\/message-files\/file-[0-9a-f-]{36}$/iu.test(item.still_file.url));
  const shots: ViewerImage[] = images.filter(valid).map(item => {
    const file = item.still_file!;
    const src = absoluteGatewayUrl(messageFileSource(file) ?? file.url);
    return { src, alt: appCopy.browser.still, sessionId, openSource: () => focusBrowserTab(item.tab, sessionId, src) };
  });
  let imageIndex = 0;
  return <Stack align="row" cross="start" data-test-class="browser-step-still"><Stack basis="md" shrink minWidth="0">
    {images.map((item, index) => {
      const shot = valid(item) ? shots[imageIndex++] : undefined;
      const selected = imageIndex - 1;
      const failed = item.state === "failed";
      const reason = appCopy.browser.stillFailure[item.reason ?? ""] ?? appCopy.browser.stillUnavailable;
      return <Tooltip key={item.step ?? index} label={failed ? reason : undefined}>
        <Clickable variant="text" stretch disabled={!shot} aria-label={appCopy.conversation.imageViewer.viewImage(appCopy.browser.still)} onClick={() => openImageViewer(shots, selected)}>
          <Stack grow minWidth="0"><MediaFrame src={shot?.src} alt={appCopy.browser.still} aspect="16:10" placeholder>
            {!shot && <Caption>{failed ? appCopy.browser.stillUnavailable : appCopy.browser.stillPending}</Caption>}
          </MediaFrame></Stack>
        </Clickable>
      </Tooltip>;
    })}
  </Stack></Stack>;
}
