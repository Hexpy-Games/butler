import { LifecycleWindowsProposalPage } from "./Page";
import { LifecycleStage } from "./Stage";

/**
 * Proposal route: `?proposal=lifecycle-windows` (the review page); `&stage=startup|quit` renders one
 * window alone at 100vw × 100vh (the framed preview, and the real Electron window in electron-preview.mjs).
 */
export default function LifecycleWindowsProposal({ stage }: { stage: string | null }) {
  if (stage === "startup" || stage === "quit") return <LifecycleStage kind={stage} />;
  return <LifecycleWindowsProposalPage />;
}
