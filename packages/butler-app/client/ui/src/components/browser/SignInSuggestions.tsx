import { useEffect, useState } from "react";
import { desktopViewportScope, Key, Popover, PopoverAnchor, PopoverContent, SuggestionItemRow, SuggestionList, Typo } from "@/butler-ds";
import { getAppCopy, type AppLocale } from "../../../../../../butler-i18n/src/index";

type Frame = { locale: AppLocale; dark: boolean; accounts: { id: string; username: string }[]; active: number; error: boolean };
declare global { interface Window { butlerSignInSuggest?: {
  subscribe: (handler: (frame: Frame) => void) => () => void;
  pick: (entryId: string) => void;
  size: (height: number) => void;
  outside: (x: number, y: number) => void;
} } }

/** Room for the popover shadow (it falls down and out); main places this view with the same margins. */
const MARGIN = { top: 4, side: 36, bottom: 48 };
// This view is a narrow desktop surface, not a phone: the popover must not take its sheet layout.
// It portals to <body>, so the scope goes on the document root.
for (const [name, value] of Object.entries(desktopViewportScope)) document.documentElement.setAttribute(name, value);
const anchor = { current: { getBoundingClientRect: () => DOMRect.fromRect({ x: MARGIN.side, y: MARGIN.top, width: innerWidth - 2 * MARGIN.side, height: 0 }) } };

/** Saved sign-ins under the focused login field, drawn in their own view above the page. */
export function SignInSuggestions() {
  const [frame, setFrame] = useState<Frame>();
  useEffect(() => window.butlerSignInSuggest?.subscribe(next => {
    document.documentElement.lang = next.locale; setFrame(next);
  }), []);
  const [box, setBox] = useState<HTMLElement | null>(null);
  // The popover caps itself to this view, which main sizes from this report: measure the full content,
  // and watch the list, whose rows change with the frame.
  useEffect(() => {
    const list = box?.querySelector('[data-slot="suggestion-list"]');
    if (!box || !list) return;
    const observer = new ResizeObserver(() => window.butlerSignInSuggest?.size(box.scrollHeight + MARGIN.top + MARGIN.bottom));
    observer.observe(list);
    return () => observer.disconnect();
  }, [box]);
  // The shadow margin is page, not list: a press there closes the list and goes to the page.
  useEffect(() => {
    const down = (event: PointerEvent) => {
      if (!(event.target as Element).closest('[data-slot="popover-content"]')) window.butlerSignInSuggest?.outside(event.clientX, event.clientY);
    };
    addEventListener("pointerdown", down, true);
    return () => removeEventListener("pointerdown", down, true);
  }, []);
  if (!frame) return null;
  const copy = getAppCopy(frame.locale).browser;
  return <Popover open><PopoverAnchor virtualRef={anchor} />
    <PopoverContent ref={setBox} theme={{ appearance: frame.dark ? "dark" : "light" }} align="start" width="anchor" density="list" sideOffset={0} avoidCollisions={false}
      onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}>
      <SuggestionList id="signin-suggest" label={copy.savedSignIn}>
        {frame.error ? <Typo.Label tone="tertiary">{copy.signinFillFailed}</Typo.Label> : frame.accounts.map((account, index) =>
          <SuggestionItemRow key={account.id} id={`signin-suggest-${index}`} icon={<Key size="md" />} title={account.username}
            active={index === frame.active} onSelect={() => window.butlerSignInSuggest?.pick(account.id)} />)}
      </SuggestionList>
    </PopoverContent>
  </Popover>;
}
