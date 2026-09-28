import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ProjectWallpaper } from "@/app/types.ts";
import { uploadedWallpaperSource } from "@/app/wallpaperAssets.ts";
import { Dialog, DialogContent, DialogHeader, DialogTitle, ScrollArea, WallpaperPicker } from "@/butler-ds";
import { mainScreenWallpaper } from "@/components/conversation/mainScreenTheme.ts";
import { useWallpaperAssets } from "@/components/settings/hooks/useWallpaperAssets";
import { useWallpaperModules } from "@/components/settings/hooks/useWallpaperModules";
import { wallpaperPickerLabels } from "@/components/settings/wallpaperPickerLabels";
import { useProjectWallpaperSave } from "@/hooks/useProjectWallpaperSave.ts";

interface ProjectWallpaperDialogProps {
  projectId: string;
  /** The stored wallpaper when the dialog opens. */
  value: ProjectWallpaper;
  /** The dashboard preferences revision (CAS); unknown: read before the first save. */
  revision?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The project's wallpaper: the shared picker with a first "Use global" tile
 * (previewing the global wallpaper), live modules and uploaded images. The
 * picker follows every edit at once; the save goes out once edits pause, and
 * the dashboard follows through `project.updated`.
 */
export function ProjectWallpaperDialog({ open, onOpenChange, ...picker }: ProjectWallpaperDialogProps) {
  useAppLocale();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={appCopy.common.close} aria-describedby={undefined} size="lg" layout="scroll-body" data-test-class="project-wallpaper-dialog">
        <DialogHeader><DialogTitle>{appCopy.projectSignpost.wallpaper}</DialogTitle></DialogHeader>
        <ScrollArea fill>
          <ProjectWallpaperPicker {...picker} />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

/** Mounted only while the dialog is open: lists the images, and saves the last edit when it closes. */
function ProjectWallpaperPicker({ projectId, value, revision }: Omit<ProjectWallpaperDialogProps, "open" | "onOpenChange">) {
  const locale = useAppLocale();
  const settings = useButlerStore((state) => state.settings);
  const images = useWallpaperAssets();
  const modules = useWallpaperModules();
  const [draft, setDraft] = useState(value);
  const save = useProjectWallpaperSave(projectId, revision);
  const change = (next: ProjectWallpaper) => {
    setDraft(next);
    save(next);
  };
  const upload = async (file: File) => {
    const asset = await images.upload(file);
    if (asset) change(uploadedWallpaperSource(asset));
  };
  const importModule = async (file: File) => {
    const installed = await modules.importModule(file);
    if (installed) change({ kind: "live", module: installed.id });
  };
  return (
    <WallpaperPicker
      dataTestClass="project-wallpaper-picker"
      images={images.assets}
      importingModule={modules.importing}
      inherit={{ label: appCopy.settings.wallpaper.inherit, source: mainScreenWallpaper(settings).source }}
      labels={wallpaperPickerLabels()}
      locale={locale}
      uploading={images.uploading}
      value={draft}
      onChange={change}
      onDeleteImage={(id) => void images.remove(id)}
      onDeleteModule={(id) => void modules.deleteModule(id)}
      onImportModule={(file) => void importModule(file)}
      onUpload={(file) => void upload(file)}
    />
  );
}
