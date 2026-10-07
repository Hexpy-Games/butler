import { useRef } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, ComposerCard, Notice } from "@/butler-ds";
import { useReserveHeight } from "./hooks/useReserveHeight.ts";

/** Keep retry in the composer's floating slot, above the message scroller. */
export function ComposerCrashFallback({ retry, onReserveChange }: {
  retry: () => void;
  onReserveChange: (height: number) => void;
}) {
  useAppLocale();
  const containerRef = useRef<HTMLDivElement | null>(null);
  useReserveHeight(containerRef, onReserveChange);
  return <ComposerCard floating large containerRef={containerRef}>
    <Notice tone="error" message={appCopy.interfacePanels.panelCrashed}
      action={<Button type="button" size="sm" variant="outline" onClick={retry}>
        {appCopy.interfacePanels.retry}
      </Button>} />
  </ComposerCard>;
}
