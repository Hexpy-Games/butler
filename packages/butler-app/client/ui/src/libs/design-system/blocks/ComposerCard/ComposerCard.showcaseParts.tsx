import { lazy, Suspense, useState } from "react";
import { NativeSelect, NativeSelectOption } from "../../components/NativeSelect";
import { Stack } from "../../components/Stack";
import { Switch } from "../../components/Switch";
import { Typo } from "../../components/Typo";
import type { ShowcaseRenderContext } from "../../showcase";
import styles from "./ComposerCard.showcase.module.css";

// Story-only adapter. Production DS blocks never import product stores or menus.
const ProductComposer = lazy(() => import("@/components/conversation/ComposerReviewStory"));

export function ComposerReview({ locale }: ShowcaseRenderContext) {
  const [mode, setMode] = useState("idle");
  const [question, setQuestion] = useState(false);
  const [attachments, setAttachments] = useState(false);
  const [photo, setPhoto] = useState(true);
  return <Stack gap="md" data-composer-review>
    <Stack align="row" gap="sm" wrap cross="center">
      <NativeSelect aria-label="Composer state" size="sm" value={mode} onChange={(event) => setMode(event.currentTarget.value)}>
        <NativeSelectOption value="idle">Idle</NativeSelectOption>
        <NativeSelectOption value="typing">Multi-line typing</NativeSelectOption>
        <NativeSelectOption value="streaming">Streaming</NativeSelectOption>
      </NativeSelect>
      <label><Typo.Caption>Question panel</Typo.Caption><Switch aria-label="Question panel" checked={question} onCheckedChange={(value) => setQuestion(value === true)} /></label>
      <label><Typo.Caption>Attachments</Typo.Caption><Switch aria-label="Attachments" checked={attachments} onCheckedChange={(value) => setAttachments(value === true)} /></label>
      <label><Typo.Caption>Photo wallpaper</Typo.Caption><Switch aria-label="Photo wallpaper" checked={photo} onCheckedChange={(value) => setPhoto(value === true)} /></label>
    </Stack>
    <div className={styles.stage} data-photo={photo}>
      <Suspense><ProductComposer locale={locale} mode={mode} question={question} attachments={attachments} /></Suspense>
    </div>
  </Stack>;
}
