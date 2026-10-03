import { dsClass } from "../../lib/internal";
import { useState } from "react";
import { ComposerCard, ComposerCardTextarea, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton } from "../../blocks/ComposerCard";
import { ComposerControl } from "../../blocks/ComposerControl";
import { IconButton } from "../../components/IconButton";
import { Plus, AiChip } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { PageHeader } from "../parts";
import type { ViewerState } from "../viewerState";
import { DecorationArt } from "./DecorationArt";
import { DecorationControls } from "./DecorationControls";
import { initialSettings } from "./types";
import { useDecoration } from "./useDecoration";
import styles from "./decorations.module.css";

export function ComposerDecorationsPage({ state, onChange }: {
  state: ViewerState; onChange: (patch: Partial<ViewerState>) => void;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const { root, surface, readout } = useDecoration(settings);
  const coastal = settings.theme === "coastal";
  return <div className={styles.page}>
    <PageHeader eyebrow="Interactive study · 474" title="Composer decorations" lead="A little life around your words. Type to try it." />
    <div className={styles.layout}>
      <div className={styles.previewColumn}>
        <div className={styles.stage} data-photo={settings.wallpaper} data-phone={settings.phone}>
          <div className={styles.stageTitle}><Typo.Caption>YOUR OWN LITTLE CORNER</Typo.Caption>
            <Typo.H2>Make room for a thought.</Typo.H2></div>
          <div className={styles.composition} ref={surface} data-theme={settings.theme} data-palette={settings.palette}
            data-overflow={settings.overflow}>
            <ComposerCard className={dsClass(styles.card)} onSubmit={event => event.preventDefault()}>
              <div ref={root} className={styles.decoration} aria-hidden="true" data-decoration-layer>
                {coastal ? <canvas className={styles.coast} /> : settings.theme !== "none" ? <DecorationArt theme={settings.theme} /> : null}
              </div>
              <div className={styles.readable}>
                <ComposerCardTextarea aria-label="Try your message" placeholder="어떤 생각을 하고 계세요?" rows={3} className={dsClass(styles.editor)} />
              </div>
              <div className={styles.toolbar}>
                <ComposerCardToolbar>
                  <IconButton label="Attach (preview)" disabled><Plus size="md" /></IconButton>
                  <ComposerCardToolbarSpacer />
                  <ComposerControl icon={<AiChip size="sm" />} label="Butler" />
                  <ComposerSendButton aria-label="Send (preview)" disabled mode="send" />
                </ComposerCardToolbar>
              </div>
            </ComposerCard>
          </div>
          <div className={styles.stageNote}><Typo.Caption>Just a preview. Your words stay here.</Typo.Caption></div>
        </div>
        <div className={styles.performance}>
          <Typo.Caption>DECORATION JS · MAIN THREAD</Typo.Caption>
          <output ref={readout} aria-live="off" data-decoration-perf>0.000 ms/edit · 0 frames · 0 edits · idle: 0 scheduled work</output>
          <Typo.Caption>Target &lt; 1 ms/edit. Draw JS excludes paint/GPU. Full-frame CPU/GPU cost: unavailable here.</Typo.Caption>
        </div>
      </div>
      <DecorationControls settings={settings} update={patch => setSettings(current => ({ ...current, ...patch }))} state={state} onChange={onChange} />
    </div>
  </div>;
}
