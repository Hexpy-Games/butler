import { Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";

export function BackupModelsDescription() {
  return <Typo.Caption>{appCopy.settings.backupModels.description}</Typo.Caption>;
}
