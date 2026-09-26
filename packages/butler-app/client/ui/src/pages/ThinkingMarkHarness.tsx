import { appCopy } from "@/app/copy.ts";
import { type CSSProperties, useState } from "react";
import { ButlerMarkIcon } from "@/components/common/ButlerMarkIcon.tsx";
import { ButlerThinkingMark } from "@/butler-ds";
import { AssistantStatusLabel } from "@/components/conversation/AssistantStatusLabel.tsx";
import styles from "./ThinkingMarkHarness.module.css";

void styles;

type MarkState = "idle" | "working";
type Theme = "dark" | "light";

const THEMES: readonly Theme[] = ["dark", "light"];
const SMALL_SIZES = ["sm", "xl"] as const;

function surfaceClass(theme: Theme) {
  return `${styles.surface} ${theme === "dark" ? styles["surface-dark"] : styles["surface-light"]}`;
}

function Segmented<T extends string>({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: T) => void;
  options: readonly { label: string; value: T }[];
  value: T;
}) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          className={value === option.value ? styles["segment-active"] : styles.segment}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ThinkingMarkHarness() {
  const [size, setSize] = useState(230);
  const [markState, setMarkState] = useState<MarkState>("working");
  const [motion, setMotion] = useState<"full" | "reduced">("full");
  const markStyle = { "--thinking-mark-size": `${size}px` } as CSSProperties;
  const reducedMotion = motion === "reduced" ? true : undefined;

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
            <div className={styles["control-label"]}>{appCopy.automations.fields.state}</div>
            <Segmented
              label="Thinking mark state"
              onChange={setMarkState}
              options={[
                { label: "Idle", value: "idle" },
                { label: appCopy.space.working, value: "working" },
              ]}
              value={markState}
            />
            <Segmented
              label="Thinking mark motion"
              onChange={setMotion}
              options={[
                { label: "Full motion", value: "full" },
                { label: "Reduced", value: "reduced" },
              ]}
              value={motion}
            />
          </div>
        </div>
        <div className={styles.grid}>
          {THEMES.map((theme) => (
            <section className={styles.sample} key={`canvas-${theme}`}>
              <div className={surfaceClass(theme)}>
                <div className={styles.mark} style={markStyle}>
                  <ButlerThinkingMark reducedMotion={reducedMotion} state={markState} theme={theme} />
                </div>
              </div>
              <div className={styles.label}>{theme === "dark" ? "Dark" : "Light"} mode canvas</div>
            </section>
          ))}
          {THEMES.map((theme) => (
            <section className={styles.sample} key={`small-${theme}`}>
              <div className={`${surfaceClass(theme)} ${styles["surface-small"]}`}>
                {SMALL_SIZES.map((small) => (
                  <ButlerThinkingMark
                    key={small}
                    reducedMotion={reducedMotion}
                    size={small}
                    state={markState}
                    theme={theme}
                  />
                ))}
                <AssistantStatusLabel
                  label="Status"
                  markTheme={theme}
                  state={markState === "working" ? "active" : "complete"}
                >
                  {markState === "working" ? appCopy.space.working : "Done"}
                </AssistantStatusLabel>
              </div>
              <div className={styles.label}>14px, 24px and status label</div>
            </section>
          ))}
          <section className={styles.sample}>
            <div className={surfaceClass("dark")}>
              <ButlerMarkIcon className={styles.mark} style={markStyle} theme="dark" />
            </div>
            <div className={styles.label}>Dark mode SVG idle icon</div>
          </section>
          <section className={styles.sample}>
            <div className={surfaceClass("light")}>
              <ButlerMarkIcon className={styles.mark} style={markStyle} theme="light" />
            </div>
            <div className={styles.label}>Light mode SVG idle icon</div>
          </section>
        </div>
      </div>
    </main>
  );
}
