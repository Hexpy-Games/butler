import { Component, createRef, type ReactNode } from "react";
import { prefersReducedMotion } from "../../lib/motion";
import { canMorph, startSetupMorph, type SetupWizardMorph } from "./setupWizardMorph";
import morphStyles from "./SetupWizardMorph.module.css";
import styles from "./SetupWizardShell.module.css";

/**
 * How the first card appears. `rerun`: the short re-run variant, the card
 * fades in with a 4px rise over --motion-slow (at once under reduced motion).
 * The full first-install intro (the ink scene) plugs in here as `full`.
 */
export type SetupWizardIntro = "none" | "rerun";

interface SetupWizardStageProps {
  stepKey: string;
  intro?: SetupWizardIntro;
  children: ReactNode;
}

interface SetupWizardStageState {
  /** The step whose card is rising in; null once nothing is moving. */
  enteringKey: string | null;
}

/** Longest exit before the snapshot is dropped even without `animationend`. */
const EXIT_FALLBACK_MS = 400;

/**
 * Replaces the focus column when `stepKey` changes. A static, inert copy of
 * the old card stays in place while the new card arrives on the same top
 * edge. When the card width changes (the 420px intro and a 520px step) the
 * card morphs: one surface moves its real edges, never scaled. Otherwise the
 * copy fades out and the new card rises in. Under reduced motion the card
 * swaps at once. The copy is plain DOM: the old step's React tree is not
 * rendered again.
 */
export class SetupWizardStage extends Component<SetupWizardStageProps, SetupWizardStageState> {
  state: SetupWizardStageState = { enteringKey: null };
  private readonly root = createRef<HTMLDivElement>();
  private readonly frame = createRef<HTMLDivElement>();
  private readonly ghosts = createRef<HTMLDivElement>();
  private readonly surface = createRef<HTMLDivElement>();
  private exitTimer: ReturnType<typeof setTimeout> | undefined;
  private morph: SetupWizardMorph | null = null;
  /** The first card's key while the re-run entrance applies; cleared by the first step change. */
  private rerunKey = this.props.intro === "rerun" && !prefersReducedMotion() ? this.props.stepKey : null;

  getSnapshotBeforeUpdate(previous: SetupWizardStageProps): HTMLElement | null {
    if (previous.stepKey === this.props.stepKey) return null;
    this.morph?.finish();
    if (prefersReducedMotion()) return null;
    const node = this.frame.current;
    return node ? (node.cloneNode(true) as HTMLElement) : null;
  }

  componentDidUpdate(_previous: SetupWizardStageProps, _state: SetupWizardStageState, snapshot: HTMLElement | null) {
    const ghosts = this.ghosts.current;
    if (!snapshot || !ghosts) return;
    for (const element of [snapshot, ...snapshot.querySelectorAll("[id]")]) element.removeAttribute("id");
    if (this.startMorph(ghosts, snapshot)) return;
    snapshot.className = `${styles.stageFrame} ${styles.stageExit}`;
    snapshot.setAttribute("data-stage", "exit");
    const drop = () => {
      clearTimeout(this.exitTimer);
      snapshot.remove();
    };
    snapshot.addEventListener("animationend", (event) => {
      if (event.target === snapshot) drop();
    });
    clearTimeout(this.exitTimer);
    this.exitTimer = setTimeout(drop, EXIT_FALLBACK_MS);
    ghosts.replaceChildren(snapshot);
    this.setState({ enteringKey: this.props.stepKey });
  }

  componentWillUnmount() {
    clearTimeout(this.exitTimer);
    this.morph?.finish();
  }

  /** The intro ↔ step card morph; false when the cards share a width (plain swap). */
  private startMorph(ghosts: HTMLDivElement, snapshot: HTMLElement): boolean {
    const root = this.root.current, frame = this.frame.current, surface = this.surface.current;
    if (!root || !frame || !surface || !canMorph(snapshot, frame)) return false;
    snapshot.className = styles.stageFrame;
    snapshot.setAttribute("data-stage", "morph");
    ghosts.replaceChildren(snapshot);
    const morph = startSetupMorph(root, surface, snapshot, frame, () => {
      snapshot.remove();
      if (this.morph === morph) this.morph = null;
    });
    if (!morph) {
      snapshot.remove();
      return false;
    }
    this.morph = morph;
    return true;
  }

  render() {
    const { stepKey, children } = this.props;
    if (this.rerunKey !== stepKey) this.rerunKey = null;
    const entering = this.state.enteringKey === stepKey;
    const motion = entering ? styles.stageEnter : this.rerunKey !== null ? styles.stageRerun : undefined;
    return (
      <div className={styles.stage} data-test-class="setup-wizard-stage" ref={this.root}>
        <div aria-hidden="true" className={morphStyles.surface} data-test-class="setup-wizard-morph-surface" hidden ref={this.surface} />
        <div aria-hidden="true" className={styles.stageGhosts} inert ref={this.ghosts} />
        <div
          className={motion ? `${styles.stageFrame} ${motion}` : styles.stageFrame}
          data-stage={entering ? "enter" : this.rerunKey !== null ? "rerun" : "current"}
          key={stepKey}
          ref={this.frame}
        >
          {children}
        </div>
      </div>
    );
  }
}
