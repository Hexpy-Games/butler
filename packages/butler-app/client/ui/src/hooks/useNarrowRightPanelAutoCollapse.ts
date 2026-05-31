import { useEffect } from "react";

export const NARROW_RIGHT_PANEL_QUERY = "(max-width: 640px)";

export function useNarrowRightPanelAutoCollapse({
  rightOpen,
  setLeftOpen,
}: {
  rightOpen: boolean;
  setLeftOpen: (value: boolean) => void;
}) {
  useEffect(() => {
    if (!rightOpen || typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const media = window.matchMedia(NARROW_RIGHT_PANEL_QUERY);
    const collapseLeftIfNarrow = () => {
      if (media.matches) setLeftOpen(false);
    };

    collapseLeftIfNarrow();
    media.addEventListener("change", collapseLeftIfNarrow);
    return () => media.removeEventListener("change", collapseLeftIfNarrow);
  }, [rightOpen, setLeftOpen]);
}
