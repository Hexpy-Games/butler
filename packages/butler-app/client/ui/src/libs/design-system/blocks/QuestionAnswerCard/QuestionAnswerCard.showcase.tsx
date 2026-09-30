import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { QuestionAnswerCard } from "./QuestionAnswerCard";
import { questionFixtures } from "../ComposerQuestionPanel/fixtures";
export const meta: ShowcaseMeta = { title: "QuestionAnswerCard", category: "Conversation & Activity", tags: ["answer", "summary", "user"], status: "beta" };
export const stories: ShowcaseStory[] = ["answered", "skipped", "message", "partial"].map((variant) => ({
  name: variant,
  render: ({ locale }) => {
    const ko = locale === "ko-KR";
    const questions = questionFixtures(ko).onboarding;
    return <QuestionAnswerCard questions={questions} variant={variant === "partial" ? "answered" : variant as "answered" | "skipped" | "message"}
      answers={questions.map((q, i) => ({ id: q.id, selected: q.type === "text" ? [] : [0], text: q.type === "text" ? (ko ? "민수" : "Alex") : "", other: "", skipped: variant === "partial" && i > 0 }))}
      message={ko ? "잠깐, 메일부터 정리해줘" : "Please sort my inbox first"}
      labels={ko ? { answered: "답변 완료", skipped: "건너뜀", message: "메시지로 답함" } : undefined} />;
  },
}));
