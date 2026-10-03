import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { NativeSelect } from "../../components/NativeSelect";
import { Switch } from "../../components/Switch";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ComposerQuestionPanel } from "../ComposerQuestionPanel";
import { questionFixtures } from "../ComposerQuestionPanel/fixtures";
import { ComposerCard, ComposerCardExpandedBody, ComposerCardCompactPreview, ComposerCardTextarea } from "./index";
import { ComposerPreviewControls } from "./ComposerPreviewControls";
import styles from "./ComposerPreview.module.css";

type PreviewState = "idle" | "typing" | "streaming" | "question" | "attachments";

/** Offline interaction review: native textarea retains its identity through every switch. */
export function ComposerPreview() {
  const [state, setState] = useState<PreviewState>("idle");
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState("");
  const [attached, setAttached] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [dark, setDark] = useState(false);
  const [photo, setPhoto] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [streamText, setStreamText] = useState("");
  useEffect(() => {
    if (state !== "streaming") return;
    const words = ["I", "am", "reviewing", "your", "message.", "Press", "Stop", "to", "cancel."];
    let index = 0;
    setStreamText("");
    const timer = window.setInterval(() => {
      setStreamText(words.slice(0, ++index).join(" "));
      if (index === words.length) window.clearInterval(timer);
    }, 200);
    return () => window.clearInterval(timer);
  }, [state]);
  const editor = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const choose = (value: PreviewState) => {
    setState(value);
    setExpanded(value !== "idle" && value !== "question");
    if (value === "typing") setDraft("한글로 작성해 보세요.\nTry a second line.");
    setAttached(value === "attachments");
  };
  const send = () => {
    if (composing.current || state === "question" || !draft.trim()) return;
    setSent(draft); setDraft(""); setState("streaming");
  };
  return <Stack gap="md">
    <Stack align="row" wrap gap="sm" cross="center">
      <NativeSelect aria-label="Preview state" value={state} onChange={event => choose(event.target.value as PreviewState)}>
        {(["idle", "typing", "streaming", "question", "attachments"] as const).map(value => <option key={value}>{value}</option>)}
      </NativeSelect>
      <Switch aria-label="Narrow 375" checked={narrow} onCheckedChange={setNarrow} /><Typo.Caption>375</Typo.Caption>
      <Switch aria-label="Dark theme" checked={dark} onCheckedChange={setDark} /><Typo.Caption>Dark</Typo.Caption>
      <Switch aria-label="Photo wallpaper" checked={photo} onCheckedChange={setPhoto} /><Typo.Caption>Photo</Typo.Caption>
      <Switch aria-label="Reduce motion" checked={reduced} onCheckedChange={setReduced} /><Typo.Caption>Reduce motion</Typo.Caption>
    </Stack>
    <div className={`${styles.frame} theme-${dark ? "dark" : "light"}`} data-slot="composer-preview-frame"
      data-narrow={narrow} data-photo={photo} data-motion={reduced ? "reduced" : "full"}>
      <div className={styles.result} role="status"><Typo.Body>{sent || "Type, open menus, send and stop."}</Typo.Body>
        {state === "streaming" ? <Typo.Caption>{streamText || "Simulated stream…"}</Typo.Caption> : null}</div>
      <ComposerCard expanded={expanded} onSubmit={event => { event.preventDefault(); send(); }}
        panel={state === "question" ? <ComposerQuestionPanel questions={questionFixtures(false).single} state="open"
          onSubmit={() => setState("typing")} onSkip={() => setState("typing")} onCollapse={() => setState("typing")} /> : undefined}
        controls={<ComposerPreviewControls dark={dark} streaming={state === "streaming"} canSend={Boolean(draft.trim())} blocked={state === "question"}
          onStop={() => setState("typing")} onAttach={() => { setAttached(true); setExpanded(true); }} />}>
        <ComposerCardExpandedBody inactive={state === "question"}>
          <ComposerCardTextarea ref={editor} aria-label="Message" placeholder="Ask Butler anything" value={draft} rows={Math.min(8, draft.split("\n").length)}
            onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); send(); } }} />
          {attached ? <Button size="sm" variant="borderless" onClick={() => setAttached(false)}>Remove notes.txt</Button> : null}
        </ComposerCardExpandedBody>
        <ComposerCardCompactPreview onClick={() => { if (state === "question") setState("typing"); setExpanded(true); requestAnimationFrame(() => editor.current?.focus()); }}>{draft || "Ask Butler anything"}</ComposerCardCompactPreview>
      </ComposerCard>
    </div>
  </Stack>;
}
