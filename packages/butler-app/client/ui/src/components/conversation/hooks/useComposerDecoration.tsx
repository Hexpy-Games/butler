import type { useComposerDecision } from "./useComposerDecision";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useButlerStore } from "@/app/store.ts";
import { ComposerDecoration, composerDecorationEdge } from "@/butler-ds";

/** Only appearance changes invalidate these elements; editor text never does. */
export function useComposerDecoration({ authority, question, plan }: ReturnType<typeof useComposerDecision>) {
  const replacesInput = Boolean(authority ? !authority.composingMessage
    : question ? question.panel.state !== "collapsed" : plan && !plan.editingInstruction);
  const [theme, character] = useButlerStore(useShallow((state) => [
    state.settings.composer_decoration.theme,
    state.settings.composer_decoration.character,
  ] as const));
  return useMemo(() => {
    if (theme === "none" || replacesInput) return {};
    return {
      decoration: <ComposerDecoration scene={theme} motion="auto" pauseOnBattery />,
      edge: character ? composerDecorationEdge(theme) : undefined,
    };
  }, [theme, character, replacesInput]);
}
