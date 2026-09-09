import { useLayoutEffect, useRef, useState } from "react";
import { resolvePanelGeometry } from "@/app/panelSizing";
import { chromeEnvironment } from "@/app/chromeEnvironment";
import { useAdaptiveDrawer } from "@/libs/design-system/responsive";

/** One measured shell content box drives rendering and all resize controls. */
export function usePanelGeometry(input: { leftWidth: number; rightWidth: number; leftOpen: boolean }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => window.innerWidth);
  const drawer = useAdaptiveDrawer(chromeEnvironment());
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const measure = () => {
      const css = getComputedStyle(shell);
      setWidth(shell.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);
  return { shellRef, ...resolvePanelGeometry({ ...input, width, drawer }) };
}
