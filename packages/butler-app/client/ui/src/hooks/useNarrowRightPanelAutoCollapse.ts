import { useEffect, useRef } from "react";

export const NARROW_RIGHT_PANEL_QUERY = "(max-width: 640px)";
export const ADAPTIVE_OVERLAY_QUERY = "(max-width: 1023px)";

export function useNarrowRightPanelAutoCollapse({
  leftOpen,
  rightOpen,
  effectiveRightOpen,
  setLeftOpen,
  setRightOpen,
}: {
  leftOpen: boolean;
  rightOpen: boolean;
  effectiveRightOpen: boolean;
  setLeftOpen: (value: boolean) => void;
  setRightOpen: (value: boolean) => void;
}) {
  const panelStateRef = useRef({ leftOpen, rightOpen });
  const suspendedStateRef = useRef<{
    leftOpen: boolean;
    rightOpen: boolean;
  } | null>(null);
  panelStateRef.current = { leftOpen, rightOpen };

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia(ADAPTIVE_OVERLAY_QUERY);
    const reconcileOverlayMode = (event?: MediaQueryListEvent) => {
      const matches = event?.matches ?? media.matches;
      if (matches) {
        suspendedStateRef.current ??= panelStateRef.current;
        setLeftOpen(false);
        setRightOpen(false);
        return;
      }
      const suspended = suspendedStateRef.current;
      if (!suspended) return;
      suspendedStateRef.current = null;
      setLeftOpen(suspended.leftOpen);
      setRightOpen(suspended.rightOpen);
    };
    reconcileOverlayMode();
    media.addEventListener("change", reconcileOverlayMode);
    return () => media.removeEventListener("change", reconcileOverlayMode);
  }, [setLeftOpen, setRightOpen]);

  useEffect(() => {
    if (
      !effectiveRightOpen ||
      typeof window === "undefined" ||
      !window.matchMedia
    ) {
      return;
    }
    const media = window.matchMedia(NARROW_RIGHT_PANEL_QUERY);
    const collapseLeftIfNarrow = () => {
      if (media.matches) setLeftOpen(false);
    };

    collapseLeftIfNarrow();
    media.addEventListener("change", collapseLeftIfNarrow);
    return () => media.removeEventListener("change", collapseLeftIfNarrow);
  }, [effectiveRightOpen, setLeftOpen]);
}
