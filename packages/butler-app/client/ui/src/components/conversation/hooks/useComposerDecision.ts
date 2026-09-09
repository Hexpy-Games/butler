import { useButlerStore } from "@/app/store.ts";
import { useComposerStore } from "../composerStore";
import { useComposerAuthorityDecision } from "../useComposerAuthorityDecision";
import { useComposerPlanDecision } from "../useComposerPlanDecision";
import { useComposerKeyboard } from "./useComposerKeyboard";
import type { ComposerSubmit } from "./composerEventTypes";

/** Keep the visible decision, form submission, and keyboard submission on the same owner. */
export function useComposerDecision(isComposing: boolean, enabled = true) {
  const submit = useComposerStore((state) => state.submit);
  const setModelMenuOpen = useComposerStore((state) => state.setModelMenuOpen);
  const setAccessMenuOpen = useComposerStore((state) => state.setAccessMenuOpen);
  const multilineSendBehavior = useButlerStore((state) => state.settings.multiline_send_behavior);
  const activeAuthority = useComposerAuthorityDecision();
  const activePlan = useComposerPlanDecision();
  const authority = enabled ? activeAuthority : undefined;
  const plan = enabled ? activePlan : undefined;
  let onSubmit: ComposerSubmit = plan?.onSubmitInstruction ?? submit;
  if (authority) {
    onSubmit = authority.composingMessage ? submit : (event) => event.preventDefault();
  }
  const onKeyDown = useComposerKeyboard({ isComposing, multilineSendBehavior,
    setModelMenuOpen, setAccessMenuOpen, submit: onSubmit });
  return { authority, plan, onSubmit, onKeyDown };
}
