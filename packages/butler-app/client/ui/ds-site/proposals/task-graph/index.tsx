import { TaskGraphProposalPage } from "./Page";
import { TaskGraphStage } from "./Stage";

/** Proposal route: `?proposal=task-graph` (the page), `&stage=1` (the framed preview inside it). */
export default function TaskGraphProposal({ stage }: { stage: boolean }) {
  return stage ? <TaskGraphStage /> : <TaskGraphProposalPage />;
}
