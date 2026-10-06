import { useRef } from "react";
import type { WallpaperMotion, WallpaperSource, WallpaperTone } from "../Wallpaper/types";
import { Wallpaper } from "../Wallpaper/Wallpaper";
import { useWallpaperTone } from "../Wallpaper/wallpaperTone";
import type { ComposerCardEdge } from "./ComposerCard";
import { COMPOSER_EDGE_CHARACTER_RISE, ComposerEdgeCharacter, type ComposerEdgeCharacterKind } from "./ComposerEdgeCharacter";
import styles from "./ComposerDecoration.module.css";

/** Composer card scenes; product code picks one by name and passes no tuning. */
export const COMPOSER_DECORATION_SCENES = ["shoreline", "cherry"] as const;
export type ComposerDecorationScene = (typeof COMPOSER_DECORATION_SCENES)[number];

/**
 * Shoreline: tropical water, 0.75 foam, no cloud shadows by day.
 * shorePosition 0.5556 puts the mean waterline at the canvas middle, which the
 * CSS places 19px above the card's bottom edge. Cherry: the transparent canopy
 * module, no params (its size and layout are fixed in the shader).
 */
const SOURCES: Record<ComposerDecorationScene, WallpaperSource> = {
  shoreline: { kind: "live", module: "butler.shoreline", params: { shorePosition: 0.5556, foamAmount: 0.75, water: "tropical", dayClouds: 0 } },
  cherry: { kind: "live", module: "butler.cherry-blossom" },
};

const EDGE_CHARACTERS: Record<ComposerDecorationScene, ComposerEdgeCharacterKind> = { shoreline: "crab", cherry: "cat" };

export interface ComposerDecorationProps {
  scene: ComposerDecorationScene;
  /** `paused` holds a still frame (pass the user's wallpaper motion setting). */
  motion?: WallpaperMotion;
  /** Hold a still frame on battery; on by default for card art. */
  pauseOnBattery?: boolean;
  /** Omit to follow the nearest theme scope. */
  tone?: WallpaperTone;
}

/**
 * A composer card scene for `ComposerCard decoration`, with the owner-approved
 * tuning baked in. Shoreline: the waterline 19px above the bottom edge at a
 * fixed scale (the canvas is at least 360px tall, so the scene never stretches
 * as the card grows); in light mode exposure 1.22 and the sand above the
 * waterline toned down by 0.06; in both modes a soft gradient toward the glass
 * tint, 0.3 strong, over the bottom quarter. Cherry: the canopy fills the card
 * on a transparent canvas, so the glass shows everywhere else. No scene adds a
 * layer behind the text.
 */
export function ComposerDecoration({ scene, motion = "auto", pauseOnBattery = true, tone: explicitTone }: ComposerDecorationProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const tone = useWallpaperTone(ref, explicitTone);
  const shoreline = scene === "shoreline";
  return (
    <div className={styles.root} data-scene={scene} data-tone={tone} ref={ref}>
      <div className={shoreline ? styles.shoreArt : styles.art}>
        <Wallpaper dataTestClass="composer-decoration-scene" motion={motion} pauseOnBattery={pauseOnBattery} scope="container"
          source={SOURCES[scene]} tone={tone} />
      </div>
      {shoreline ? <div className={styles.highlight} /> : null}
      {shoreline ? <div className={styles.gradient} /> : null}
    </div>
  );
}

/**
 * The scene's edge character for `ComposerCard edge` (shoreline: a crab,
 * cherry: a cat, peeking over the top edge), with `reserveTop`: the px it rises
 * above the card, which the card reserves on its wrap.
 */
export function composerDecorationEdge(scene: ComposerDecorationScene): ComposerCardEdge {
  const kind = EDGE_CHARACTERS[scene];
  return {
    behind: <ComposerEdgeCharacter kind={kind} part="behind" />,
    front: <ComposerEdgeCharacter kind={kind} part="front" />,
    reserveTop: COMPOSER_EDGE_CHARACTER_RISE,
  };
}
