import type { ReactNode } from "react";
import type { WallpaperSource } from "../../blocks/Wallpaper";
import { Wallpaper } from "../../blocks/Wallpaper";
import { TintedGlass } from "../TintedGlass";
import type { TagLabelTone } from "./tagTones";
import styles from "./Tag.showcase.module.css";

/** Showcase copy: each label tone's name (product passes its own). */
export const tagLabelToneNames: Record<"en-US" | "ko-KR", Record<TagLabelTone, string>> = {
  "en-US": { gray: "Gray", red: "Red", orange: "Orange", yellow: "Yellow", green: "Green", teal: "Teal", blue: "Blue", purple: "Purple" },
  "ko-KR": { gray: "회색", red: "빨강", orange: "주황", yellow: "노랑", green: "초록", teal: "청록", blue: "파랑", purple: "보라" },
};

/** The default riso print and a living photo: the two wallpaper families Tags sit on. */
const WALLPAPERS: Array<{ key: string; source: WallpaperSource }> = [
  { key: "riso", source: { kind: "live", module: "butler.riso-print" } },
  { key: "photo", source: { kind: "live", module: "butler.photo-daisies" } },
];

/** `children` flat on each wallpaper, then again on TintedGlass over it. */
export function OnWallpapers({ children }: { children: ReactNode }) {
  return (
    <div className={styles.stages}>
      {WALLPAPERS.map(({ key, source }) => (
        <div className={styles.stage} data-wallpaper={key} key={key}>
          <Wallpaper motion="paused" scope="container" source={source} />
          <div className={styles.layer}>
            {children}
            <TintedGlass padding="sm" radius="control">{children}</TintedGlass>
          </div>
        </div>
      ))}
    </div>
  );
}
