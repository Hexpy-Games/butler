import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Card } from "../../components/Card";
import { FileText } from "../../components/Icons";
import { ResourceSummary } from "./ResourceSummary";

export const meta: ShowcaseMeta = {
  title: "ResourceSummary",
  category: "Dashboard & Metrics",
  tags: ["resource", "summary", "card", "document"],
  status: "beta",
};

const labels = {
  "en-US": { title: "Design-system spec", description: "Tokens, components, blocks and the DS Viewer contract.", meta: "Updated today" },
  "ko-KR": { title: "디자인 시스템 명세", description: "토큰, 컴포넌트, 블록, DS Viewer 계약.", meta: "오늘 수정" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Document summary",
    render: (context) => (
      <ResourceSummary icon={<FileText size="xl" />} title={text(context).title} description={text(context).description} meta={text(context).meta} />
    ),
  },
  {
    name: "Inside a card",
    widths: ["320", "375", "app"],
    render: (context) => (
      <Card><ResourceSummary icon={<FileText size="xl" />} title={text(context).title} meta={text(context).meta} /></Card>
    ),
  },
];
