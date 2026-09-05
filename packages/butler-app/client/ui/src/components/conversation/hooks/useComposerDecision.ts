import { useButlerStore } from "@/app/store.ts";
import { useComposerStore } from "../composerStore";
import { useComposerAuthorityDecision } from "../useComposerAuthorityDecision";
import { useComposerPlanDecision } from "../useComposerPlanDecision";
import { useComposerKeyboard } from "./useComposerKeyboard";
import type { ComposerSubmit } from "./composerEventTypes";

/** Keep the visible decision, form submission, and keyboard submission on the same owner. */
export function useComposerDecision(isComposing: boolean) {
  const submit = useComposerStore((state) => state.submit);
  const setModelMenuOpen = useComposerStore((state) => state.setModelMenuOpen);
  const setAccessMenuOpen = useComposerStore((state) => state.setAccessMenuOpen);
  const multilineSendBehavior = useButlerStore((state) => state.settings.multiline_send_behavior);
  const authority = useComposerAuthorityDecision();
  const plan = useComposerPlanDecision();
  let onSubmit: ComposerSubmit = plan?.onSubmitInstruction ?? submit;
  if (authority) {
    onSubmit = authority.composingMessage ? submit
      : authority.editingInstruction ? authority.onSubmitInstruction
        : (event) => event.preventDefault();
  }
  const onKeyDown = useComposerKeyboard({ isComposing, multilineSendBehavior,
    setModelMenuOpen, setAccessMenuOpen, submit: onSubmit });
  return { authority, plan, onSubmit, onKeyDown };
}
