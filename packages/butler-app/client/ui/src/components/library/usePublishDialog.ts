import { useEffect, useState } from "react";
import { apiErrorCode } from "@/app/api";
import { appCopy } from "@/app/copy";
import { libraryChanged } from "@/app/libraryEvents";
import { notifyStatus } from "@/app/notifications";
import { listPublishedPages, previewPublish, publishItem, unpublishItem, unpublishPage, type PublishedPage, type PublishedPages } from "@/app/publishing";
import type { LibraryItem } from "../browser/libraryStore";
import { closeLibraryDialogs } from "./libraryDialogs";
import { notifyPublishingError } from "./publishing";

type Stage = "loading" | "signedOut" | "choose" | "uploading" | "published" | "updating" | "stop" | "limit";

export function usePublishDialog(item: LibraryItem) {
  const [stage, setStage] = useState<Stage>("loading");
  const [pages, setPages] = useState<PublishedPages>();
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewPublish>>>();
  const [url, setUrl] = useState(item.published?.url ?? "");
  const [busy, setBusy] = useState(false);
  const [load, setLoad] = useState(0);
  const copy = appCopy.publishing;

  useEffect(() => {
    let active = true;
    async function open() {
      try {
        const local = await previewPublish(item.id);
        if (!active) return;
        const listed = await listPublishedPages();
        if (!active) return;
        setPreview(local);
        setPages(listed);
        setStage(item.published ? "published" : listed.used >= listed.limit ? "limit" : "choose");
      } catch (error) {
        if (!active) return;
        if (apiErrorCode(error) === "butler_account_signed_out") setStage("signedOut");
        else { notifyPublishingError(error); closeLibraryDialogs(); }
      }
    }
    void open();
    return () => { active = false; };
  }, [item.id, item.published, load]);

  async function run(operation: () => Promise<void>, previous = stage) {
    setBusy(true);
    try { await operation(); }
    catch (error) {
      const code = apiErrorCode(error);
      if (code === "butler_account_signed_out") setStage("signedOut");
      else if (code === "page_limit") {
        setStage("limit");
        try { setPages(await listPublishedPages()); }
        catch (refreshError) {
          if (apiErrorCode(refreshError) === "butler_account_signed_out") setStage("signedOut");
          else notifyPublishingError(refreshError, pages);
        }
      } else {
        setStage(previous);
        notifyPublishingError(error, pages);
      }
    } finally { setBusy(false); }
  }

  const publish = () => {
    const updating = stage === "published";
    setStage(updating ? "updating" : "uploading");
    void run(async () => {
      const result = await publishItem(item.id);
      setUrl(result.url);
      setPreview({ signed_in: true, file_count: result.file_count, size_bytes: result.size_bytes });
      setStage("published");
      notifyStatus(updating ? copy.updated : copy.published, { tone: "ok", id: "publishing" });
      libraryChanged();
      try { setPages(await listPublishedPages()); }
      catch (error) { notifyPublishingError(error, pages); }
    });
  };

  const stop = () => void run(async () => {
    await unpublishItem(item.id);
    notifyStatus(copy.stopped, { tone: "ok", id: "publishing" });
    libraryChanged();
    closeLibraryDialogs();
  });

  const remove = (page: PublishedPage) => void run(async () => {
    await unpublishPage(page);
    if (page.item_id) libraryChanged();
    setPages(await listPublishedPages());
  });

  const reload = () => { setStage("loading"); setLoad((value) => value + 1); };
  return { stage, setStage, pages, preview, url, busy, publish, stop, remove, reload };
}
