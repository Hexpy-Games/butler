import { useEffect, useState } from "react";
import { apiErrorCode } from "@/app/api";
import { confirmAction } from "@/app/confirmation";
import { appCopy, useAppLocale } from "@/app/copy";
import { libraryChanged } from "@/app/libraryEvents";
import { notifyStatus } from "@/app/notifications";
import { listPublishedPages, unpublishPage, type PublishedPage, type PublishedPages } from "@/app/publishing";
import { isMissingRoute } from "@/app/setupConnection";
import { notifyPublishingError } from "../../library/publishing";

export function usePublishedPages() {
  const locale = useAppLocale();
  const copy = appCopy.publishing;
  const [pages, setPages] = useState<PublishedPages>();
  const [state, setState] = useState<"loading" | "ready" | "error" | "hidden">("loading");
  const [load, setLoad] = useState(0);
  const reload = () => { setState("loading"); setLoad((value) => value + 1); };

  useEffect(() => {
    let active = true;
    void listPublishedPages().then((data) => {
      if (active) { setPages(data); setState("ready"); }
    }, (error: unknown) => {
      if (!active) return;
      const code = apiErrorCode(error);
      setState(isMissingRoute(error) || code === "butler_account_disabled" || code === "butler_account_signed_out" ? "hidden" : "error");
    });
    return () => { active = false; };
  }, [load]);

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      notifyStatus(copy.linkCopied, { tone: "ok", id: "publishing" });
    } catch (error) { notifyPublishingError(error, pages); }
  }

  async function stop(page: PublishedPage) {
    if (!await confirmAction(copy.stopBody, { title: copy.stopConfirm, confirmLabel: copy.stop, destructive: true })) return;
    try {
      await unpublishPage(page);
      if (page.item_id) libraryChanged();
      notifyStatus(copy.stopped, { tone: "ok", id: "publishing" });
      reload();
    } catch (error) { notifyPublishingError(error, pages); }
  }

  return { locale, pages, state, reload, copyLink, stop };
}
