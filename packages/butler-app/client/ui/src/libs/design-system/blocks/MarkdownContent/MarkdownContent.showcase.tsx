import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { CopyButton } from "../../components/CopyButton";
import { Stack } from "../../components/Stack";
import { MessageFooter } from "../MessageRow";
import { MarkdownCodeFrame, MarkdownContent, MarkdownTable, useStreamingReveal } from "./index";
import { MarkdownImageSample } from "./MarkdownImageSample";
import { MarkdownLinkSample } from "./MarkdownLinkSample";

export const meta: ShowcaseMeta = {
  title: "MarkdownContent",
  category: "Documents & Artifacts",
  tags: ["markdown", "document", "code", "table", "streaming", "motion"],
  status: "stable",
};

const labels = {
  "en-US": {
    h1: "Project spec", intro: "Markdown keeps document rhythm inside the design system. Inline", and: "and", links: "links", stay: "stay in the text flow.",
    h2: "Implementation", sub: "Subsections keep a smaller, consistent section gap.", items: ["Readable list spacing", "Clear item separation"],
    nested: "Nested items keep the same rhythm", steps: ["Plan the change", "Verify it"], quote: "Quoted notes use a quiet rule and secondary text.",
    matrix: "Verification matrix", head: ["Check", "Command", "Result"], rows: [["Types", "bun run typecheck", "Passed"], ["Design lint", "bun run lint:design", "Passed"]],
    copy: "Copy code", copied: "Copied", replay: "Replay stream",
    imageIntro: "An image smaller than the column keeps its natural size.", imageAlt: "Settings screen at 375px",
    stream: "Streaming text **fades in per chunk**: each appended chunk keeps its own span, so nothing moves while the answer grows. Settled messages render plain markdown.",
  },
  "ko-KR": {
    h1: "프로젝트 명세", intro: "마크다운은 디자인 시스템 안에서 문서 리듬을 지킵니다. 인라인", and: "과", links: "링크", stay: "는 문장 흐름 안에 있습니다.",
    h2: "구현", sub: "하위 절은 더 작고 일정한 간격을 씁니다.", items: ["읽기 쉬운 목록 간격", "분명한 항목 구분"],
    nested: "중첩 항목도 같은 리듬을 따릅니다", steps: ["변경 계획하기", "검증하기"], quote: "인용은 조용한 선과 보조 텍스트를 씁니다.",
    matrix: "검증 표", head: ["점검", "명령", "결과"], rows: [["타입", "bun run typecheck", "통과"], ["디자인 린트", "bun run lint:design", "통과"]],
    copy: "코드 복사", copied: "복사됨", replay: "스트림 다시 재생",
    imageIntro: "본문 폭보다 작은 이미지는 원래 크기로 보입니다.", imageAlt: "375px 설정 화면",
    stream: "스트리밍 텍스트는 **조각마다 서서히 나타납니다**. 새 조각마다 자기 span을 유지하므로 답이 길어져도 아무것도 움직이지 않습니다. 끝난 메시지는 일반 마크다운으로 그립니다.",
  },
} as const;

const INLINE_IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='400' viewBox='0 0 640 400'%3E%3Crect width='640' height='400' fill='%23e9eaec'/%3E%3Cpath d='m80 320 150-160 110 100 80-90 140 150H80Z' fill='%2371767d'/%3E%3C/svg%3E";

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** Pre-highlighted sample: product code blocks get these `data-syntax` spans from lowlight. */
function CodeSample({ context }: { context: ShowcaseRenderContext }) {
  return (
    <MarkdownCodeFrame language="ts" actions={<MessageFooter><CopyButton text="check" label={text(context).copy} copiedLabel={text(context).copied} /></MessageFooter>}>
      <code className="language-ts">
        <span data-syntax="keyword">import</span>{" { check } "}<span data-syntax="keyword">from</span>{" "}
        <span data-syntax="string">"project-ledger"</span>;{"\n\n"}
        <span data-syntax="comment">{"// Fails when a spec drifts from its plan."}</span>{"\n"}
        <span data-syntax="keyword">const</span> <span data-syntax="variable">result</span>{" = "}<span data-syntax="keyword">await</span>{" "}
        <span data-syntax="title">check</span>({"{ "}<span data-syntax="variable">strict</span>: <span data-syntax="number">true</span>{" });"}
      </code>
    </MarkdownCodeFrame>
  );
}

/** MessageMarkdown while streaming: chunks arrive every 90ms and fade in place. */
function StreamingDemo({ context }: { context: ShowcaseRenderContext }) {
  const source = text(context).stream;
  const [length, setLength] = useState(0);
  const [run, setRun] = useState(0);
  useEffect(() => {
    setLength(0);
    const timer = window.setInterval(() => setLength((value) => {
      if (value >= source.length) window.clearInterval(timer);
      return Math.min(source.length, value + 14);
    }), 90);
    return () => window.clearInterval(timer);
  }, [run, source]);
  const shown = source.slice(0, length);
  const rehypePlugins = useStreamingReveal(shown, length < source.length);
  return (
    <Stack gap="sm">
      <MarkdownContent><ReactMarkdown rehypePlugins={rehypePlugins}>{shown}</ReactMarkdown></MarkdownContent>
      <Button size="sm" variant="outline" data-ds-motion="stream-replay" text={text(context).replay} onClick={() => setRun((value) => value + 1)} />
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Document",
    widths: ["375", "app", "wide"],
    render: (context) => {
      const copy = text(context);
      return (
        <MarkdownContent>
          <h1>{copy.h1}</h1>
          <p>{copy.intro} <code>project-ledger check</code> {copy.and} <a href="#spec">{copy.links}</a>{copy.stay}</p>
          <h2>{copy.h2}</h2>
          <p>{copy.sub}</p>
          <ul><li>{copy.items[0]}</li><li>{copy.items[1]}<ul><li>{copy.nested}</li></ul></li></ul>
          <ol><li>{copy.steps[0]}</li><li>{copy.steps[1]}</li></ol>
          <blockquote><p>{copy.quote}</p></blockquote>
        </MarkdownContent>
      );
    },
  },
  { name: "Links in a reply", widths: ["375", "app"], render: (context) => <MarkdownLinkSample {...context} /> },
  { name: "Code frame with copy", render: (context) => <MarkdownContent><CodeSample context={context} /></MarkdownContent> },
  {
    name: "Table",
    widths: ["320", "375", "app"],
    render: (context) => (
      <MarkdownContent>
        <h3>{text(context).matrix}</h3>
        <MarkdownTable>
          <thead><tr>{text(context).head.map((cell) => <th key={cell}>{cell}</th>)}</tr></thead>
          <tbody>{text(context).rows.map((row) => <tr key={row[0]}><td>{row[0]}</td><td><code>{row[1]}</code></td><td>{row[2]}</td></tr>)}</tbody>
        </MarkdownTable>
      </MarkdownContent>
    ),
  },
  {
    // Images never upscale: one smaller than the column keeps its natural size.
    name: "Inline image",
    widths: ["375", "app"],
    render: (context) => (
      <MarkdownContent>
        <p>{text(context).imageIntro}</p>
        <p><img alt={text(context).imageAlt} src={INLINE_IMAGE} /></p>
      </MarkdownContent>
    ),
  },
  // MessageInlineImage: captures fill the column up to a bounded height; Open and Save sit under them.
  { name: "Reply captures", widths: ["375", "430", "app", "wide"], render: (context) => <MarkdownImageSample {...context} /> },
  { name: "Streaming reveal", states: ["streaming"], render: (context) => <StreamingDemo context={context} /> },
];
