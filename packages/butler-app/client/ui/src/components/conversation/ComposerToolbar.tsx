import {
  ComposerCardToolbar,
  ComposerCardToolbarSpacer,
  ComposerSendButton,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useComposerStore } from "./composerStore";
import { AccessModeMenu } from "./AccessModeMenu";
import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";
import { ComposerContextControl } from "./ComposerContextControl";
import { ModelMenu } from "./ModelMenu";

export function ComposerToolbar() {
  const isSending = useComposerStore((store) => store.isSending);
  const activeTurn = useComposerStore((store) => store.activeTurn);
  const canSend = useComposerStore((store) => store.canSend);
  const onStop = useComposerStore((store) => store.onStop);

  return (
    <ComposerCardToolbar>
      <ComposerAttachmentMenu />
      <AccessModeMenu />
      <ComposerCardToolbarSpacer />
      <ComposerContextControl />
      <ModelMenu />
      {(isSending || activeTurn) && !canSend ? (
        <ComposerSendButton
          mode="stop"
          aria-label={appCopy.composer.stop}
          onClick={onStop}
        />
      ) : (
        <ComposerSendButton
          aria-label={appCopy.composer.send}
          disabled={!canSend}
        />
      )}
    </ComposerCardToolbar>
  );
}
