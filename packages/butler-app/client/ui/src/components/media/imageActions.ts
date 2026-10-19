import { getAppCopy, getAppLocale } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { openConversationLink } from "../browser/browserBridge";
import { saveLibrary } from "../browser/libraryStore";
import { jpegBlob, pngBlob } from "./imageEncode";
import type { ViewerImage } from "./imageViewerState";

/** Read time as the source line shows it: today's time or a short date. */
export function checkedLabel(checked: string | undefined): string | undefined {
  if (!checked) return undefined;
  const locale = getAppLocale();
  const date = new Date(checked);
  if (Number.isNaN(date.getTime())) return undefined;
  const today = date.toLocaleDateString(locale) === new Date().toLocaleDateString(locale);
  return today ? date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }) : date.toLocaleDateString(locale, { dateStyle: "short" });
}

export function siteOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).hostname.replace(/^www\./u, ""); } catch { return undefined; }
}

async function imageBlob(src: string): Promise<Blob> {
  if (/^https?:/iu.test(src)) window.butlerApp?.log?.({ level: "DEBUG", category: "http.client", event: "image.fetch", attrs: { url: new URL(src).origin } });
  const response = await fetch(src);
  if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) throw new Error("image_unavailable");
  return await response.blob();
}

/** The picture as a JPEG data URL: a 서랍 scrap's own copy of it (its crop). */
export async function imageDataUrl(src: string): Promise<string> {
  const blob = await jpegBlob(await imageBlob(src));
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function copyViewerImage(image: ViewerImage) {
  const png = await pngBlob(await imageBlob(image.src));
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  notifyStatus(getAppCopy(getAppLocale()).conversation.imageViewer.imageCopied);
}

export async function saveViewerImage(image: ViewerImage) {
  const copy = getAppCopy(getAppLocale()).conversation;
  await saveLibrary({ id: crypto.randomUUID(), kind: "scrap", title: image.caption ?? image.alt, url: image.source ?? "",
    site: siteOf(image.source), crop: await imageDataUrl(image.src), capturedAt: new Date().toISOString(),
    text: [image.caption, checkedLabel(image.checked)].filter(Boolean).join(" · ") });
  notifyStatus(copy.answerBlocks.savedToLibrary);
}

export async function openViewerSource(image: ViewerImage) {
  if (image.openSource) await image.openSource();
  else if (image.source) await openConversationLink(image.source, image.sessionId);
}
