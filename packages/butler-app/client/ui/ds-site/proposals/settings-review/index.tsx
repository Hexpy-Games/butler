import { SettingsReviewPage } from "./Page";
import { SettingsReviewStage } from "./Stage";

/** Proposal route: `?proposal=settings-review` (the page), `&stage=1` (the framed Settings inside it). */
export default function SettingsReviewProposal({ stage }: { stage: boolean }) {
  return stage ? <SettingsReviewStage /> : <SettingsReviewPage />;
}
