import { createContext, useContext } from "react";
import type { AnswerCardView } from "../../../../shared/answer-blocks-view";
import { getAppCopy, getAppLocale } from "@/app/copy";
import { faviconSrc } from "@/app/favicons";
import { gatewayImageSource } from "@/app/messageFileUrls";
import { notifyError, notifyStatus } from "@/app/notifications";
import { openConversationLink } from "../browser/browserBridge";
import { snapshotAppPart } from "../browser/appSnapshot";
import { saveLibrary, type ScrapFields } from "../browser/libraryStore";
import { checkedLabel, imageDataUrl } from "../media/imageActions";
import type { ViewerImage } from "../media/imageViewerState";
import { formatAnswerValue } from "./answerValueFormat";

/** The conversation whose message shows these blocks: its browser opens their links. */
export const AnswerSessionContext = createContext<string | undefined>(undefined);
export const useAnswerSession = () => useContext(AnswerSessionContext);

export function answerSource(item: { source?: string; checked?: string }, sessionId: string | undefined) {
  if (!item.source) return undefined;
  const copy = getAppCopy(getAppLocale()).conversation.answerBlocks;
  const url = item.source;
  const site = new URL(url).hostname.replace(/^www\./u, "");
  const checked = checkedLabel(item.checked);
  const today = item.checked ? new Date(item.checked).toLocaleDateString(getAppLocale()) === new Date().toLocaleDateString(getAppLocale()) : false;
  const label = checked ? today ? copy.source.checkedAt(checked, site) : copy.source.checkedOn(checked, site) : copy.source.open(site);
  return { site, checked, icon: faviconSrc(url), label, onOpen: () => runAnswerAction(() => openConversationLink(url, sessionId)) };
}

export function answerActionFailed(error: unknown) {
  notifyError(error, getAppCopy(getAppLocale()).conversation.answerBlocks.actionFailed);
}

export function runAnswerAction(action: () => Promise<unknown>) {
  void action().catch(answerActionFailed);
}

export function answerCardCopy(item: AnswerCardView): string {
  return [item.title, item.value ? formatAnswerValue(item.value, getAppLocale()) : undefined, item.source].filter(Boolean).join(" · ");
}

/** A block's pictures in item order, for the image viewer (items without a picture have no src). */
export function answerImages(items: readonly { image_url?: string; title?: string; caption?: string; source?: string; checked?: string }[],
  sessionId: string | undefined, fallbackAlt: string): ViewerImage[] {
  return items.map(item => ({ src: gatewayImageSource(item.image_url) ?? "", alt: item.title ?? item.caption ?? fallbackAlt,
    caption: item.title ?? item.caption, source: item.source, checked: item.checked, sessionId }));
}

/** The part of the answer a save button belongs to: its card or gallery item, copied as the scrap's HTML. */
export function answerPart(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest('[data-slot="item-card"], [data-answer-item]') : null;
}

/**
 * Saves an answer item as a 서랍 scrap: the part as it looked (its HTML copy through the page-scrap snapshot
 * pipeline), its picture as the scrap's own JPEG (or the part's screenshot without one), and its structured
 * fields. The scrap no longer depends on the conversation or its files.
 */
export async function saveAnswerItem(item: AnswerCardView, sessionId: string | undefined, part?: Element | null) {
  const copy = getAppCopy(getAppLocale()).conversation.answerBlocks;
  const source = answerSource(item, sessionId);
  const image = gatewayImageSource(item.image_url);
  const [snapshot, photo] = await Promise.all([snapshotAppPart(part), image ? imageDataUrl(image).catch(() => undefined) : undefined]);
  const fields: ScrapFields = { title: item.title, sub: item.sub, label: item.label, value: item.value, facts: item.facts,
    text: item.text, source: item.source, checked: item.checked };
  await saveLibrary({ id: crypto.randomUUID(), kind: "scrap", title: item.title,
    url: item.source ?? "", site: source?.site, crop: photo ?? snapshot?.crop,
    snapshot: snapshot ? { html: snapshot.html, width: snapshot.width, height: snapshot.height } : undefined,
    fields: Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    capturedAt: new Date().toISOString(), text: [item.value ? formatAnswerValue(item.value, getAppLocale()) : undefined,
      ...(item.facts ?? []), item.text, source?.checked].filter(Boolean).join(" · ") });
  notifyStatus(copy.savedToLibrary);
}
