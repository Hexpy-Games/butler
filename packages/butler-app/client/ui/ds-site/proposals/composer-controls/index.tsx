import { ComposerControlsProposalPage } from "./Page";
import { ComposerControlsStage } from "./Stage";

/** Proposal route: `?proposal=composer-controls` (the page), `&stage=1` (the framed preview inside it). */
export default function ComposerControlsProposal({ stage }: { stage: boolean }) {
  return stage ? <ComposerControlsStage /> : <ComposerControlsProposalPage />;
}
