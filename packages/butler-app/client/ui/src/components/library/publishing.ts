import { useEffect, useState } from "react";
import { apiErrorCode } from "@/app/api";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { getPublishing, type PublishedPages } from "@/app/publishing";
import type { LibraryItem } from "../browser/libraryStore";

export const publishable = (item: LibraryItem) =>
  Boolean(item.output) || /^(text\/html|image\/|application\/pdf$)/.test(item.file?.mime_type ?? "");

let availability: Promise<boolean> | undefined;

export function usePublishingAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    availability ??= getPublishing().then(() => true, () => false);
    void availability.then(setAvailable);
  }, []);
  return available;
}

export const pageHost = (url: string) => url.replace(/^https?:\/\//iu, "").replace(/\/$/u, "");

export function notifyPublishingError(error: unknown, pages?: PublishedPages) {
  const copy = appCopy.publishing;
  let text = appCopy.butlerAccount.failed;
  switch (apiErrorCode(error)) {
    case "page_too_large": if (pages) text = copy.tooLarge(pages.page_bytes / 1e6, pages.page_files); break;
    case "page_refused": text = copy.refused; break;
    case "publish_daily_limit": text = copy.dailyLimit; break;
    case "paused": case "publish_capacity": text = copy.paused; break;
    case "cloud_unavailable": text = copy.offline; break;
    case "storage_full": text = copy.storageFull; break;
    case "page_taken_down": text = copy.pageTakenDown; break;
    case "publish_blocked": text = copy.publishBlocked; break;
  }
  notifyStatus(text, { tone: "error", id: "publishing" });
}
