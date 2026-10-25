import { useCallback, useState, type ReactNode } from "react";
import { resolveWallpaper } from "@/app/projectWallpaper.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ProjectSummary } from "@/app/types.ts";
import type { ManagementPageColumnRect, WallpaperContentRect } from "@/butler-ds";
import { mainScreenWallpaper } from "@/components/conversation/mainScreenTheme.ts";
import { ProjectDashboardWallpaper, createComposerRectChannel } from "@/components/management/ProjectDashboardWallpaper.tsx";

/** Flat project pages use the conversation's text-over-wallpaper treatment. */
export function useProjectDashboardBackground(project?: ProjectSummary): {
  background: ReactNode | undefined;
  onColumnRect: (rect: ManagementPageColumnRect) => void;
  onComposerRect: (rect: WallpaperContentRect) => void;
} {
  const settings = useButlerStore((state) => state.settings);
  const [column] = useState(createComposerRectChannel);
  const onColumnRect = useCallback((rect: ManagementPageColumnRect) => {
    column.set({ x: rect.left, y: rect.top, width: rect.right - rect.left, height: 0 });
  }, [column]);
  // The composer moves whenever the workspace width changes (inspector, sidebar, window); only
  // the wallpaper reads its rect, so the page above it must not re-render for it.
  const [composer] = useState(createComposerRectChannel);
  const wallpaper = resolveWallpaper(mainScreenWallpaper(settings), project);
  const source = wallpaper.source;
  const paperOverlay = source.kind === "image" || (source.kind === "live" && source.module !== "butler.riso-print")
    ? settings.conversation_background.overlay / 100 : 0;
  const background = source.kind === "none" ? undefined
    : <ProjectDashboardWallpaper wallpaper={wallpaper} column={column} composer={composer} paperOverlay={paperOverlay} />;
  return { background, onColumnRect, onComposerRect: composer.set };
}
