import { useEffect, useRef, useState, type ReactNode } from "react";
import { TintedGlass } from "../../components/TintedGlass";
import { Typo } from "../../components/Typo";
import { dsClass } from "../../lib/internal";
import type { ShowcaseRenderContext } from "../../showcase";
import { SILK_WALLPAPER } from "./modules";
import { renderWallpaperStill } from "./still";
import type { WallpaperSource, WallpaperTone } from "./types";
import { Wallpaper } from "./Wallpaper";
import { useWallpaperTone } from "./wallpaperTone";
import styles from "./Wallpaper.showcase.module.css";

const copy = {
  "en-US": {
    placeholder: "Ask Butler anything",
    transparent: "Transparent: butler.cherry-blossom draws only the branch; the glass shows",
    opaque: "Opaque: butler.silk covers the glass",
  },
  "ko-KR": {
    placeholder: "버틀러에게 무엇이든 물어보세요",
    transparent: "투명: butler.cherry-blossom은 가지만 그리고 유리는 그대로 보입니다",
    opaque: "불투명: butler.silk가 유리를 덮습니다",
  },
} as const;

const CHERRY: WallpaperSource = { kind: "live", module: "butler.cherry-blossom" };

function Card({ layer, label, placeholder }: { layer: ReactNode; label: string; placeholder: string }) {
  return (
    <TintedGlass className={dsClass(styles.card)} padding="lg" radius="composer">
      {layer}
      <div className={styles.cardText}>
        <Typo.Body tone="secondary">{placeholder}</Typo.Body>
        <Typo.Caption tone="secondary">{label}</Typo.Caption>
      </div>
    </TintedGlass>
  );
}

/** The opaque comparison as a still (shared still context): browsers cap live WebGL contexts per page. */
function OpaqueStill({ tone }: { tone: WallpaperTone }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    renderWallpaperStill(SILK_WALLPAPER, { width: 640, height: 240 }, tone).then((blob) => {
      if (!live) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    }).catch(() => undefined);
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [tone]);
  return url ? <img alt="" className={styles.cardStill} src={url} /> : null;
}

/**
 * Transparent mode beside opaque, in the viewer's theme (side by side shows
 * light and dark): the cherry branch draws only itself, so the card's glass
 * and the marks behind it show through; an opaque module hides them.
 */
export function TransparentDecorationDemo({ locale }: ShowcaseRenderContext) {
  const text = copy[locale];
  const stageRef = useRef<HTMLDivElement | null>(null);
  const tone = useWallpaperTone(stageRef);
  return (
    <div className={styles.decorationStage} ref={stageRef}>
      <span aria-hidden="true" className={styles.markOne} />
      <span aria-hidden="true" className={styles.markTwo} />
      <Card label={text.transparent} layer={<Wallpaper scope="container" source={CHERRY} />} placeholder={text.placeholder} />
      <Card label={text.opaque} layer={<OpaqueStill tone={tone} />} placeholder={text.placeholder} />
    </div>
  );
}
