import { Button } from "../../components/Button";
import { DashboardHeader } from "../DashboardHeader";
import { ManagementPage } from "./ManagementPage";

export function ManagementPageFixture() {
  return (
    <ManagementPage dataTestClass="management-page-fixture">
      <DashboardHeader
        title="Automations"
        meta="3 prompts scheduled"
        action={<Button variant="outline">New</Button>}
      />
    </ManagementPage>
  );
}
