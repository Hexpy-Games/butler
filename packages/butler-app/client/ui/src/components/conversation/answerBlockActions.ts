import type { AnswerCardView } from "../../../../shared/answer-blocks-view";
import { getAppCopy, getAppLocale } from "@/app/copy";
import { faviconSrc } from "@/app/favicons";
import { gatewayImageSource } from "@/app/messageFileUrls";
import { notifyError, notifyStatus } from "@/app/notifications";
import { openLink } from "../browser/browserBridge";
import { saveLibrary } from "../browser/libraryStore";
import { formatAnswerValue } from "./answerValueFormat";

export function answerSource(item: { source?: string; checked?: string }) {
  if (!item.source) return undefined;
  const locale = getAppLocale();
  const copy = getAppCopy(locale).conversation.answerBlocks;
  const url = item.source;
  const site = new URL(url).hostname.replace(/^www\./u, "");
  const date = item.checked ? new Date(item.checked) : undefined;
  const today = date?.toLocaleDateString(locale) === new Date().toLocaleDateString(locale);
  const checked = date ? today
    ? date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(locale, { dateStyle: "short" }) : undefined;
  const label = checked ? today ? copy.source.checkedAt(checked, site) : copy.source.checkedOn(checked, site) : copy.source.open(site);
  return { site, checked, icon: faviconSrc(url), label, onOpen: () => runAnswerAction(() => openLink(url)) };
}

export function runAnswerAction(action: () => Promise<unknown>) {
  void action().catch(error => notifyError(error, getAppCopy(getAppLocale()).conversation.answerBlocks.actionFailed));
}

export function answerCardCopy(item: AnswerCardView): string {
  return [item.title, item.value ? formatAnswerValue(item.value, getAppLocale()) : undefined, item.source].filter(Boolean).join(" · ");
}

async function assetCrop(imageUrl?: string): Promise<string | undefined> {
  const source = gatewayImageSource(imageUrl);
  if (!source) return undefined;
  const response = await fetch(source);
  if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) return undefined;
  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function saveAnswerItem(item: AnswerCardView) {
  const copy = getAppCopy(getAppLocale()).conversation.answerBlocks;
  const source = answerSource(item);
  await saveLibrary({ id: crypto.randomUUID(), kind: "scrap", title: item.title,
    url: item.source ?? "", site: source?.site, crop: await assetCrop(item.image_url),
    capturedAt: new Date().toISOString(), text: [item.value ? formatAnswerValue(item.value, getAppLocale()) : undefined,
      ...(item.facts ?? []), item.text, source?.checked].filter(Boolean).join(" · ") });
  notifyStatus(copy.savedToLibrary);
}
