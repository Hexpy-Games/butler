import { appCopy } from "@/app/copy";
import { Button, ButtonContainer, Notice, SetupWizardStepAction, Tooltip } from "@/butler-ds";
import { ChatGptSignInCard } from "../chatgpt/ChatGptSignInCard";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";
export function FirstRunSignIn({ flow }: { flow: FirstRunFlow }) {
  const { copy, signIn, chatgpt, commit } = flow;
  const active = signIn.phase === "starting" || signIn.phase === "waiting";
  const failed = signIn.phase === "failed" || signIn.phase === "timedout";
  const signed = !active && !failed && ( chatgpt.account?.status === "signed_in" || signIn.view?.status === "completed" && signIn.view.plan_enabled !== false || signIn.view?.status === "profile_exists");
  const off = !active && !failed && (chatgpt.account?.status === "plan_off" || signIn.view?.plan_enabled === false);
  const next = () => { if (commit.connected) flow.toReply(); else flow.connectChatGpt(); };
  return <FirstRunStepCard flow={flow} onBack={flow.backToList} contentKey={`signin:${off ? "off" : signed ? "signed" : signIn.phase}`}
    title={off ? copy.signInPlanOff : signed ? copy.readyTitle("ChatGPT") : copy.signInTitle("ChatGPT")}
    description={off ? copy.signInPlanOffBody : signed ? undefined : copy.signInBody}
    actions={<>
      {signIn.phase === "waiting" ? <SetupWizardStepAction onClick={() => void signIn.cancel()}>{copy.cancel}</SetupWizardStepAction> : null}
      <Tooltip label={!signed || off ? copy.connectFirst : ""}><SetupWizardStepAction forward disabled={!signed || off || commit.committing} onClick={next}>{copy.next}</SetupWizardStepAction></Tooltip>
    </>}>
    {off ? <ButtonContainer size="sm" justify="end"><Button size="sm" onClick={() => void signIn.start({ kind: "enable_plan" })}>{appCopy.chatgptPlan.turnOn}</Button></ButtonContainer>
      : <ChatGptSignInCard signIn={signIn} account={chatgpt.account} firstRun />}
    {commit.failed ? <Notice tone="error" message={copy.finishFailed} action={<Button size="sm" onClick={commit.retry}>{copy.retry}</Button>} /> : null}
  </FirstRunStepCard>;
}
