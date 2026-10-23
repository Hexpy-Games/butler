import type { ReactNode, Ref } from "react";
import { Grid, ManagementPagePanel, Stack } from "@/butler-ds";
import { canonDetailLayout, useCanonDetailSelection } from "@/app/canonDetailLayout.ts";
import { CanonDetailAside } from "@/components/canon/CanonDetailAside.tsx";

/**
 * SCRATCH PROTOTYPE (research/canon-detail-layout).
 * Push layout: the dashboard content and the 과제 detail share the page in
 * flow (Grid `main-aside`); the detail enters with Presence `rise`.
 */
export function DashboardColumns({ projectId, board, glass, children }: {
  projectId?: string; board: boolean; glass: boolean; children: ReactNode;
}) {
  const open = useCanonDetailSelection(state => state.target?.via === "push" && state.target.projectId === projectId);
  if (canonDetailLayout !== "push" || !projectId) return <>{children}</>;
  const aside = board && open;
  return <Grid columns={aside ? "main-aside" : "1"} cross="start" gap="xl">
    {children}
    {board && <CanonDetailAside projectId={projectId} glass={glass} />}
  </Grid>;
}

/** Glass: ManagementPagePanel (TintedGlass over a wallpaper). Flat: the same group with no surface. */
export function DashboardPanel({ flat, ref, children }: { flat: boolean; ref?: Ref<HTMLDivElement>; children: ReactNode }) {
  if (flat) return <Stack gap="xl">{children}</Stack>;
  return <ManagementPagePanel ref={ref}>{children}</ManagementPagePanel>;
}

/** Flat: measures the content column for the wallpaper's `columnRect` (as the chat column does). */
export function FlatColumn({ flat, columnRef, children }: { flat: boolean; columnRef: (element: HTMLElement | null) => void; children: ReactNode }) {
  if (!flat) return <>{children}</>;
  return <Grid columns="1" ref={columnRef}>{children}</Grid>;
}
