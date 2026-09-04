import type { PlanDocumentRecord } from "@/app/types.ts";
import { ListChecks, SurfacePanel, Tag, Typo } from "@/butler-ds";
import { ProjectDocumentMarkdownContent } from "@/components/management/ProjectDocumentMarkdownContent.tsx";
import styles from "./PlanDocumentMessage.module.css";

export function PlanDocumentMessage({ plan }: { plan: PlanDocumentRecord }) {
  return (
    <SurfacePanel
      aria-label={`Plan: ${plan.title}`}
      className={styles.plan}
      data-test-class="plan-document-message"
      elevation="none"
      role="region"
    >
      <header className={styles.header}>
        <ListChecks aria-hidden="true" size={16} />
        <Typo.Label as="span" className={styles.title}>
          {plan.title}
        </Typo.Label>
        {plan.status ? <Tag>{plan.status}</Tag> : null}
      </header>
      <ProjectDocumentMarkdownContent markdown={plan.markdown} />
    </SurfacePanel>
  );
}
