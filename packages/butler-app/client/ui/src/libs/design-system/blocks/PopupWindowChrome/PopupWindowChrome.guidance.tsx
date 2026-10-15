import type { ShowcaseGuidance } from "../../showcase";
import { Box } from "../../components/Box";
import { Typo } from "../../components/Typo";
import { PopupWindowChrome } from "./PopupWindowChrome";

// #region recipe: Sign-in pop-up
function SignInPopup() {
  return (
    <div style={{ width: 320, height: 200 }}>
      <PopupWindowChrome host="id.example.com" securityLabel="Secure connection" platform="win32">
        <Box padding="lg"><Typo.Body>Sign in to continue</Typo.Body></Box>
      </PopupWindowChrome>
    </div>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The whole document of a Butler-owned pop-up window: a compact 40px bar with the native controls, lock and host over the page.",
  whenToUse: ["A pop-up a page opens on a click (sign-in, payment), kept with its opener"],
  whenNotToUse: [
    { when: "The main window's title bar", use: "TitlebarShell" },
    { when: "A page dialog (confirm, HTTP sign-in)", use: "Dialog" },
  ],
  recipes: [{ name: "Sign-in pop-up", description: "On macOS the bar reserves the traffic lights; elsewhere windowControls sit at the end.", render: () => <SignInPopup /> }],
  doDont: [
    {
      do: { caption: "Title the window by its origin, with the lock.", render: () => <SignInPopup /> },
      dont: { caption: "The page's own title can claim to be anything (a bank, Butler).", render: () => <Typo.AppTitle>Butler — Secure sign-in</Typo.AppTitle> },
    },
  ],
  content: ["The host only (id.example.com); never the page title."],
  accessibility: ["The lock or warning glyph carries “Secure connection” / “Not secure”.", "The bar is a window drag region; controls inside it stay clickable."],
  tokens: ["--browser-band-height", "--chrome-toggle-inset", "--chrome-floating-toggle-size", "--chrome-floating-toggle-icon-size", "--popover", "--radius-panel", "--text-tertiary"],
};
