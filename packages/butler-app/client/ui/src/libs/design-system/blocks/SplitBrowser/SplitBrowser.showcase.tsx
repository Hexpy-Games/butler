import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { FileText } from "../../components/Icons";
import { DocumentTile } from "../DocumentTile";
import { NavRow } from "../NavRow";
import { SplitBrowser } from "./SplitBrowser";

export const meta: ShowcaseMeta = {
  title: "SplitBrowser",
  category: "Documents & Artifacts",
  tags: ["browser", "categories", "master-detail", "specs"],
  status: "beta",
};

const labels = {
  "en-US": { open: "Open", categories: { Design: ["Design system", "Tokens"], Runtime: ["Turn streaming", "Tool runtime", "Worker activity"] } },
  "ko-KR": { open: "열기", categories: { 디자인: ["디자인 시스템", "토큰"], 런타임: ["턴 스트리밍", "도구 런타임", "작업자 활동"] } },
} as const;

function Specs({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  const entries = Object.entries(copy.categories) as Array<[string, readonly string[]]>;
  const [active, setActive] = useState(entries[0]![0]);
  const specs = entries.find(([category]) => category === active)?.[1] ?? [];
  return (
    <SplitBrowser nav={entries.map(([category, items]) => (
      <NavRow key={category} label={category} badge={items.length} active={category === active} onClick={() => setActive(category)} />
    ))}>
      {specs.map((spec) => <DocumentTile key={spec} icon={<FileText size="md" />} title={spec} meta="specs/" actionLabel={copy.open} onOpen={() => undefined} />)}
    </SplitBrowser>
  );
}

export const stories: ShowcaseStory[] = [{ name: "Spec categories", widths: ["app", "wide"], render: (context) => <Specs context={context} /> }];
