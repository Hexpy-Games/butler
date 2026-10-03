import { useEffect, useRef, useState } from "react";
import { ComposerCard } from "@/butler-ds";
import { ComposerInputSurface } from "./ComposerInputSurface";
import { useComposerStore } from "./composerStore";
import { installComposerReview, reviewAttachment } from "./composerReviewFixture";

/** The real app input surface and toolbar; only their data/actions are fixtures. */
export default function ComposerReviewStory({ locale, mode, question, attachments }: {
  locale: string; mode: string; question: boolean; attachments: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const [questionState, setQuestionState] = useState<"open" | "collapsed">("open");
  const submit = useComposerStore((state) => state.submit);
  useEffect(() => {
    const restore = installComposerReview(locale);
    useComposerStore.setState({ fileInputRef });
    setReady(true);
    return restore;
  }, [locale]);
  useEffect(() => {
    useComposerStore.getState().setText(mode === "typing" ? "Review the composer layout.\nKeep every existing control and menu.\nSend stays inside the input." : "");
    useComposerStore.setState({ activeTurn: mode === "streaming" });
  }, [mode]);
  useEffect(() => { useComposerStore.setState({ attachments: attachments ? [reviewAttachment] : [] }); }, [attachments]);
  useEffect(() => { setQuestionState("open"); }, [question]);
  if (!ready) return null;
  return <ComposerCard large onSubmit={submit}>
    <ComposerInputSurface fileInputRef={fileInputRef}
      onFiles={(files) => { if (files?.length) useComposerStore.setState({ attachments: [reviewAttachment] }); }}
      question={question ? { key: "review-question", panel: {
        questions: [{ id: "destination", header: "Destination", text: "Where should I save it?", type: "single",
          options: [{ label: "Project", recommended: true }, { label: "Local" }] }],
        state: questionState, onSubmit: () => setQuestionState("collapsed"), onSkip: () => setQuestionState("collapsed"),
        onCollapse: () => setQuestionState("collapsed"), onExpand: () => setQuestionState("open"),
      } } : undefined} />
  </ComposerCard>;
}
