import { Button, ButtonContainer } from "@/butler-ds";
import { appCopy } from "@/app/copy";

/** Keeps the existing replace action with the inline import feedback. */
export function WallpaperImportError({ message, replace }: { message?: string; replace?: () => void }) {
  if (!message) return null;
  return <>{message}{replace ? <ButtonContainer size="sm">
    <Button size="sm" variant="outline" onClick={replace}>{appCopy.settings.wallpaper.replaceModule}</Button>
  </ButtonContainer> : null}</>;
}
