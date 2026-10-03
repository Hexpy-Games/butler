import { useState } from "react";
import {
  ComposerCard, ComposerCardEditable, ComposerCardEditor, ComposerCardExpandedBody,
  ComposerCardExpandedControls, ComposerCardPlaceholder, ComposerCardToolbar, ComposerCardToolbarSpacer,
  ComposerControl, ComposerPlanToggle, ComposerSendButton, ContextDonutButton, IconButton, Plus, ShieldQuestion, AiChip, Wallpaper,
} from "@/butler-ds";
import { ComposerDecoration } from "../../../decorations/composer/ComposerDecoration";
import type { DecorationMetrics, DecorationOptions, DecorationTheme } from "../../../decorations/composer/types";
import styles from "./ComposerExample.module.css";

export interface ExampleOptions extends Omit<DecorationOptions, "theme"> {
  theme: DecorationTheme;
  wallpaper: boolean;
}

/** Same composition as ComposerCard's existing New chat story, plus one decoration. */
export function ComposerExample({ options, onMetrics }: { options: ExampleOptions; onMetrics: (metrics: DecorationMetrics) => void }) {
  const [plan, setPlan] = useState(false);
  const [draft, setDraft] = useState("");
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <div className={styles.stage} data-decoration-stage>
      {options.wallpaper ? (
        <Wallpaper source={{ kind: "live", module: "butler.shoreline" }} scope="container" tone={options.tone} motion="paused" />
      ) : null}
      <ComposerCard large containerRef={setHost} onSubmit={(event) => event.preventDefault()}>
        <ComposerDecoration {...options} edgeHost={host} onMetrics={onMetrics} />
        <ComposerCardExpandedBody>
          <ComposerCardEditor>
            <ComposerCardEditable>
              <div aria-label="Ask Butler anything" contentEditable role="textbox" suppressContentEditableWarning
                onInput={(event) => setDraft(event.currentTarget.textContent ?? "")} />
            </ComposerCardEditable>
            {draft ? null : <ComposerCardPlaceholder>Ask Butler anything</ComposerCardPlaceholder>}
          </ComposerCardEditor>
        </ComposerCardExpandedBody>
        <ComposerCardToolbar>
          <IconButton label="More options"><Plus size="md" /></IconButton>
          <ComposerCardExpandedControls>
            <ComposerControl compact="icon" icon={<ShieldQuestion size="sm" />} label="Ask" aria-label="Ask" />
            <ComposerPlanToggle checked={plan} label="Plan" onCheckedChange={setPlan} />
            <ComposerCardToolbarSpacer />
            <ContextDonutButton aria-label="Context 42% used" ratio={0.42} />
            <ComposerControl icon={<AiChip size="sm" />} label="GPT-5.1" detail="medium" />
          </ComposerCardExpandedControls>
          <ComposerSendButton aria-label="Send" disabled={!draft} />
        </ComposerCardToolbar>
      </ComposerCard>
    </div>
  );
}
