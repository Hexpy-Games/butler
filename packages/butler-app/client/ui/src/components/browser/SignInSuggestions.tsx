import { useEffect, useLayoutEffect, useState } from "react";
import { Key, SuggestionItemRow, SuggestionList, Typo } from "@/butler-ds";
import { getAppCopy, type AppLocale } from "../../../../../../butler-i18n/src/index";

type Frame = { locale: AppLocale; accounts: { id: string; username: string }[]; active: number; error: boolean };
declare global { interface Window { butlerSignInSuggest?: {
  subscribe: (handler: (frame: Frame) => void) => () => void;
  pick: (entryId: string) => void;
  size: (height: number) => void;
} } }

export function SignInSuggestions() {
  const [frame, setFrame] = useState<Frame>();
  useEffect(() => window.butlerSignInSuggest?.subscribe(next => {
    document.documentElement.lang = next.locale; setFrame(next);
  }), []);
  useLayoutEffect(() => {
    const box = document.querySelector('[data-slot="suggestion-list"]')?.getBoundingClientRect();
    if (box) window.butlerSignInSuggest?.size(box.height);
  }, [frame]);
  if (!frame) return null;
  const copy = getAppCopy(frame.locale).browser;
  return <SuggestionList id="signin-suggest" label={copy.savedSignIn}>
    {frame.error ? <Typo.Label tone="tertiary">{copy.signinFillFailed}</Typo.Label> : frame.accounts.map((account, index) =>
      <SuggestionItemRow key={account.id} id={`signin-suggest-${index}`} icon={<Key size="md" />} title={account.username}
        meta={copy.savedSignIn} active={index === frame.active} onSelect={() => window.butlerSignInSuggest?.pick(account.id)} />)}
  </SuggestionList>;
}
