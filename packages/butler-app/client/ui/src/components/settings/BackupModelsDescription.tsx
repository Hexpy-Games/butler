import { useAppLocale } from "@/app/copy.ts";
import { Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";

export function BackupModelsDescription() {
  useAppLocale();
  return <Typo.Caption>{appCopy.settings.backupModels.description}</Typo.Caption>;
}
