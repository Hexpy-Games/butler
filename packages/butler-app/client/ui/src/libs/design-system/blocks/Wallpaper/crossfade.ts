import { animateMotion, prefersReducedMotion } from "../../lib/motion";

export interface WallpaperCrossfade {
  /** Freezes the canvas's current frame on the overlay and fades it out over what comes next. */
  start(): void;
  /** Nothing to show (`none`): hides the canvas and releases its drawing buffer. */
  clear(): void;
  /** A scene is presented: the canvas shows now, or (`fadeIn`, after `none`) fades in once `drawn()`. */
  show(fadeIn: boolean): void;
  /** A frame is on the canvas. */
  drawn(): void;
  dispose(): void;
}

/**
 * Transitions between wallpapers (DS motion: opacity only, `--motion-slow`).
 * A crossfade copies the previous frame onto a sibling overlay canvas that
 * fades out, so the WebGL canvas can draw the next scene at once. After
 * `none` the canvas is hidden (an empty opaque WebGL layer would paint black)
 * and the next scene's first frame fades it in. Reduced motion switches
 * instantly. The WebGL canvas does not preserve its drawing buffer, so
 * `repaint` draws the current frame again right before the snapshot.
 */
export function createWallpaperCrossfade(
  canvas: HTMLCanvasElement,
  overlay: HTMLCanvasElement | null,
  repaint: () => void = () => undefined,
): WallpaperCrossfade {
  let animation: Animation | null = null;
  let fade: Animation | null = null;
  let revealOnDraw = false;

  const hide = () => {
    animation?.cancel();
    animation = null;
    if (!overlay) return;
    overlay.hidden = true;
    // Frees the snapshot's pixels.
    overlay.width = 0;
    overlay.height = 0;
  };

  const stopFade = () => {
    fade?.cancel();
    fade = null;
  };

  return {
    start() {
      hide();
      if (!overlay || canvas.width === 0 || canvas.height === 0 || prefersReducedMotion()) return;
      overlay.width = canvas.width;
      overlay.height = canvas.height;
      const context = overlay.getContext("2d");
      if (!context) return;
      repaint();
      context.drawImage(canvas, 0, 0);
      overlay.hidden = false;
      // From the overlay's own opacity, so a dimmed wallpaper layer never flashes.
      animation = animateMotion(overlay, [{ opacity: 0 }], { duration: "slow", easing: "standard", fill: "forwards" });
      if (animation) animation.onfinish = hide;
      else hide();
    },
    clear() {
      revealOnDraw = false;
      canvas.style.visibility = "hidden";
      canvas.width = 0;
      canvas.height = 0;
    },
    show(fadeIn) {
      revealOnDraw = fadeIn;
      if (!fadeIn) canvas.style.visibility = "";
    },
    drawn() {
      if (!revealOnDraw) return;
      revealOnDraw = false;
      canvas.style.visibility = "";
      stopFade();
      // An implicit end keyframe: up to the canvas's own opacity.
      if (!prefersReducedMotion()) fade = animateMotion(canvas, [{ opacity: 0, offset: 0 }], { duration: "slow", easing: "standard" });
    },
    dispose() {
      hide();
      stopFade();
    },
  };
}
