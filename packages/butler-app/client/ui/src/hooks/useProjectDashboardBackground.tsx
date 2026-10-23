import { useState, type ReactNode } from "react";
import { resolveWallpaper } from "@/app/projectWallpaper.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ProjectSummary } from "@/app/types.ts";
import type { WallpaperContentRect } from "@/butler-ds";
import { mainScreenWallpaper } from "@/components/conversation/mainScreenTheme.ts";
import { ProjectDashboardWallpaper } from "@/components/management/ProjectDashboardWallpaper.tsx";

/** Flat project pages use the conversation's text-over-wallpaper treatment. */
export function useProjectDashboardBackground(project?: ProjectSummary): {
  background: ReactNode | undefined;
  columnRef: (element: HTMLElement | null) => void;
  onComposerRect: (rect: WallpaperContentRect) => void;
} {
  const settings = useButlerStore((state) => state.settings);
  const [column, setColumn] = useState<HTMLElement | null>(null);
  const [composer, setComposer] = useState<WallpaperContentRect>();
  const wallpaper = resolveWallpaper(mainScreenWallpaper(settings), project);
  const source = wallpaper.source;
  const paperOverlay = source.kind === "image" || (source.kind === "live" && source.module !== "butler.riso-print")
    ? settings.conversation_background.overlay / 100 : 0;
  const background = source.kind === "none" ? undefined
    : <ProjectDashboardWallpaper wallpaper={wallpaper} column={column} composer={composer} paperOverlay={paperOverlay} />;
  return { background, columnRef: setColumn, onComposerRect: setComposer };
}
