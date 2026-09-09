import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { WorkActivityToolRow } from "./WorkActivityToolRow";
import styles from "./WorkActivityBlock.module.css";

export interface WorkActivityToolItem {
  id: string;
  icon?: ReactNode;
  title: ReactNode;
  details?: ReactNode;
  summaryLabel?: string;
  /** Always-visible footer below the containing disclosure and its expanded list. */
  after?: ReactNode;
}

export function WorkActivityToolGroup({ tools }: { tools: WorkActivityToolItem[] }) {
  const [expanded, setExpanded] = useState(false);
  if (tools.length === 1 && !tools[0]!.after) return <WorkActivityToolRow tool={tools[0]!} />;
  return (
    <Stack gap="xs" className={styles.toolRow} data-test-class="turn-work-tool-row turn-work-tool-group">
      <button
        aria-expanded={expanded}
        className={styles.toolGroup}
        type="button"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={styles.toolGroupSummary}>{toolSummary(tools)}</span>
        <span className={styles.toolGroupChevron} aria-hidden="true">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {expanded ? (
        <div className={styles.toolDetailList} data-test-class="turn-activity-details turn-work-tool-detail-list">
          {tools.map((tool) => <WorkActivityToolRow key={tool.id} tool={tool} nested />)}
        </div>
      ) : null}
      {tools.filter((tool) => tool.after).map((tool) => (
        <div key={tool.id} className={styles.toolAttachment}>{tool.after}</div>
      ))}
    </Stack>
  );
}

function toolSummary(tools: WorkActivityToolItem[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const label = tool.summaryLabel?.trim() || "도구";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${count} ${label}`).join(", ");
}
