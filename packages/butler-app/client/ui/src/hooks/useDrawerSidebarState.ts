import { useEffect, useRef } from "react";
import { adaptiveDrawerQuery } from "@/libs/design-system/responsive";
import { chromeEnvironment } from "@/app/chromeEnvironment";

/** Suspend the docked sidebar choice while entering drawer mode, then restore it. */
export function useDrawerSidebarState({ leftOpen, setLeftOpen }: {
  leftOpen: boolean; setLeftOpen: (open: boolean) => void;
}) {
  const current = useRef(leftOpen);
  const suspended = useRef<boolean | null>(null);
  current.current = leftOpen;
  useEffect(() => {
    const media = window.matchMedia(adaptiveDrawerQuery(chromeEnvironment()));
    const reconcile = () => {
      if (media.matches) {
        suspended.current ??= current.current;
        setLeftOpen(false);
      } else if (suspended.current !== null) {
        const previous = suspended.current;
        suspended.current = null;
        setLeftOpen(previous);
      }
    };
    reconcile();
    media.addEventListener("change", reconcile);
    return () => media.removeEventListener("change", reconcile);
  }, [setLeftOpen]);
}
