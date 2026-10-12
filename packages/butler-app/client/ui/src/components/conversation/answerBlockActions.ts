import type { CardValue, CardItem } from "../../../../shared/app-contracts";
import { faviconSrc } from "@/app/favicons";
import { notifyError, notifyStatus } from "@/app/notifications";
import { openLink } from "../browser/browserBridge";
import { saveLibrary } from "../browser/libraryStore";

export function formatAnswerValue(value: CardValue, amount = value.amount): string {
  if (value.cur) {
    try { return new Intl.NumberFormat("ko-KR", { style: "currency", currency: value.cur }).format(amount); }
    catch { return `${amount} ${value.cur}`; }
  }
  return [new Intl.NumberFormat("ko-KR").format(amount), value.unit].filter(Boolean).join(" ");
}

export function answerSource(item: { source?: string; checked?: string }) {
  if (!item.source) return undefined;
  const url = item.source;
  const site = new URL(url).hostname;
  const date = item.checked ? new Date(item.checked) : undefined;
  const today = date?.toLocaleDateString("ko-KR") === new Date().toLocaleDateString("ko-KR");
  const checked = date ? `${today ? "" : `${date.toLocaleDateString("ko-KR")} `}${date.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" })} 확인` : undefined;
  return { site, checked, icon: faviconSrc(url), label: `${site}${checked ? `, ${checked}` : ""} 페이지 열기`, onOpen: () => runAnswerAction(() => openLink(url)) };
}

export function runAnswerAction(action: () => Promise<unknown>) {
  void action().catch(error => notifyError(error, "실행하지 못했어요"));
}

export function answerCardCopy(item: CardItem): string {
  return [item.title, item.value ? formatAnswerValue(item.value) : undefined, item.source].filter(Boolean).join(" · ");
}

async function assetCrop(img?: string): Promise<string | undefined> {
  if (!img) return undefined;
  const response = await fetch(`/assets/${encodeURIComponent(img)}`);
  if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) return undefined;
  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function saveAnswerItem(item: CardItem) {
  const source = answerSource(item);
  await saveLibrary({ id: crypto.randomUUID(), kind: "scrap", title: item.title,
    url: item.source ?? "", site: source?.site, crop: await assetCrop(item.img),
    capturedAt: new Date().toISOString(), text: [item.value ? formatAnswerValue(item.value) : undefined,
      ...(item.facts ?? []), item.text, source?.checked].filter(Boolean).join(" · ") });
  notifyStatus("서랍에 저장했어요");
}
