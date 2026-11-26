import { ButlerAccountSignInDialog } from "./ButlerAccountSignInDialog";
import { useButlerAccount } from "./hooks/useButlerAccount";

export function ButlerAccountSignInStep({ onCancel, onSignedIn }: { onCancel: () => void; onSignedIn: () => void }) {
  const account = useButlerAccount();
  const verify: typeof account.verify = async (email, code) => {
    const result = await account.verify(email, code);
    if (result.ok) onSignedIn();
    return result;
  };
  return <ButlerAccountSignInDialog open onOpenChange={(open) => { if (!open) onCancel(); }} account={{ ...account, verify }} />;
}
