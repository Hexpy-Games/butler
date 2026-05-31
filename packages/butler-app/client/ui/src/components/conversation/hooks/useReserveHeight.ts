import { useEffect } from "react";
import type { RefObject } from "react";

export function useReserveHeight(
  wrapRef: RefObject<HTMLDivElement | null>,
  onReserveChange: (height: number) => void,
) {
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const updateReserve = () =>
      onReserveChange(element.getBoundingClientRect().height);
    updateReserve();
    const resizeObserver = new ResizeObserver(updateReserve);
    resizeObserver.observe(element);
    window.addEventListener("resize", updateReserve);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateReserve);
    };
  }, [wrapRef, onReserveChange]);
}
