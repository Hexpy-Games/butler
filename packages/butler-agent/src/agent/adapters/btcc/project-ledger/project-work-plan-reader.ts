import { join } from "node:path";
import type { DurableWorkView } from "../../../btcc/work/index.ts";
import { loadProjectLedgerCore } from "./project-ledger-core.ts";
import { decodeManifest } from "./project-work-codec.ts";
import { decodeChild } from "./project-work-child-codec.ts";
import { childPath, workPath } from "./project-work-json.ts";

// App snapshots are synchronous. Load the existing Ledger reader once during
// module initialization; snapshot reads never initialize or mutate a project.
const core = await loadProjectLedgerCore();

export function readProjectWorkPlan(input: {
  butlerData: string;
  appProjectId: string;
  ledgerProjectId: string;
  workId: string;
}): Pick<DurableWorkView, "currentPlan" | "actionProgress" | "latestPlanReview"> | null {
  const scope = {
    appProjectId: input.appProjectId,
    ledgerProjectId: input.ledgerProjectId,
    ledgerRoot: join(input.butlerData, "project-ledger", "projects", input.ledgerProjectId),
  };
  const body = readBody(workPath(input.ledgerProjectId, input.workId));
  if (body === null) return null;
  const manifest = decodeManifest(body, { workId: input.workId, scope });
  if (!manifest.currentPlanRevisionId) return null;
  const planBody = readBody(childPath(input.ledgerProjectId, "plan", manifest.currentPlanRevisionId));
  if (planBody === null) return null;
  const { plan } = decodeChild(planBody, {
    schema: "butler.btcc-project-work-plan.v1",
    workId: input.workId,
    recordId: manifest.currentPlanRevisionId,
  });
  const reviewBody = manifest.latestPlanReviewRevisionId
    ? readBody(childPath(input.ledgerProjectId, "reference", manifest.latestPlanReviewRevisionId))
    : null;
  const review = reviewBody !== null && manifest.latestPlanReviewRevisionId
    ? decodeChild(reviewBody, {
        schema: "butler.btcc-project-work-review.v1",
        workId: input.workId,
        recordId: manifest.latestPlanReviewRevisionId,
      }).review
    : undefined;
  return {
    currentPlan: plan,
    actionProgress: manifest.actionProgress,
    latestPlanReview: review,
  };

  function readBody(path: string): string | null {
    const relativePath = path.slice(`project-ledger/projects/${input.ledgerProjectId}/`.length);
    const record = core.readCommittedProjectLedgerRecords(scope.ledgerRoot, [relativePath])[0];
    return record?.raw == null ? null : core.frontmatterBody(record.raw);
  }
}
