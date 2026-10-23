import { useState, type ReactNode } from "react";
import { resolveWallpaper } from "@/app/projectWallpaper.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ProjectSummary } from "@/app/types.ts";
import type { WallpaperContentRect } from "@/butler-ds";
import { canonSurface } from "@/app/canonDetailLayout.ts";
import { mainScreenWallpaper } from "@/components/conversation/mainScreenTheme.ts";
import { ProjectDashboardWallpaper } from "@/components/management/ProjectDashboardWallpaper.tsx";

/**
 * The project dashboard's ManagementPage background: the project's
 * wallpaper, or the global one when it inherits (`resolveWallpaper`).
 * A `none` source gives no background, so the page stays plain.
 * `headerRef` goes on the header panel the wallpaper keeps clear.
 * SCRATCH PROTOTYPE `flat` surface: `columnRef` (the content column) and
 * `onComposerRect` feed the chat view's treatment instead.
 */
export function useProjectDashboardBackground(project?: ProjectSummary): {
  background: ReactNode | undefined;
  headerRef: (element: HTMLDivElement | null) => void;
  columnRef: (element: HTMLElement | null) => void;
  onComposerRect: (rect: WallpaperContentRect) => void;
  flat: boolean;
} {
  const settings = useButlerStore((state) => state.settings);
  const [header, setHeader] = useState<HTMLDivElement | null>(null);
  const [column, setColumn] = useState<HTMLElement | null>(null);
  const [composer, setComposer] = useState<WallpaperContentRect>();
  const wallpaper = resolveWallpaper(mainScreenWallpaper(settings), project);
  const flat = canonSurface === "flat";
  const source = wallpaper.source;
  // The conversation paper overlay rule (useConversationWallpaper): images and non-riso live modules.
  const paperOverlay = source.kind === "image" || (source.kind === "live" && source.module !== "butler.riso-print")
    ? settings.conversation_background.overlay / 100 : 0;
  const background = source.kind === "none"
    ? undefined
    : <ProjectDashboardWallpaper wallpaper={wallpaper} header={header}
      flat={flat ? { column, composer, paperOverlay } : undefined} />;
  return { background, headerRef: setHeader, columnRef: setColumn, onComposerRect: setComposer, flat };
}
