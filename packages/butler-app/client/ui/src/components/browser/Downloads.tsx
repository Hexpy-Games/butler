import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy";
import {
  Clickable, Download, EmptyLine, FileText, Folder, IconButton, ListRow, Popover, PopoverContent,
  PopoverTrigger, ProgressMeter, ProgressRing, ScrollArea, Stack, X,
} from "@/butler-ds";
import { formatFileSize } from "../conversation/conversationUtils";
import { browserCall, type BrowserDownloadEntry } from "./browserBridge";

export function DownloadsMenu() {
  const copy = appCopy.browser;
  const [items, setItems] = useState<BrowserDownloadEntry[]>([]);
  useEffect(() => {
    void browserCall("downloads").then(result => {
      if (Array.isArray(result)) setItems(result);
    });
    return window.butlerBrowser?.onDownloads?.(setItems);
  }, []);
  const active = items.filter(item => item.state === "progress");
  const bytes = active.reduce((sum, item) => sum + item.bytes, 0);
  const total = active.reduce((sum, item) => sum + item.total, 0);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton label={copy.downloads}>
          {active.length > 0
            ? <ProgressRing size="md" value={total ? bytes / total : 0} indeterminate={active.some(item => item.total === 0)} aria-hidden />
            : <Download size="md" />}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" density="list" width="narrow">
        <ScrollArea maxHeight="sm">
          <Stack gap="none">
            {items.length ? items.map(item => <DownloadRow key={item.id} item={item} />) : <EmptyLine message={copy.noDownloads} />}
          </Stack>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

function DownloadRow({ item }: { item: BrowserDownloadEntry }) {
  const copy = appCopy.browser;
  const { id, name, state, bytes, total } = item;
  const progress = state === "progress";
  const done = state === "done";
  const size = formatFileSize(bytes);
  const meta = state === "failed" ? copy.downloadFailed : state === "cancelled" ? copy.downloadCancelled
    : progress && total ? `${size} / ${formatFileSize(total)}` : size;
  const open = () => void browserCall("download.open", { id });
  return (
    <Stack gap="none">
      <Stack align="row" cross="center">
        <Clickable stretch disabled={!done} onClick={open}>
          <ListRow icon={<FileText size="md" />} title={name} meta={meta} />
        </Clickable>
        {progress && <IconButton label={copy.cancel} onClick={() => void browserCall("download.cancel", { id })}><X size="sm" /></IconButton>}
        {done && <IconButton label={copy.showInFolder} onClick={() => void browserCall("download.show", { id })}><Folder size="sm" /></IconButton>}
      </Stack>
      {progress && <ProgressMeter bare value={total ? bytes / total * 100 : 0} indeterminate={total === 0} ariaLabel={name} />}
    </Stack>
  );
}
