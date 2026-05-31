import { useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import styles from "./WorkActivityBlock.module.css";

export interface WorkActivityToolItem {
  id: string;
  icon?: ReactNode;
  title: ReactNode;
  details?: ReactNode;
  summaryLabel?: string;
}

export function WorkActivityToolGroup({
  tools,
}: {
  tools: WorkActivityToolItem[];
}) {
  const [expanded, setExpanded] = useState(false);
  if (tools.length === 0) return null;
  if (tools.length === 1) return <WorkActivityToolRow tool={tools[0]!} />;

  return (
    <div
      className={styles.toolRow}
      data-test-class="turn-work-tool-row turn-work-tool-group"
    >
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
        <div
          className={styles.toolDetailList}
          data-test-class="turn-activity-details turn-work-tool-detail-list"
        >
          {tools.map((tool) => (
            <WorkActivityToolDetailRow key={tool.id} tool={tool} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WorkActivityToolRow({ tool }: { tool: WorkActivityToolItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Boolean(tool.details);
  const content = <WorkActivityToolContent reserveIconSlot tool={tool} />;

  if (!hasDetails) {
    return (
      <div className={styles.toolRow} data-test-class="turn-work-tool-row">
        <div className={styles.tool}>{content}</div>
      </div>
    );
  }

  return (
    <div className={styles.toolRow} data-test-class="turn-work-tool-row">
      <button
        aria-expanded={expanded}
        className={styles.tool}
        type="button"
        onClick={() => setExpanded((value) => !value)}
      >
        {content}
      </button>
      {expanded ? <ToolDetails>{tool.details}</ToolDetails> : null}
    </div>
  );
}

function WorkActivityToolDetailRow({ tool }: { tool: WorkActivityToolItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Boolean(tool.details);
  const content = <WorkActivityToolContent tool={tool} />;

  return (
    <div
      className={styles.toolDetailRow}
      data-test-class="turn-work-tool-detail-row"
    >
      {hasDetails ? (
        <button
          aria-expanded={expanded}
          className={styles.toolDetailButton}
          type="button"
          onClick={() => setExpanded((value) => !value)}
        >
          {content}
          <span className={styles.toolDetailChevron} aria-hidden="true">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </button>
      ) : (
        <div className={styles.toolDetailButton}>{content}</div>
      )}
      {expanded ? <ToolDetails>{tool.details}</ToolDetails> : null}
    </div>
  );
}

function WorkActivityToolContent({
  reserveIconSlot = false,
  tool,
}: {
  reserveIconSlot?: boolean;
  tool: WorkActivityToolItem;
}) {
  return (
    <>
      {tool.icon || reserveIconSlot ? (
        <span className={styles.toolIcon} aria-hidden={!tool.icon}>
          {tool.icon}
        </span>
      ) : null}
      <span className={styles.toolCopy}>
        <Typo.Body as="span" className={styles.toolTitle}>
          {tool.title}
        </Typo.Body>
      </span>
    </>
  );
}

function ToolDetails({ children }: { children: ReactNode }) {
  return (
    <Typo.Caption
      className={`${styles.toolDetails} ${styles.toolDetailText}`}
      data-slot="work-activity-tool-details"
      data-test-class="turn-work-tool-detail-text"
    >
      {children}
    </Typo.Caption>
  );
}

function toolSummary(tools: WorkActivityToolItem[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const label = tool.summaryLabel?.trim() || "도구";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");
}
