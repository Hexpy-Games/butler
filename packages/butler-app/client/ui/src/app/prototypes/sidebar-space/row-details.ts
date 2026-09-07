const relative = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });
export function relativeActivity(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60000));
  if (!minutes) return "방금";
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? relative.format(-hours, "hour")
    : relative.format(-Math.floor(hours / 24), "day");
}
