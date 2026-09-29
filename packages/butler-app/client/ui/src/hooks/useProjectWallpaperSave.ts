import { useEffect, useRef } from "react";
import { appCopy } from "@/app/copy.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { saveProjectWallpaper } from "@/app/projectWallpaperSave.ts";
import type { ProjectWallpaper } from "@/app/types.ts";

/** Trailing wait before a wallpaper edit is written: a slider drag saves once. */
const SAVE_DELAY = 300;

/**
 * Saves a project's wallpaper once edits pause (or when the caller unmounts):
 * one PATCH at a time, each under the last revision it saw (the dashboard's,
 * or the previous save's). A conflict is refetched and retried once
 * (`saveProjectWallpaper`); a save that still fails is one brief toast.
 */
export function useProjectWallpaperSave(projectId: string, revision?: number): (wallpaper: ProjectWallpaper) => void {
  const known = useRef(revision);
  const pending = useRef<ProjectWallpaper | null>(null);
  const timer = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const flush = useRef<() => void>(() => undefined);

  useEffect(() => {
    // A refreshed dashboard (after this save, or another write) moves the revision on.
    if (revision !== undefined && (known.current === undefined || revision > known.current)) known.current = revision;
  }, [revision]);

  useEffect(() => {
    flush.current = () => {
      window.clearTimeout(timer.current);
      const wallpaper = pending.current;
      pending.current = null;
      if (wallpaper === null) return;
      queue.current = queue.current.then(async () => {
        try {
          known.current = await saveProjectWallpaper(projectId, wallpaper, { revision: known.current });
        } catch {
          known.current = undefined;
          notifyStatus(appCopy.settings.wallpaper.saveFailed, { id: "project-wallpaper", tone: "error" });
        }
      });
    };
  });

  useEffect(() => () => flush.current(), []);

  return (wallpaper) => {
    pending.current = wallpaper;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flush.current(), SAVE_DELAY);
  };
}
