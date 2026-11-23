import { appCopy } from "@/app/copy";
import { Globe2, Link, ListRow, OverflowActionMenu, Popup, SettingsSection, Stack, Tag, Unlink } from "@/butler-ds";
import { openLink } from "../browser/browserBridge";
import { pageHost } from "../library/publishing";
import type { usePublishedPages } from "./hooks/usePublishedPages";

export function publishedPagesSection({ locale, pages, state, reload, copyLink, stop }: ReturnType<typeof usePublishedPages>) {
  const copy = appCopy.publishing;
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
