import { Component, createRef, type ReactNode } from "react";
import { prefersReducedMotion } from "../../lib/motion";
import type { WallpaperIntroTimeline } from "../Wallpaper/intro/introTimeline";
import { runSetupIntro, type SetupIntroPhase, type SetupIntroRun } from "./setupIntro";
import { copyFrame } from "./setupMorphLayers";
import { canMorph, startSetupMorph, type SetupWizardMorph } from "./setupWizardMorph";
import morphStyles from "./SetupWizardMorph.module.css";
import styles from "./SetupWizardShell.module.css";
import introStyles from "./SetupWizardIntro.module.css";

/**
 * How the first card appears. `full`: the first-install ink intro (the
 * backdrop writes the mark, which lands in the SetupWizardMark slot of the
 * card, then the card and its lines arrive). `rerun`: the short re-run
 * variant, the dried print still and the card fading in with a 4px rise over
 * --motion-slow (at once under reduced motion).
 */
export type SetupWizardIntro = "none" | "rerun" | "full";

interface SetupWizardStageProps {
  stepKey: string;
  intro?: SetupWizardIntro;
  /** The ink intro clock the backdrop shares (intro `full` or `rerun`). */
  timeline?: WallpaperIntroTimeline | null;
  children: ReactNode;
}

interface SetupWizardStageState {
  /** The step whose card is rising in; null once nothing is moving. */
  enteringKey: string | null;
  introPhase: SetupIntroPhase;
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
  state: SetupWizardStageState = { enteringKey: null, introPhase: this.props.intro === "full" && this.props.timeline ? "pending" : null };
  private intro: SetupIntroRun | null = null;
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
    return node ? copyFrame(node) : null;
  }

  componentDidMount() {
    const { timeline, intro } = this.props, stage = this.root.current, surface = this.surface.current;
    if (!timeline || !stage || !surface) return;
    this.intro = runSetupIntro({ stage, surface, timeline, frame: () => this.frame.current, rerun: intro === "rerun", onPhase: (introPhase) => this.setState({ introPhase }) });
  }

  componentDidUpdate(previous: SetupWizardStageProps, _state: SetupWizardStageState, snapshot: HTMLElement | null) {
    const ghosts = this.ghosts.current;
    const changed = previous.stepKey !== this.props.stepKey;
    if (!snapshot || !ghosts) return changed ? this.intro?.stepChanged(null, null) : undefined;
    for (const element of [snapshot, ...snapshot.querySelectorAll("[id]")]) element.removeAttribute("id");
    if (this.startMorph(ghosts, snapshot)) return;
    this.intro?.stepChanged(null, null);
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
    this.intro?.dispose();
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
      this.intro?.measure();
    });
    if (!morph) {
      snapshot.remove();
      return false;
    }
    this.morph = morph;
    // The print beat: the ink keep-out moves from the old card to the new one, then the intro hands off.
    this.intro?.stepChanged(morph.from, morph.to);
    return true;
  }

  render() {
    const { stepKey, children } = this.props;
    if (this.rerunKey !== stepKey) this.rerunKey = null;
    const entering = this.state.enteringKey === stepKey;
    const motion = entering ? styles.stageEnter : this.rerunKey !== null ? styles.stageRerun : undefined;
    return (
      <div className={`${styles.stage} ${introStyles.stage}`} data-intro={this.state.introPhase ?? undefined} data-test-class="setup-wizard-stage" ref={this.root}>
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
