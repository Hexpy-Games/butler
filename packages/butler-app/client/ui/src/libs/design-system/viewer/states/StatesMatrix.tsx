import { Fragment, useEffect, useRef, type CSSProperties } from "react";
import { Typo } from "../../components/Typo";
import type { ShowcaseStateMatrix } from "../../showcase";
import type { ResolvedTheme } from "../useViewerTheme";
import type { ViewerLocale } from "../viewerState";
import { documentRules, forceStateCss, markForceTargets } from "./forceState";
import styles from "../DesignSystemViewer.module.css";

let layerUsers = 0;

/** Injects the forced-state stylesheet while at least one matrix is on screen. */
export function useForceStateLayer() {
  useEffect(() => {
    layerUsers += 1;
    if (layerUsers === 1) {
      const style = document.createElement("style");
      style.dataset.dsForceStateLayer = "";
      style.textContent = forceStateCss(documentRules(document));
      document.head.append(style);
    }
    return () => {
      layerUsers -= 1;
      if (layerUsers === 0) document.head.querySelector("style[data-ds-force-state-layer]")?.remove();
    };
  }, []);
}

/** Variants (rows) × states (columns); hover, focus-visible and active are forced. */
export function StatesMatrix({ matrix, locale, theme }: { matrix: ShowcaseStateMatrix; locale: ViewerLocale; theme: ResolvedTheme }) {
  useForceStateLayer();
  const root = useRef<HTMLDivElement>(null);
  // Each cell forces its state on one target element (the first enabled
  // focusable one unless the story marks `data-ds-force-target`).
  useEffect(() => {
    if (root.current) markForceTargets(root.current);
  });
  const variants = matrix.variants ?? ["default"];
  const appLocale = locale === "ko" ? "ko-KR" : "en-US";
  return (
    <div ref={root} className={`${styles.matrix} theme-${theme}`} data-ds-states-matrix style={{ "--matrix-columns": matrix.states.length } as CSSProperties}>
      <span />
      {matrix.states.map((state) => (
        <div className={styles.matrixHead} key={state}><Typo.Caption tone="secondary">{state}</Typo.Caption></div>
      ))}
      {variants.map((variant) => (
        <Fragment key={variant}>
          <div className={styles.matrixHead}><Typo.Caption tone="secondary">{variant}</Typo.Caption></div>
          {matrix.states.map((state) => (
            <div className={styles.matrixCell} data-ds-force-state={state} data-ds-state-cell={`${variant}:${state}`} key={state} lang={locale}>
              {matrix.render({ locale: appLocale, state, variant })}
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  );
}
