import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { Download, History, MessageSquare, X } from "../../components/Icons";
import { Inline } from "../../components/Inline";
import { Typo } from "../../components/Typo";
import { BlockActionFrame } from "../BlockActionFrame";
import { MetricCard } from "../MetricCard";
import { MetricGrid } from "../MetricGrid";
import { DocumentBlockEmbed, DocumentEditor, documentEditorClasses } from "./DocumentEditor";

export const meta: ShowcaseMeta = {
  title: "DocumentEditor",
  category: "Documents & Artifacts",
  tags: ["document", "editor", "markdown", "butler editing", "motion"],
  status: "beta",
};

const labels = {
  "en-US": { title: "October budget", saved: "Saved", editing: "Butler is editing", versions: "Versions", export: "Export", close: "Close", chat: "Original chat", markdown: "Export as Markdown", pdf: "Export as PDF", more: "More", heading: "Summary",
    first: "Spending rose 8% this month, mostly from the trip.", second: "Fixed costs stayed flat; rent is due on the 25th.", spend: "Spending", income: "Income", replay: "Replay" },
  "ko-KR": { title: "10월 예산", saved: "저장됨", editing: "버틀러가 수정 중", versions: "버전 기록", export: "내보내기", close: "닫기", chat: "원래 대화", markdown: "Markdown으로 내보내기", pdf: "PDF로 내보내기", more: "더보기", heading: "요약",
    first: "이번 달 지출은 여행 때문에 8% 늘었어요.", second: "고정비는 그대로이고, 월세는 25일에 나가요.", spend: "지출", income: "수입", replay: "다시 재생" },
} as const;

function Page({ context, editing }: { context: ShowcaseRenderContext; editing: boolean }) {
  const copy = labels[context.locale];
  return (
    <DocumentEditor
      title={<Typo.H2>{copy.title}</Typo.H2>}
      note={editing ? copy.editing : copy.saved}
      actions={<Inline><IconButton label={copy.versions}><History size="sm" /></IconButton><IconButton label={copy.export}><Download size="sm" /></IconButton></Inline>}>
      <div className={documentEditorClasses.root} contentEditable suppressContentEditableWarning>
        <h2>{copy.heading}</h2>
        <p data-butler-editing={editing ? "true" : "false"}>{copy.first}</p>
        <DocumentBlockEmbed>
          <BlockActionFrame><MetricGrid><MetricCard label={copy.spend} value="₩1,240,000" change="+8%" trend="down" /><MetricCard label={copy.income} value="₩3,100,000" /></MetricGrid></BlockActionFrame>
        </DocumentBlockEmbed>
        <p>{copy.second}</p>
      </div>
    </DocumentEditor>
  );
}

/** The product's title line: a panel title centred with the actions; the status line under it. On a narrow
 * line (the 375 frame) the document actions fold into ⋯ and close stays; the app frame keeps them inline. */
function TitleLine({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  return (
    <DocumentEditor
      title={<Typo.PanelTitle as="h2" truncate>{copy.title}</Typo.PanelTitle>}
      note={copy.saved}
      actions={<Inline gap="xs" wrap={false}><IconButton label={copy.versions}><History size="sm" /></IconButton><IconButton label={copy.chat}><MessageSquare size="sm" /></IconButton><IconButton label={copy.export}><Download size="sm" /></IconButton></Inline>}
      menuActions={[
        { icon: <History size="sm" />, label: copy.versions, onSelect: () => {} },
        { icon: <MessageSquare size="sm" />, label: copy.chat, onSelect: () => {} },
        { icon: <Download size="sm" />, label: copy.markdown, onSelect: () => {} },
        { icon: <Download size="sm" />, label: copy.pdf, onSelect: () => {} },
      ]}
      menuLabel={copy.more}
      controls={<IconButton label={copy.close}><X size="sm" /></IconButton>}>
      <div className={documentEditorClasses.root} contentEditable suppressContentEditableWarning>
        <p>{copy.first}</p>
      </div>
    </DocumentEditor>
  );
}

function Editing({ context }: { context: ShowcaseRenderContext }) {
  const [editing, setEditing] = useState(true);
  return (
    <>
      <Page context={context} editing={editing} />
      <Inline><Button size="sm" variant="outline" data-ds-motion="replay" onClick={() => setEditing((value) => !value)}>{labels[context.locale].replay}</Button></Inline>
    </>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Document", widths: ["375", "app"], render: (context) => <Page context={context} editing={false} /> },
  { name: "Title line", widths: ["375", "app"], render: (context) => <TitleLine context={context} /> },
  { name: "Butler editing a paragraph", states: ["changing"], widths: ["375", "app"], render: (context) => <Editing context={context} /> },
];
