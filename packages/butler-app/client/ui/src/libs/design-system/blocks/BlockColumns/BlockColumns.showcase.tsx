import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { KeyValueRow } from "../KeyValueRow";
import { MetricCard } from "../MetricCard";
import { Notice } from "../Notice";
import { Stack } from "../../components/Stack";
import { BlockColumns } from "./BlockColumns";

export const meta: ShowcaseMeta = {
  title: "BlockColumns",
  category: "Conversation & Activity",
  tags: ["answer block", "columns", "container", "layout"],
  status: "stable",
};

const labels = {
  "en-US": { spend: "Spending", income: "Income", note: "Rent is due on the 25th.", plan: "Plan", planValue: "Family", seats: "Seats", seatsValue: "4 of 6" },
  "ko-KR": { spend: "지출", income: "수입", note: "월세는 25일에 나가요.", plan: "요금제", planValue: "가족", seats: "좌석", seatsValue: "6개 중 4개" },
} as const;

function Two({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  return (
    <BlockColumns>
      <MetricCard label={copy.spend} value="₩1,240,000" change="+8%" trend="down" />
      <MetricCard label={copy.income} value="₩3,100,000" change="+2%" trend="up" />
    </BlockColumns>
  );
}

function Three({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  return (
    <BlockColumns>
      <MetricCard label={copy.spend} value="₩1,240,000" />
      <Stack gap="xs"><KeyValueRow label={copy.plan} value={copy.planValue} /><KeyValueRow label={copy.seats} value={copy.seatsValue} /></Stack>
      <Notice tone="info" message={copy.note} />
    </BlockColumns>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Two columns", widths: ["375", "app", "wide"], render: (context) => <Two context={context} /> },
  { name: "Three columns", widths: ["375", "app", "wide"], render: (context) => <Three context={context} /> },
];
