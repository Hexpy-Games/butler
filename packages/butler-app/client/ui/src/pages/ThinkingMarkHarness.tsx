import { type CSSProperties, useState } from "react";
import { ButlerMarkIcon } from "@/components/common/ButlerMarkIcon.tsx";
import { ButlerThinkingMark } from "@/components/common/ButlerThinkingMark.tsx";
import styles from "./ThinkingMarkHarness.module.css";

void styles;

export function ThinkingMarkHarness() {
  const [size, setSize] = useState(230);
  const [markState, setMarkState] = useState<"idle" | "working">("working");
  const markStyle = { "--thinking-mark-size": `${size}px` } as CSSProperties;

  return (
    <main className={`${styles.moduleScope} ${styles.page}`}>
      <div className={styles.stack}>
        <div className={styles.controls}>
          <div className={styles["control-group"]}>
            <label className={styles["control-label"]} htmlFor="thinking-mark-size">
              Size {size}px
            </label>
            <input
              className={styles.slider}
              id="thinking-mark-size"
              max="340"
              min="72"
              onChange={(event) => setSize(Number(event.currentTarget.value))}
              step="1"
              type="range"
              value={size}
            />
          </div>
          <div className={styles["control-group"]}>
            <div className={styles["control-label"]}>State</div>
            <div className={styles.segmented} role="group" aria-label="Thinking mark state">
              <button
                className={markState === "idle" ? styles["segment-active"] : styles.segment}
                onClick={() => setMarkState("idle")}
                type="button"
              >
                Idle
              </button>
              <button
                className={markState === "working" ? styles["segment-active"] : styles.segment}
                onClick={() => setMarkState("working")}
                type="button"
              >
                Working
              </button>
            </div>
          </div>
        </div>
        <div className={styles.grid}>
          <section className={styles.sample}>
            <div className={`${styles.surface} ${styles["surface-dark"]}`}>
              <ButlerThinkingMark className={styles.mark} state={markState} style={markStyle} theme="dark" />
            </div>
            <div className={styles.label}>Dark mode canvas</div>
          </section>
          <section className={styles.sample}>
            <div className={`${styles.surface} ${styles["surface-light"]}`}>
              <ButlerThinkingMark className={styles.mark} state={markState} style={markStyle} theme="light" />
            </div>
            <div className={styles.label}>Light mode canvas</div>
          </section>
          <section className={styles.sample}>
            <div className={`${styles.surface} ${styles["surface-dark"]}`}>
              <ButlerMarkIcon className={styles.mark} style={markStyle} theme="dark" />
            </div>
            <div className={styles.label}>Dark mode SVG idle icon</div>
          </section>
          <section className={styles.sample}>
            <div className={`${styles.surface} ${styles["surface-light"]}`}>
              <ButlerMarkIcon className={styles.mark} style={markStyle} theme="light" />
            </div>
            <div className={styles.label}>Light mode SVG idle icon</div>
          </section>
        </div>
      </div>
    </main>
  );
}
