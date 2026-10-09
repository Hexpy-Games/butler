import { Component, createRef, type ReactNode } from "react";
import { prefersReducedMotion } from "../../lib/motion";
import styles from "./SetupWizardShell.module.css";

interface SetupWizardStageProps {
  stepKey: string;
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
 * the old card fades out in place while the new card rises in on the same
 * top edge; widths never animate. Under reduced motion the card swaps at once.
 * The copy is plain DOM: the old step's React tree is not rendered again.
 */
export class SetupWizardStage extends Component<SetupWizardStageProps, SetupWizardStageState> {
  state: SetupWizardStageState = { enteringKey: null };
  private readonly frame = createRef<HTMLDivElement>();
  private readonly ghosts = createRef<HTMLDivElement>();
  private exitTimer: ReturnType<typeof setTimeout> | undefined;

  getSnapshotBeforeUpdate(previous: SetupWizardStageProps): HTMLElement | null {
    if (previous.stepKey === this.props.stepKey || prefersReducedMotion()) return null;
    const node = this.frame.current;
    return node ? (node.cloneNode(true) as HTMLElement) : null;
  }

  componentDidUpdate(_previous: SetupWizardStageProps, _state: SetupWizardStageState, snapshot: HTMLElement | null) {
    const ghosts = this.ghosts.current;
    if (!snapshot || !ghosts) return;
    for (const element of [snapshot, ...snapshot.querySelectorAll("[id]")]) element.removeAttribute("id");
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
  }

  render() {
    const { stepKey, children } = this.props;
    const entering = this.state.enteringKey === stepKey;
    return (
      <div className={styles.stage} data-test-class="setup-wizard-stage">
        <div aria-hidden="true" className={styles.stageGhosts} inert ref={this.ghosts} />
        <div
          className={entering ? `${styles.stageFrame} ${styles.stageEnter}` : styles.stageFrame}
          data-stage={entering ? "enter" : "current"}
          key={stepKey}
          ref={this.frame}
        >
          {children}
        </div>
      </div>
    );
  }
}
