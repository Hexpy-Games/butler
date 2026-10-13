import type { ShowcaseGuidance } from "../../showcase";
import { IconButton } from "../../components/IconButton";
import { Globe2 } from "../../components/Icons";
import { ActivityGlow, activityGlowTone } from "./ActivityGlow";

// #region recipe: Browser toggle while Butler browses
function BrowserToggle() {
  const state = "busy";
  return (
    <ActivityGlow state={state}>
      <IconButton label="View browser · Butler is using it" tone={activityGlowTone(state)} onClick={() => undefined}>
        <Globe2 size="md" />
      </IconButton>
    </ActivityGlow>
  );
}
// #endregion

// #region recipe: Needs you
function NeedsYouToggle() {
  return (
    <ActivityGlow state="attention">
      <IconButton label="View browser · Needs you" onClick={() => undefined}><Globe2 size="md" /></IconButton>
    </ActivityGlow>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A halo and a status dot around an IconButton that tell what Butler is doing with the surface the button opens, without opening it.",
  whenToUse: [
    "The titlebar browser toggle while Butler browses in the background: busy, needs you, error",
    "Another titlebar toggle whose hidden surface has live Butler activity",
  ],
  whenNotToUse: [
    { when: "A count of unread items on a button", use: "IconButton" },
    { when: "Running work above the composer", use: "StatusCapsule" },
    { when: "A tab's own working or waiting state", use: "LiveTabCard" },
  ],
  recipes: [
    { name: "Browser toggle while Butler browses", description: "Pair the state with activityGlowTone so busy strokes the icon in the riso inks.", render: () => <BrowserToggle /> },
    { name: "Needs you", description: "Amber halo (two pulses on entry, then still) and an amber dot; the label names the state.", render: () => <NeedsYouToggle /> },
  ],
  doDont: [
    {
      do: { caption: "Wrap the button and say the state in its label.", render: () => <NeedsYouToggle /> },
      dont: { caption: "A bare indicator dot says only that something happens, never that the user is needed.", render: () => (
        <IconButton label="View browser" indicator onClick={() => undefined}><Globe2 size="md" /></IconButton>
      ) },
    },
  ],
  content: [
    "The label is the action plus the state: View browser · Butler is using it / 브라우저 보기 · 버틀러가 사용 중 (butler-i18n browser.glow).",
    "Pass idle while the surface is open: the open toggle uses tone butler and pressed, no halo.",
    "Priority when several apply: attention, then busy, then error, then idle.",
  ],
  accessibility: [
    "The halo and dot are aria-hidden; the IconButton label carries the state.",
    "Announce the change to attention once through the app's status region, not on every render.",
    "Reduced motion (OS, app or viewer scope) renders dots only: the riso dot for busy, amber for attention, red for error.",
  ],
  tokens: [
    "--activity-glow-spin-duration", "--activity-glow-breathe-duration", "--activity-glow-nudge-duration",
    "--butler-ink-blue", "--butler-ink-purple", "--butler-ink-pink", "--color-warning", "--color-danger", "--motion-loop-count",
  ],
};
