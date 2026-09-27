import type { PlanDocumentRecord } from "@/app/types.ts";
import { ListChecks, Space, Stack, SurfacePanel, Tag, Typo } from "@/butler-ds";
import { ProjectDocumentMarkdownContent } from "@/components/management/ProjectDocumentMarkdownContent.tsx";

export function PlanDocumentMessage({ plan }: { plan: PlanDocumentRecord }) {
  return (
    <>
      <Space size="sm" />
      <SurfacePanel
        aria-label={`Plan: ${plan.title}`}
        data-test-class="plan-document-message"
        elevation="subtle"
        id={planDocumentElementId(plan.id)}
        role="region"
      >
        <Stack gap="md">
          <Stack as="header" align="row" cross="center" gap="sm">
            <ListChecks aria-hidden="true" size="md" />
            <Typo.Label as="span" grow minWidth="0" truncate>
              {plan.title}
            </Typo.Label>
            {plan.status ? <Tag>{plan.status}</Tag> : null}
          </Stack>
          <ProjectDocumentMarkdownContent markdown={plan.markdown} />
        </Stack>
      </SurfacePanel>
    </>
  );
}

export function planDocumentElementId(planId: string): string {
  return `plan-document-${encodeURIComponent(planId)}`;
}
