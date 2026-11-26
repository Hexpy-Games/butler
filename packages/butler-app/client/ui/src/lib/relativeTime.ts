import { appCopy, getAppLocale } from "@/app/copy.ts";

export function relativeTimeSince(elapsedSeconds: number): string {
  if (elapsedSeconds < 60) return appCopy.butlerAccount.justNow;
  const format = new Intl.RelativeTimeFormat(getAppLocale(), { numeric: "auto" });
  if (elapsedSeconds < 3600) return format.format(-Math.floor(elapsedSeconds / 60), "minute");
  if (elapsedSeconds < 86400) return format.format(-Math.floor(elapsedSeconds / 3600), "hour");
  return format.format(-Math.floor(elapsedSeconds / 86400), "day");
}
