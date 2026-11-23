import { useEffect, useState } from "react";
import { apiErrorCode } from "@/app/api";
import { confirmAction } from "@/app/confirmation";
import { appCopy, useAppLocale } from "@/app/copy";
import { libraryChanged } from "@/app/libraryEvents";
import { notifyStatus } from "@/app/notifications";
import { listPublishedPages, unpublishPage, type PublishedPage, type PublishedPages } from "@/app/publishing";
import { isMissingRoute } from "@/app/setupConnection";
import { Globe2, Link, ListRow, OverflowActionMenu, Popup, SettingsSection, Stack, Tag, Unlink } from "@/butler-ds";
import { openLink } from "../browser/browserBridge";
import { notifyPublishingError, pageHost } from "../library/publishing";

export function PublishedPagesSection() {
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

  if (state === "hidden") return null;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  return (
    <SettingsSection id="butler-pages" kind="list" title={copy.listTitle}
      description={pages ? copy.usage(pages.used, pages.limit) : undefined} emptyMessage={copy.listEmpty}
      state={state === "ready" && !pages?.pages.length ? "empty" : state} errorMessage={appCopy.butlerAccount.loadFailed} onRetry={reload}>
      {pages?.pages.map((page) => (
        <Stack key={page.id} align="row" cross="center" gap="sm">
          <Stack grow minWidth="0">
            <ListRow icon={<Globe2 size="md" />} title={page.title} description={pageHost(page.url)} meta={date.format(new Date(page.updated_at))}
              tag={page.status === "taken_down" ? <Tag size="sm" tone="warning">{copy.takenDown}</Tag> : undefined} />
          </Stack>
          <OverflowActionMenu label={copy.more} items={[
            { icon: <Link size="sm" />, label: copy.copyLink, onSelect: () => void copyLink(page.url) },
            { icon: <Popup size="sm" />, label: copy.open, onSelect: () => void openLink(page.url) },
            { icon: <Unlink size="sm" />, label: copy.stop, variant: "destructive", onSelect: () => void stop(page) },
          ]} />
        </Stack>
      ))}
    </SettingsSection>
  );
}
