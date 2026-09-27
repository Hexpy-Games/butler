import { useAppLocale } from "@/app/copy.ts";
import { CopyButton } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";

export function CopyTextButton({ text, label }: { text: string; label: string }) {
  useAppLocale();
  return (
    <CopyButton
      text={text}
      label={label}
      copiedLabel={appCopy.conversation.messageActions.copied}
      onError={(error) => notifyError(error, appCopy.conversation.messageActions.copyFailed)}
    />
  );
}
