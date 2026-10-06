import { useEffect, useState } from "react";
import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { OperationOutputView } from "@/app/types";
import { absoluteGatewayUrl, messageFileSource } from "@/app/messageFileUrls";
import { ArtifactPreviewImage, Clickable, Stack } from "@/butler-ds";
import { focusBrowserTab } from "./browserBridge";

interface Still { tab: string; still_file: { url: string; signed_url?: string } }
function findStill(value: unknown, depth = 0): Still | undefined {
  if (depth > 8) return undefined;
  if (typeof value === "string") {try {return findStill(JSON.parse(value),depth+1);} catch {return undefined;}}
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.tab === "string" && record.still_file && typeof record.still_file === "object") return record as unknown as Still;
  for (const item of Object.values(record)) { const found = findStill(item, depth + 1); if (found) return found; }
}
/** Images are a desktop-only timeline projection, never a provider image attachment. */
export function BrowserStepStill({ turnId, callId, resultId, content }: { turnId: string; callId: string; resultId: string; content?: string }) {
  const [still, setStill] = useState<Still>();
  const sessionId = useButlerStore((state) => state.activeChatId);
  useEffect(() => {
    if (!window.butlerBrowser) return;
    let active = true;
    const read = async () => {
      const text = content ?? (await api<OperationOutputView>(`/turns/${encodeURIComponent(turnId)}/operations/${encodeURIComponent(callId)}/output?result_id=${encodeURIComponent(resultId)}&offset=0`)).content;
      const found = findStill(JSON.parse(text));
      if (active) setStill(found);
    };
    void read().catch(() => {});
    return () => { active = false; };
  }, [turnId, callId, resultId, content]);
  if (!window.butlerBrowser || !still || !/^\/message-files\/file-[0-9a-f-]{36}$/iu.test(still.still_file.url)) return null;
  const src = absoluteGatewayUrl(messageFileSource(still.still_file) ?? still.still_file.url);
  return <Stack cross="start" data-test-class="browser-step-still">
    <Clickable aria-label={appCopy.browser.still} onClick={() => void focusBrowserTab(still.tab, sessionId, src)}>
      <ArtifactPreviewImage src={src} alt={appCopy.browser.still} width={320} />
    </Clickable>
  </Stack>;
}
