import { useEffect, useState } from "react";
import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { OperationOutputView } from "@/app/types";
import { absoluteGatewayUrl, messageFileSource } from "@/app/messageFileUrls";
import { ArtifactPreviewImage, Clickable, Stack } from "@/butler-ds";
import { openImageViewer, type ViewerImage } from "../media/imageViewerState";
import { focusBrowserTab } from "./browserBridge";

interface Still { tab: string; still_file: { url: string; signed_url?: string } }
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
  return [...(typeof record.tab==="string" && record.still_file ? [record as unknown as Still] : []), ...children];
}
/** Images are a desktop-only timeline projection, never a provider image attachment. */
export function BrowserStepStill({ turnId, callId, resultId, content }: { turnId: string; callId: string; resultId: string; content?: string }) {
  const [images, setImages] = useState<Still[]>([]);
  const sessionId = useButlerStore((state) => state.activeChatId);
  useEffect(() => {
    if (!window.butlerBrowser) return;
    let active = true;
    setImages([]);
    const controller = new AbortController();
    const read = async () => {
      if (content && !findDelivery(content)) { if (active) setImages(allStills(content)); return; }
      while (active) {
        const value = await api<OperationOutputView & { browser_stills?: { complete: boolean } }>(`/turns/${encodeURIComponent(turnId)}/operations/${encodeURIComponent(callId)}/output?result_id=${encodeURIComponent(resultId)}&offset=0`, { signal: controller.signal });
        if (active) setImages(value.browser_stills ? allStills(value.browser_stills).slice(-1) : allStills(value.content));
        if (!value.browser_stills || value.browser_stills.complete) return;
      }
    };
    void read().catch(() => {});
    return () => { active = false; controller.abort(); };
  }, [turnId, callId, resultId, content]);
  if (!window.butlerBrowser || images.length === 0) return null;
  const unique = [...new Map(images.filter(item => /^\/message-files\/file-[0-9a-f-]{36}$/iu.test(item.still_file.url)).map(item => [item.still_file.url, item])).values()];
  // The step's screenshots open the image viewer as one set; its "open" focuses the live tab.
  const shots: ViewerImage[]=unique.map(item=>{
    const src=absoluteGatewayUrl(messageFileSource(item.still_file) ?? item.still_file.url);
    return { src, alt: appCopy.browser.still, sessionId, openSource: () => focusBrowserTab(item.tab, sessionId, src) };
  });
  return <Stack cross="start" data-test-class="browser-step-still">
    {unique.map((item, index)=>
      <Clickable variant="text" key={item.still_file.url} aria-label={appCopy.conversation.imageViewer.viewImage(appCopy.browser.still)} onClick={()=>openImageViewer(shots, index)}>
        <ArtifactPreviewImage src={shots[index]!.src} alt={appCopy.browser.still} width={320} />
      </Clickable>)}
  </Stack>;
}
