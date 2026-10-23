import { appCopy, useAppLocale } from "@/app/copy";
import { AlertCircle, Button, ButtonContainer, CheckCircle2, CopyButton, Globe2, Notice, ProviderLogo, RollingSwap, Spinner, Stack } from "@/butler-ds";
import type { ChatGptAccountView } from "@/app/setupSignIn";
import type { useSignIn } from "../first-run/useSignIn";
interface Props {
  signIn: ReturnType<typeof useSignIn>;
  account: ChatGptAccountView | null;
  firstRun?: boolean;
  editing?: boolean;
  onSignOut?: () => void;
}
/** The same explicit-action sign-in card in setup and model settings. */
export function ChatGptSignInCard({ signIn, account, firstRun = false, editing = false, onSignOut }: Props) {
  useAppLocale();
  const copy = appCopy.chatgptSignIn, plan = appCopy.chatgptPlan;
  const waiting = signIn.phase === "waiting" || signIn.phase === "starting";
  const failed = signIn.phase === "failed", timedout = signIn.phase === "timedout";
  const off = !waiting && !failed && !timedout && (account?.status === "plan_off" || signIn.view?.plan_enabled === false);
  const signed = !off && !waiting && !failed && !timedout && (account ? account.status === "signed_in" : signIn.view?.status === "completed" || signIn.view?.status === "profile_exists");
  const again = !signed && (off || editing || account?.status === "sign_in_required" || account?.status === "legacy_sign_in_required");
  const code = signIn.view?.error;
  const reason = code === "oauth_account_mismatch" ? appCopy.firstRun.signInAccountMismatch
    : code === "oauth_discovery_unavailable" ? appCopy.firstRun.signInDiscoveryOffline : copy.failed;
  const line = waiting ? copy.pending : timedout ? copy.timedOut : failed ? reason
    : off ? plan.planOff : signed ? [copy.complete, account?.label ?? signIn.account].filter(Boolean).join(" · ")
    : again ? plan.signInAgainHint : firstRun ? "" : copy.idle;
  const start = (kind: "default" | "new_account" = "default") => { void signIn.start({ kind }); };
  const icon = waiting ? <Spinner size={16} /> : signed ? <CheckCircle2 size="md" />
    : failed || timedout || again ? <AlertCircle size="md" /> : <ProviderLogo name="openai" />;
  const actions = <ButtonContainer size="sm" justify="end">
      {waiting ? <>
        {signIn.canCopyLink ? <CopyButton label={copy.copy} copiedLabel={copy.copied} copied={signIn.copied} onCopy={() => void signIn.copyLink()} /> : null}
        <Button size="sm" iconStart={<Globe2 size="sm" />} disabled={!signIn.canCopyLink} onClick={signIn.reopen}>{copy.open}</Button>
      </> : failed || timedout ? <Button size="sm" onClick={() => void signIn.start({ force: true })}>{copy.restart}</Button> : <>
        {signed || again ? <Button size="sm" variant="inline" onClick={() => start("new_account")}>{plan.otherAccount}</Button> : null}
        {signed ? editing ? <Button size="sm" variant="outline" onClick={onSignOut}>{plan.signOut}</Button> : null
          : <Button size="sm" onClick={() => off ? void signIn.start({ kind: "enable_plan" }) : start()}>{off ? plan.turnOn : plan.continue}</Button>}
      </>}
    </ButtonContainer>;
  return <Notice tone={failed ? "error" : "neutral"} icon={icon}
    message={line ? <Stack as="span" gap="sm"><RollingSwap itemKey={line}>{line}</RollingSwap>{actions}</Stack> : ""}
    action={!line ? actions : undefined} />;
}
