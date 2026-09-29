import { useState, type ReactNode } from "react";
import { resolveWallpaper } from "@/app/projectWallpaper.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ProjectSummary } from "@/app/types.ts";
import { mainScreenWallpaper } from "@/components/conversation/mainScreenTheme.ts";
import { ProjectDashboardWallpaper } from "@/components/management/ProjectDashboardWallpaper.tsx";

/**
 * The project dashboard's ManagementPage background: the project's
 * wallpaper, or the global one when it inherits (`resolveWallpaper`).
 * A `none` source gives no background, so the page stays plain.
 * `headerRef` goes on the header panel the wallpaper keeps clear.
 */
export function useProjectDashboardBackground(project?: ProjectSummary): {
  background: ReactNode | undefined;
  headerRef: (element: HTMLDivElement | null) => void;
} {
  const settings = useButlerStore((state) => state.settings);
  const [header, setHeader] = useState<HTMLDivElement | null>(null);
  const wallpaper = resolveWallpaper(mainScreenWallpaper(settings), project);
  const background = wallpaper.source.kind === "none"
    ? undefined
    : <ProjectDashboardWallpaper wallpaper={wallpaper} header={header} />;
  return { background, headerRef: setHeader };
}
