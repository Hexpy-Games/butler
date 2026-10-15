/** The fields of one wallpaper diagnostics event (`WallpaperDiagnosticEvent` of the DS Wallpaper block). */
export interface WallpaperStateFields {
  signal: string;
  value: string;
  mode: string;
  reason: string;
}

const STEP = /^[a-z-]{1,24}$/u;

/** `wallpaper_state visibility=hidden mode=idle reason=hidden step=import`: enum values only, never content. */
export function wallpaperStateLine(event: WallpaperStateFields, step: string | null | undefined): string {
  const signal = event.signal === "mode" ? "" : ` ${event.signal}=${event.value}`;
  const where = step && STEP.test(step) ? ` step=${step}` : "";
  return `wallpaper_state${signal} mode=${event.mode} reason=${event.reason}${where}`;
}
