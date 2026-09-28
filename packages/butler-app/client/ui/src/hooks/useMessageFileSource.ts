import { useEffect, useSyncExternalStore } from "react";
import {
  absoluteGatewayUrl,
  claimMessageFileRetry,
  messageFilePath,
  messageFileSource,
  settleMessageFileLoad,
  signedFileUrlsVersion,
  signedUrlExpiry,
  subscribeSignedFileUrls,
  type MessageFileLink,
} from "@/app/messageFileUrls.ts";

export type RefreshFileUrls = () => Promise<unknown>;

export interface MessageFileSourceState {
  /** Absolute URL to load, undefined when the link names no message file. */
  src?: string;
  /** The validated file path (retry key). */
  path?: string;
  /** Unix seconds the chosen signed URL expires; undefined when unsigned. */
  expiresAt?: number;
  /** Call after a successful load. */
  onLoad: () => void;
  /**
   * Call after a failed load (expired or revoked signature). The first
   * failure per file refreshes the owning list; later ones do nothing.
   */
  onError: () => void;
}

/** Tracks the freshest signed URL for a message file and its one retry. */
export function useMessageFileSource(
  link: MessageFileLink | undefined,
  refreshFileUrls?: RefreshFileUrls,
): MessageFileSourceState {
  useSyncExternalStore(
    subscribeSignedFileUrls,
    signedFileUrlsVersion,
    signedFileUrlsVersion,
  );
  const path = messageFilePath(link?.url);
  const source = link ? messageFileSource(link) : undefined;
  return {
    src: source ? absoluteGatewayUrl(source) : undefined,
    path,
    expiresAt: source ? signedUrlExpiry(source) : undefined,
    onLoad: () => {
      if (path) settleMessageFileLoad(path);
    },
    onError: () => {
      retryMessageFileOnce(path, refreshFileUrls);
    },
  };
}

/** Starts the file's single refresh; resolves false when none is allowed. */
export function retryMessageFileOnce(
  path: string | undefined,
  refreshFileUrls: RefreshFileUrls | undefined,
): Promise<boolean> {
  if (!path || !refreshFileUrls || !claimMessageFileRetry(path)) {
    return Promise.resolve(false);
  }
  return refreshFileUrls().then(
    () => true,
    () => true,
  );
}

/**
 * A frame cannot report a refused load, so an expired (or unsigned) URL is
 * refreshed once before use; a fresh one re-arms the retry for later.
 */
export function useFreshFrameSource(
  file: MessageFileSourceState,
  enabled: boolean,
  refreshFileUrls?: RefreshFileUrls,
): void {
  const { expiresAt, path } = file;
  useEffect(() => {
    if (!enabled || !path) return;
    if (expiresAt !== undefined && expiresAt * 1000 > Date.now()) {
      settleMessageFileLoad(path);
    } else {
      void retryMessageFileOnce(path, refreshFileUrls);
    }
  }, [enabled, expiresAt, path, refreshFileUrls]);
}
