import { FileText } from "../../components/Icons";
import { ResourceSummary } from "./ResourceSummary";

export function ResourceSummaryFixture() {
  return (
    <ResourceSummary
      icon={<FileText size={24} />}
      title="Project Ledger document"
      description="Reusable summary content for resource cards."
      meta="Updated today"
    />
  );
}
