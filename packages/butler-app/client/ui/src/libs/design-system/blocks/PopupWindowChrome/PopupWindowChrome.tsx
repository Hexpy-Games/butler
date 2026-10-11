import type { ReactNode } from "react";
import { Lock, Warning } from "../../components/Icons";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import styles from "./PopupWindowChrome.module.css";

export interface PopupWindowChromeProps extends DsPrivateStyleProps {
  /** The pop-up's origin; it titles the window. */
  host: string;
  secure?: boolean;
  /** "Secure connection" / "Not secure", for the lock glyph. */
  securityLabel: string;
  /** `darwin` reserves the native traffic lights at the start; other platforms put `windowControls` at the end. */
  platform?: "darwin" | "win32" | "linux" | "browser";
  windowControls?: ReactNode;
  /** The page area (a NativeViewSlot); it fills the window under the bar. */
  children?: ReactNode;
}

/**
 * A Butler-owned pop-up window (sign-in, payment): a compact 40px title bar with the native window
 * controls, the lock and the host, over the page. Rendered as the whole document of that separate
 * native window, so it fills it. Solid, like Butler's other windows.
 */
export function PopupWindowChrome({ host, secure = true, securityLabel, platform = "darwin", windowControls, children, className }: PopupWindowChromeProps) {
  return (
    <div className={cn(styles.window, className)} data-slot="popup-window-chrome" data-platform={platform}>
      <header className={cn(styles.bar, "drag-region")}>
        <span className={styles.lock} data-secure={secure || undefined} role="img" aria-label={securityLabel}>
          {secure ? <Lock size="sm" /> : <Warning size="sm" />}
        </span>
        <span className={styles.host}>{host}</span>
        {windowControls && platform !== "darwin" ? <span className={cn(styles.controls, "no-drag")}>{windowControls}</span> : null}
      </header>
      <div className={styles.page} data-slot="popup-window-page">{children}</div>
    </div>
  );
}
