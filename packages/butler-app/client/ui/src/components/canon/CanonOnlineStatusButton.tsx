import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { CanonOnlineLink } from "@/app/canonApi.ts";
import { canonOnlineState } from "@/app/canonOnline.ts";
import { CircleAlert, Globe2, IconButton, IconSlot, RollingSwap, Unlink } from "@/butler-ds";

export function CanonOnlineStatusButton({ link, onOpen }: { link: CanonOnlineLink; onOpen: () => void }) {
  useAppLocale();
  const copy = appCopy.canon.online;
  const state = canonOnlineState(link);
  const status = copy.status[state];
  const icons = {
    connected: <Globe2 size="sm" />,
    offline: <IconSlot size="sm" tone="tertiary"><Globe2 size="sm" /></IconSlot>,
    error: <CircleAlert size="sm" />,
    detached: <Unlink size="sm" />,
  };
  return <IconButton label={link.pending > 0 ? copy.pending(status, link.pending) : status} badge={link.pending} onClick={onOpen}>
    <RollingSwap itemKey={state}>{icons[state]}</RollingSwap>
  </IconButton>;
}
