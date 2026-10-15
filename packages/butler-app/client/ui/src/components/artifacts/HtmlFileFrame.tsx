import { useEffect, useState } from "react";
import { api, apiErrorCode } from "@/app/api.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { ArtifactPreviewFrame, Typo } from "@/butler-ds";

interface FileView { url: string; expires_at: number }
const REFRESH_MARGIN_MS = 60_000;

/** File identity owns the frame; list URL re-signing never navigates it. */
export function HtmlFileFrame({ path, title }: { path?: string; title: string }) {
  useAppLocale();
  const [view, setView] = useState<FileView>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      if (!path) return;
      try {
        const next = await api<FileView>(`${path}/view`);
        const url = new URL(next.url);
        if (!["http:", "https:"].includes(url.protocol) || url.origin === location.origin
          || !Number.isFinite(next.expires_at) || next.expires_at * 1000 <= Date.now()) {
          throw new Error("output_origin_refused");
        }
        if (disposed) return;
        setView(next);
        setFailure(undefined);
        timer = setTimeout(() => void load(), Math.max(1000, next.expires_at * 1000 - Date.now() - REFRESH_MARGIN_MS));
      } catch (error) {
        if (disposed) return;
        setFailure(apiErrorCode(error) === "content_host_required" ? appCopy.artifacts.contentHostRequired : appCopy.artifacts.loadFailed);
      }
    }
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [path]);
  return view ? <ArtifactPreviewFrame src={view.url} title={title} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />
    : <Typo.Caption>{failure ?? appCopy.artifacts.loading}</Typo.Caption>;
}
