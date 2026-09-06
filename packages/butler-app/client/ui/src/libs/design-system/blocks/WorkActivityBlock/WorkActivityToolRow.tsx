import { useState } from "react";
import { ChevronDown, ChevronRight } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import type { WorkActivityToolItem } from "./WorkActivityToolGroup";
import styles from "./WorkActivityBlock.module.css";

export function WorkActivityToolRow({ tool, nested = false }: { tool: WorkActivityToolItem; nested?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Boolean(tool.details);
  const content = (
    <>
      {tool.icon || !nested ? (
        <span className={styles.toolIcon} aria-hidden={!tool.icon}>{tool.icon}</span>
      ) : null}
      <span className={styles.toolCopy}>
        <Typo.Body as="span" className={styles.toolTitle}>{tool.title}</Typo.Body>
      </span>
      {nested && hasDetails ? (
        <span className={styles.toolDetailChevron} aria-hidden="true">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      ) : null}
    </>
  );
  const className = nested ? styles.toolDetailButton : styles.tool;
  return (
    <div
      className={nested ? styles.toolDetailRow : styles.toolRow}
      data-test-class={nested ? "turn-work-tool-detail-row" : "turn-work-tool-row"}
    >
      <Stack gap="xs">
        {hasDetails ? (
          <button aria-expanded={expanded} className={className} type="button" onClick={() => setExpanded((value) => !value)}>
            {content}
          </button>
        ) : <div className={className}>{content}</div>}
        {tool.after}
        {expanded ? (
          <Typo.Caption
            className={`${styles.toolDetails} ${styles.toolDetailText}`}
            data-slot="work-activity-tool-details"
            data-test-class="turn-work-tool-detail-text"
          >
            {tool.details}
          </Typo.Caption>
        ) : null}
      </Stack>
    </div>
  );
}
