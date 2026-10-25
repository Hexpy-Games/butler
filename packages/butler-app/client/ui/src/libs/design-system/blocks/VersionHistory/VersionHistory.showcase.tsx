import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { VersionHistory } from "./VersionHistory";

export const meta: ShowcaseMeta = {
  title: "VersionHistory",
  category: "Documents & Artifacts",
  tags: ["document", "versions", "history", "restore"],
  status: "beta",
};

const labels = {
  "en-US": { me: "Me", butler: "Butler", current: "Current", list: "Versions", restore: "Restore", times: ["3:12 PM", "3:05 PM", "2:41 PM", "Yesterday"] },
  "ko-KR": { me: "나", butler: "버틀러", current: "현재", list: "버전 기록", restore: "되돌리기", times: ["오후 3:12", "오후 3:05", "오후 2:41", "어제"] },
} as const;

function History({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  const authors = ["butler", "user", "butler", "user"] as const;
  const [selected, setSelected] = useState("4");
  const entries = authors.map((author, index) => ({ id: String(4 - index), author, authorLabel: author === "butler" ? copy.butler : copy.me, time: copy.times[index]! }));
  return <VersionHistory entries={entries} selectedId={selected} onSelect={setSelected} label={copy.list} currentLabel={copy.current}
    action={selected === "4" ? undefined : <Button size="sm" variant="secondary">{copy.restore}</Button>} />;
}

export const stories: ShowcaseStory[] = [
  { name: "Versions by me and Butler", states: ["hover", "focus-visible"], widths: ["375", "app"], render: (context) => <History context={context} /> },
];
