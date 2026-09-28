import { useEffect, useState } from "react";
import { settleMessageFileLoad } from "@/app/messageFileUrls.ts";
import {
  retryMessageFileOnce,
  type RefreshFileUrls,
} from "@/hooks/useMessageFileSource.ts";

export type ArtifactTextState = "idle" | "loading" | "failed";

interface TextResult {
  url: string;
  status: "ok" | "retrying" | "failed";
  text: string;
}

/**
 * Fetches a text artifact. A refused load (expired or revoked signed URL)
 * refreshes the owning list once; a new URL refetches, the same URL fails.
 */
export function useArtifactText(input: {
  url?: string;
  enabled: boolean;
  path?: string;
  refreshFileUrls?: RefreshFileUrls;
}): { state: ArtifactTextState; text: string } {
  const { url, enabled, path, refreshFileUrls } = input;
  const [result, setResult] = useState<TextResult | null>(null);

  useEffect(() => {
    if (!url || !enabled) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Artifact fetch failed.");
        return response.text();
      })
      .then((text) => {
        if (path) settleMessageFileLoad(path);
        setResult({ url, status: "ok", text });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setResult({ url, status: "retrying", text: "" });
        void retryMessageFileOnce(path, refreshFileUrls).then(() => {
          setResult((current) =>
            current?.url === url && current.status === "retrying"
              ? { url, status: "failed", text: "" }
              : current,
          );
        });
      });
    return () => controller.abort();
  }, [enabled, path, refreshFileUrls, url]);

  if (!url || !enabled) return { state: "idle", text: "" };
  if (!result || result.url !== url || result.status === "retrying") {
    return { state: "loading", text: "" };
  }
  return result.status === "failed"
    ? { state: "failed", text: "" }
    : { state: "idle", text: result.text };
}
