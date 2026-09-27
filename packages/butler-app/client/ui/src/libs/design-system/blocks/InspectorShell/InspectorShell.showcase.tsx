import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Activity, FileText, History, ListFilter } from "../../components/Icons";
import { Section } from "../../components/Section";
import { InspectorPanel } from "../InspectorPanel";
import { KeyValueRow } from "../KeyValueRow";
import { ListRow } from "../ListRow";
import { InspectorInset, InspectorShell } from "./index";
import styles from "./InspectorShell.module.css";
import { dsClass } from "../../lib/internal";

export const meta: ShowcaseMeta = {
  title: "InspectorShell",
  category: "Inspector",
  tags: ["inspector", "tabs", "right-panel", "shell"],
  status: "stable",
};

const labels = {
  "en-US": {
    summary: "Summary", files: "Files", activity: "Activity", workers: "Workers", branch: "Branch details",
    gateway: "Gateway", ready: "Ready", artifacts: "Artifacts", automations: "Schedules", nightly: "Nightly release notes", every: "Every day 07:00",
  },
  "ko-KR": {
    summary: "요약", files: "파일", activity: "활동", workers: "작업자", branch: "브랜치 정보",
    gateway: "게이트웨이", ready: "준비됨", artifacts: "산출물", automations: "예약 작업", nightly: "야간 릴리스 노트", every: "매일 07:00",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** Inspector: tabbed right panel; each tab renders InspectorPanels or an inset Section. */
function InspectorDemo({ context }: { context: ShowcaseRenderContext }) {
  const [tab, setTab] = useState("summary");
  const copy = text(context);
  return (
    <InspectorShell
      activeTab={tab}
      className={dsClass(styles.fixture)}
      onTabChange={setTab}
      tabs={[
        { id: "summary", label: copy.summary, icon: <ListFilter size="md" /> },
        { id: "files", label: copy.files, icon: <FileText size="md" /> },
        { id: "activity", label: copy.activity, icon: <History size="md" /> },
        { id: "workers", label: copy.workers, icon: <Activity size="md" /> },
      ]}
    >
      {tab === "summary" ? (
        <InspectorPanel title={copy.branch}>
          <KeyValueRow label={copy.gateway} value={copy.ready} />
          <KeyValueRow label="Git" value="main" />
        </InspectorPanel>
      ) : (
        // AutomationTargetsPanel-style content aligns through InspectorInset.
        <InspectorInset>
          <Section title={tab === "files" ? copy.artifacts : copy.automations} gap="sm">
            <ListRow icon={<FileText size="md" />} title={copy.nightly} meta={copy.every} />
          </Section>
        </InspectorInset>
      )}
    </InspectorShell>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Tabbed inspector", states: ["selected"], widths: ["375", "430", "app"], render: (context) => <InspectorDemo context={context} /> },
];
